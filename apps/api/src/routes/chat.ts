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
import { imagePayloadFromResult, storeMcpImage } from "../services/mcp-images";
import {
  finishPipelineRun,
  getPipelineState,
  stepPipeline,
  startPipelineRun,
} from "../services/pipeline";
import { runAgentLoop } from "@xtiand/mjane-core";
import type { ChatMessage, ToolCallDto } from "@xtiand/shared";

export const chatRouter = Router();

chatRouter.get("/pipeline", (_req, res): void => {
  res.json(getPipelineState());
});

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

  const mcpClients: import("@xtiand/mcp-bridge").McpClientLike[] = [];
  let runId = 0;
  const seenArtifacts = new Set<number>();
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

    runId = startPipelineRun({
      conversationId: id,
      prompt: content,
      output,
      provider: provider.providerId > 0 ? String(provider.providerId) : "?",
      model: provider.model,
    });

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
          params: [],
          run: async (
            args: Record<string, unknown>,
            ctx: import("@xtiand/mjane-core").ToolContext,
          ) => {
            const result = await client.call(tool.name, JSON.stringify(args ?? {}));
            let image = imagePayloadFromResult(result, ctx.workspaceDir);
            if (image) {
              try {
                const saved = await storeMcpImage(image, ctx, result);
                ctx.emit({
                  type: "artifact",
                  data: { id: saved.id, filename: saved.filename, mime: saved.mime, kind: "image" },
                });
                return `${result}\n\nARTIFACT:${saved.id}`;
              } catch {
                image = null;
              }
            }
            return result;
          },
        });
      }
    }

    const history = await loadHistory(id);
    const mcpImageTools = mcpClients
      .flatMap((c) => [...c.tools.values()])
      .filter(
        (t) =>
          /image|img|photo|picture/.test(t.name) || /image|img|photo|visual/.test(t.description),
      )
      .map((t) => `mcp_${t.name}`);
    const systemPrompt = await buildSystemPrompt(id, content, mode, output, mcpImageTools);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(0, -1),
      {
        role: "user",
        content,
        images: images.length > 0 ? images : undefined,
      },
    ];

    const record = (event: { type: string; data: unknown }): void => {
      send("agent", event);
      if (!runId) return;
      try {
        const t = event.type;
        if (t === "status" || t === "token") return;
        const d = event.data as Record<string, unknown> | undefined;
        if (t === "tool-start") {
          const tool = String(d?.["name"] ?? "tool");
          stepPipeline(runId, {
            conversationId: id,
            stage: "act",
            kind: "tool-start",
            label: tool,
            detail: String(d?.["argsJson"] ?? "").slice(0, 220),
            tool,
            running: true,
          });
        } else if (t === "tool-end") {
          const tool = String(d?.["name"] ?? "tool");
          stepPipeline(runId, {
            conversationId: id,
            stage: "act",
            kind: "tool-end",
            label: tool,
            detail: String(d?.["result"] ?? "").slice(0, 260),
            tool,
            running: false,
          });
        } else if (t === "artifact") {
          const a = d as { id?: number; filename?: string; mime?: string; kind?: string } | undefined;
          if (a?.id != null) {
            if (seenArtifacts.has(a.id)) return;
            seenArtifacts.add(a.id);
          }
          stepPipeline(runId, {
            conversationId: id,
            stage: "output",
            kind: "artifact",
            label: a?.kind === "image" ? `Image #${a?.id}` : `Artifact #${a?.id}`,
            detail: a?.filename ?? "",
            artifactId: a?.id ?? null,
            mime: a?.mime ?? null,
            filename: a?.filename ?? null,
            running: false,
          });
        } else if (t === "message") {
          stepPipeline(runId, {
            conversationId: id,
            stage: "synthesize",
            kind: "message",
            label: "Synthesize",
            detail: String(d ?? "").slice(0, 300),
            running: false,
          });
        } else if (t === "delegate") {
          const g = d as { agentName?: string; task?: string } | undefined;
          stepPipeline(runId, {
            conversationId: id,
            stage: "act",
            kind: "delegate",
            label: `delegate → ${g?.agentName ?? "agent"}`,
            detail: String(g?.task ?? "").slice(0, 200),
            tool: "delegate",
            running: true,
          });
        } else if (t === "error") {
          stepPipeline(runId, {
            conversationId: id,
            stage: "error",
            kind: "error",
            label: "Error",
            detail: String(d ?? "").slice(0, 300),
            running: false,
          });
        } else if (t === "attached-images") {
          const count = (d as { count?: number } | undefined)?.["count"] ?? 0;
          stepPipeline(runId, {
            conversationId: id,
            stage: "act",
            kind: "tool-end",
            label: "vision",
            detail: `${count} image(s) attached to model`,
            tool: "image_read",
            running: false,
          });
        }
      } catch {
        /* pipeline recording must never block the run */
      }
    };

    const result = await runAgentLoop({
      messages,
      maxTurns: mode === "chat" ? 10 : 16,
      maxToolCalls: mode === "build" ? 40 : 24,
      registry,
      ctx: {
        vaultPath: env.vaultPath,
        workspaceDir: env.workspaceDir,
        conversationId: id,
        emit: (event) => record(event),
      },
      provider,
      onStep: (step) => record(step),
      onToken: () => undefined,
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
    if (runId) finishPipelineRun(runId, "done");
  } catch (error: unknown) {
    send("agent", {
      type: "error",
      data: error instanceof Error ? error.message : String(error),
    });
    send("done", { ok: false });
    if (runId) finishPipelineRun(runId, "error");
  } finally {
    for (const client of mcpClients) client.dispose();
    res.end();
  }
});
