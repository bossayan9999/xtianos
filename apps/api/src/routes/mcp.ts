import { Router } from "express";
import path from "node:path";

import type { McpResourceInfo, McpPromptInfo } from "@xtiand/shared";
import { createMcpClient } from "@xtiand/mcp-bridge";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { env } from "../lib/env";
import { searchMemory } from "../services/memory";
import { readMcpConfigFile, syncMcpConfigFromFile } from "../services/mcp-config";

export const mcpRouter = Router();
export const memoryRouter = Router();

mcpRouter.get("/servers", async (_req, res): Promise<void> => {
  res.json(await prisma.mcpServer.findMany({ orderBy: { id: "asc" } }));
});

mcpRouter.post("/servers", async (req, res): Promise<void> => {
  const name = typeof req.body?.["name"] === "string" ? req.body["name"].trim() : "";
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const transport = ["stdio", "http", "sse"].includes(String(req.body?.["transport"] ?? "stdio"))
    ? (String(req.body?.["transport"] ?? "stdio") as "stdio" | "http" | "sse")
    : "stdio";
  const command = typeof req.body?.["command"] === "string" ? req.body["command"].trim() : "";
  const url = typeof req.body?.["url"] === "string" ? req.body["url"].trim() : "";
  if (transport === "stdio" && !command) {
    res.status(400).json({ error: "stdio servers require a command" });
    return;
  }
  if (transport !== "stdio" && !url) {
    res.status(400).json({ error: "http/sse servers require a url" });
    return;
  }
  const server = await prisma.mcpServer.create({
    data: {
      name,
      transport,
      command,
      args: typeof req.body?.["args"] === "string" ? req.body["args"] : "",
      envJson: typeof req.body?.["envJson"] === "string" ? req.body["envJson"] : "{}",
      url,
      headersJson: typeof req.body?.["headersJson"] === "string" ? req.body["headersJson"] : "{}",
      enabled: Boolean(req.body?.["enabled"]),
    },
  });
  res.json(server);
});

mcpRouter.patch("/servers/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id) || typeof req.body?.["enabled"] !== "boolean") {
    res.status(400).json({ error: "id and enabled required" });
    return;
  }
  await audit("mcp:toggle", `server ${id} → ${req.body["enabled"]}`);
  const server = await prisma.mcpServer
    .update({ where: { id }, data: { enabled: req.body["enabled"] as boolean } })
    .catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(server);
});

mcpRouter.delete("/servers/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.mcpServer.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

function specFor(server: {
  transport: string;
  command: string;
  args: string;
  envJson: string;
  url: string;
  headersJson: string;
}) {
  return {
    transport: (["http", "sse"].includes(server.transport) ? server.transport : "stdio") as
      | "stdio"
      | "http"
      | "sse",
    command: server.command,
    args: server.args.split(/\s+/).filter(Boolean),
    envJson: server.envJson,
    url: server.url,
    headersJson: server.headersJson,
  };
}

mcpRouter.post("/servers/:id/probe", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const client = createMcpClient(specFor(server));
  try {
    const tools = await client.connect(specFor(server));
    const resources = server.transport === "stdio" ? [] : await client.listResources().catch(() => []);
    const prompts = server.transport === "stdio" ? [] : await client.listPrompts().catch(() => []);
    res.json({
      ok: true,
      tools,
      resources,
      prompts,
      sampleResource:
        resources.length > 0 ? await client.readResource(resources[0].uri).catch(() => "") : "",
      transport: server.transport,
    });
  } catch (error: unknown) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.dispose();
  }
});

mcpRouter.post("/servers/:id/connect-check", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const client = createMcpClient(specFor(server));
  try {
    await client.connect(specFor(server));
    res.json({ ok: true, transport: server.transport, message: "Connection successful" });
  } catch (error: unknown) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      message: "Connection failed",
    });
  } finally {
    client.dispose();
  }
});

/** List resources from an enabled server. */
mcpRouter.get("/servers/:id/resources", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const client = createMcpClient(specFor(server));
  try {
    await client.connect(specFor(server));
    const resources: McpResourceInfo[] = await client.listResources();
    res.json(resources);
  } catch (error: unknown) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    client.dispose();
  }
});

/** Read a resource from an enabled server. */
mcpRouter.post("/servers/:id/read-resource", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const uri = typeof req.body?.["uri"] === "string" ? req.body["uri"] : "";
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!uri) {
    res.status(400).json({ error: "uri required" });
    return;
  }
  const client = createMcpClient(specFor(server));
  try {
    await client.connect(specFor(server));
    const text = await client.readResource(uri);
    res.json({ text });
  } catch (error: unknown) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    client.dispose();
  }
});

/** List prompts from an enabled server. */
mcpRouter.get("/servers/:id/prompts", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const client = createMcpClient(specFor(server));
  try {
    await client.connect(specFor(server));
    const prompts: McpPromptInfo[] = await client.listPrompts();
    res.json(prompts);
  } catch (error: unknown) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    client.dispose();
  }
});

/** Get a prompt from an enabled server. */
mcpRouter.post("/servers/:id/get-prompt", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const name = typeof req.body?.["name"] === "string" ? req.body["name"] : "";
  const argsJson = typeof req.body?.["argsJson"] === "string" ? req.body["argsJson"] : "{}";
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const client = createMcpClient(specFor(server));
  try {
    await client.connect(specFor(server));
    const text = await client.getPrompt(name, argsJson);
    res.json({ name, text });
  } catch (error: unknown) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    client.dispose();
  }
});

/** Sync servers listed in mcp.json (workspace dir + monorepo root). */
mcpRouter.post("/sync-config", async (_req, res): Promise<void> => {
  try {
    const roots = [
      env.workspaceDir,
      path.resolve(__dirname, "../../../../"), // monorepo root (apps/api/src/routes → root)
    ];
    const results = [];
    for (const root of roots) {
      results.push({ root, ...(await syncMcpConfigFromFile(root)) });
    }
    res.json({ ok: true, results });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Fetch the raw mcp.json content (for the UI). */
mcpRouter.get("/config", async (_req, res): Promise<void> => {
  const config = await readMcpConfigFile(env.workspaceDir);
  res.json(config);
});

memoryRouter.get("/search", async (req, res): Promise<void> => {
  const q = typeof req.query["q"] === "string" ? req.query["q"] : "";
  if (q.trim().length === 0) {
    res.json([]);
    return;
  }
  res.json(await searchMemory(q, { limit: 10 }));
});
