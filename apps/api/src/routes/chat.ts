import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import {
  buildRegistry,
  buildSystemPrompt,
  connectEnabledMcpServers,
  loadHistory,
  resolveProvider,
} from "../services/agent-service";
import { env } from "../lib/env";
import { indexConversation } from "../services/memory";
import { runAgentLoop } from "@xtiand/mjane-core";
import type { ChatMessage, ToolCallDto } from "@xtiand/shared";

export const chatRouter = Router();

chatRouter.get("/", async (_req, res): Promise<void> => {
  const rows = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  });
  res.json(rows);
});

chatRouter.post("/", async (_req, res): Promise<void> => {
  const conversation = await prisma.conversation.create({ data: {} });
  res.json(conversation);
});

chatRouter.get("/:id/messages", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { id: "asc" },
  });
  res.json(
    rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      toolCalls:
        row.toolCallsJson !== null ? (JSON.parse(row.toolCallsJson) as ToolCallDto[]) : [],
      createdAt: row.createdAt.toISOString(),
    })),
  );
});

chatRouter.delete("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.conversation.delete({ where: { id } }).catch(() => undefined);
  await audit("chat:delete", `conversation ${id}`);
  res.json({ ok: true });
});

/** POST /api/chat/:id/stream — SSE agent run. */
chatRouter.post("/:id/stream", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const content = typeof req.body?.["content"] === "string" ? req.body["content"] : "";
  const modeRaw = String(req.body?.["mode"] ?? "chat");
  const mode: "chat" | "plan" | "build" =
    modeRaw === "plan" || modeRaw === "build" ? modeRaw : "chat";
  const outputRaw = String(req.body?.["output"] ?? "text");
  const output: "text" | "image" | "animation" | "data" =
    ["image", "animation", "data"].includes(outputRaw)
      ? (outputRaw as "image" | "animation" | "data")
      : "text";
  const images = Array.isArray(req.body?.["images"])
    ? (req.body["images"] as unknown[]).filter((i): i is string => typeof i === "string").slice(0, 4)
    : [];
  if (Number.isNaN(id) || content.trim().length === 0) {
    res.status(400).json({ error: "conversation id and content required" });
    return;
  }

  await prisma.message.create({ data: { conversationId: id, role: "user", content } });

  const mcpClients: { dispose(): void }[] = [];
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const provider = await resolveProvider(
      typeof req.body?.["model"] === "string" ? req.body["model"] : null,
    );

    const userMsgCount = await prisma.message.count({ where: { conversationId: id } });
    if (userMsgCount <= 1) {
      await prisma.conversation.update({
        where: { id },
        data: { title: content.slice(0, 60) },
      });
    }

    const registry = await buildRegistry(id);
    const clients = await connectEnabledMcpServers();
    mcpClients.push(...clients);
    for (const client of clients) {
      for (const tool of client.tools.values()) {
        registry.register({
          name: `mcp_${tool.name}`,
          description: `[MCP] ${tool.description}`,
          scopes: ["net"],
          params: [{ name: "argsJson", type: "string", description: "JSON args for the MCP tool", required: false }],
          run: async (args: Record<string, unknown>) =>
            client.call(tool.name, String(args["argsJson"] ?? "{}")),
        });
      }
    }

    const history = await loadHistory(id);
    const systemPrompt = await buildSystemPrompt(id, content, mode, output);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(0, -1),
      {
        role: "user",
        content,
        images: images.length > 0 ? images : undefined,
      },
    ];

    const result = await runAgentLoop({
      messages,
      maxTurns: mode === "chat" ? 10 : 16,
      maxToolCalls: mode === "build" ? 40 : 24,
      registry,
      ctx: {
        vaultPath: env.vaultPath,
        workspaceDir: env.workspaceDir,
        conversationId: id,
        emit: () => undefined,
      },
      provider,
      onStep: (step) => send("agent", step),
    });

    const finalAssistant = [...result.messages].reverse().find((m) => m.role === "assistant");
    await prisma.message.create({
      data: {
        conversationId: id,
        role: "assistant",
        content: finalAssistant?.content ?? "",
        toolCallsJson:
          finalAssistant?.toolCalls && finalAssistant.toolCalls.length > 0
            ? JSON.stringify(finalAssistant.toolCalls)
            : null,
      },
    });
    // long-term memory: index this exchange so future chats can recall it
    try {
      const turns = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { id: "asc" },
        select: { role: true, content: true },
      });
      await indexConversation(id, turns.slice(-20));
    } catch (memoryError: unknown) {
      console.error("conversation indexing failed:", memoryError);
    }

    send("done", { ok: true });
  } catch (error: unknown) {
    send("agent", {
      type: "error",
      data: error instanceof Error ? error.message : String(error),
    });
    send("done", { ok: false });
  } finally {
    for (const client of mcpClients) client.dispose();
    res.end();
  }
});
