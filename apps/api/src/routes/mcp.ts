import { Router } from "express";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { McpStdioClient } from "@xtiand/mcp-bridge";
import { searchMemory } from "../services/memory";

export const mcpRouter = Router();
export const memoryRouter = Router();

mcpRouter.get("/servers", async (_req, res): Promise<void> => {
  res.json(await prisma.mcpServer.findMany({ orderBy: { id: "asc" } }));
});

mcpRouter.post("/servers", async (req, res): Promise<void> => {
  const name = typeof req.body?.["name"] === "string" ? req.body["name"].trim() : "";
  const command = typeof req.body?.["command"] === "string" ? req.body["command"].trim() : "";
  if (!name || !command) {
    res.status(400).json({ error: "name and command required" });
    return;
  }
  const server = await prisma.mcpServer.create({
    data: {
      name,
      command,
      args: typeof req.body?.["args"] === "string" ? req.body["args"] : "",
      envJson: typeof req.body?.["envJson"] === "string" ? req.body["envJson"] : "{}",
      enabled: false,
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

/** Probe an enabled server: connect + list its tools. */
mcpRouter.post("/servers/:id/probe", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const server = await prisma.mcpServer.findUnique({ where: { id } }).catch(() => null);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const client = new McpStdioClient();
  try {
    const tools = await client.connect(
      server.command,
      server.args.split(/\s+/).filter(Boolean),
      server.envJson,
    );
    res.json({ ok: true, tools });
  } catch (error: unknown) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.dispose();
  }
});

memoryRouter.get("/search", async (req, res): Promise<void> => {
  const q = typeof req.query["q"] === "string" ? req.query["q"] : "";
  if (q.trim().length === 0) {
    res.json([]);
    return;
  }
  res.json(await searchMemory(q, { limit: 10 }));
});
