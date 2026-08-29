/**
 * Quality, feedback and critic-config endpoints.
 *
 * /api/feedback        — submit thumbs up/down + note (downvotes re-trigger the
 *                        critic's analysis post-hoc and land in the review queue)
 * /api/quality/...     — speed & quality dashboard aggregates over RunRecord
 * /api/settings        — generic GET/PUT scoped to the qa.* setting keys
 */

import { Router } from "express";

import { audit } from "../lib/auth";
import { prisma } from "../lib/db";
import { rateLimit } from "../lib/guard";
import {
  gradeAnswer,
  resolveJudgeProvider,
  type MemorySnippet,
} from "../services/critic";
import { searchMemory } from "../services/memory";
import { aggregateRuns, parseFlags } from "../services/run-record";
import { activeEmbedder } from "../services/embedding";
import { env } from "../lib/env";

export const qualityRouter = Router();

qualityRouter.use(rateLimit(60_000, 60, "quality"));

const QA_SETTING_KEYS = ["qa.criticEnabled", "qa.threshold", "qa.maxRevisions", "qa.judgeModel"] as const;
const QA_DEFAULTS: Record<string, string> = {
  "qa.criticEnabled": "1",
  "qa.threshold": "60",
  "qa.maxRevisions": "2",
  "qa.judgeModel": "",
};

/** Async post-hoc re-analysis after a downvote. Never blocks the response. */
async function regradeMessage(messageId: number): Promise<void> {
  try {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: { include: { messages: { orderBy: { id: "asc" }, take: 8 } } },
      },
    });
    if (!message || message.role !== "assistant") return;
    const question =
      [...message.conversation.messages].reverse().find((m) => m.role === "user")?.content ??
      message.conversation.messages[0]?.content ??
      "";
    const memories: MemorySnippet[] = (await searchMemory(question || message.content, { limit: 5 })).map(
      (hit) => ({ path: hit.path, content: hit.content }),
    );
    const provider = await resolveJudgeProvider();
    const grade = await gradeAnswer({
      provider,
      question,
      answer: message.content,
      memories,
    });
    if (grade.score !== null || grade.flags.length > 0) {
      await prisma.message.update({
        where: { id: messageId },
        data: {
          qualityScore: grade.score,
          qualityFlags:
            grade.flags.length > 0
              ? JSON.stringify([...grade.flags, "user_downvote"])
              : JSON.stringify(["user_downvote"]),
          grounded: grade.grounded,
        },
      });
      await audit("quality:regrade", `message ${messageId} score ${grade.score} flags ${grade.flags.join(",")}`);
    }
  } catch (error: unknown) {
    console.error("feedback regrade failed:", error);
  }
}

qualityRouter.post("/feedback", async (req, res): Promise<void> => {
  const messageId = Number.parseInt(String(req.body?.["messageId"]), 10);
  const vote = Number.parseInt(String(req.body?.["vote"]), 10);
  const note = typeof req.body?.["note"] === "string" ? req.body["note"].slice(0, 500).trim() : "";
  if (Number.isNaN(messageId) || (vote !== 1 && vote !== -1)) {
    res.status(400).json({ error: "messageId and vote (1|-1) required" });
    return;
  }
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.role !== "assistant") {
    res.status(404).json({ error: "assistant message not found" });
    return;
  }
  await prisma.messageFeedback.upsert({
    where: { messageId },
    update: { vote, note: note.length > 0 ? note : null },
    create: { messageId, vote, note: note.length > 0 ? note : null },
  });
  await audit("feedback", `message ${messageId} ${vote > 0 ? "up" : "down"}${note ? ` — ${note}` : ""}`);
  if (vote < 0) void regradeMessage(messageId);
  res.json({ ok: true, regrade: vote < 0 });
});

qualityRouter.get("/feedback", async (_req, res): Promise<void> => {
  const rows = await prisma.messageFeedback.findMany({
    orderBy: { id: "desc" },
    take: 50,
    include: { message: { include: { conversation: { select: { title: true } } } } },
  });
  res.json(
    rows.map((r) => ({
      id: r.id,
      messageId: r.messageId,
      vote: r.vote,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      content: r.message.content.slice(0, 400),
      conversationTitle: r.message.conversation.title,
      qualityScore: r.message.qualityScore,
      qualityFlags: r.message.qualityFlags !== null ? parseFlags(r.message.qualityFlags) : [],
    })),
  );
});

qualityRouter.get("/runs", async (req, res): Promise<void> => {
  const take = Number.parseInt(String(req.query["limit"] ?? "50"), 10);
  const rows = await prisma.runRecord.findMany({
    orderBy: { id: "desc" },
    take: Math.min(Math.max(take, 1), 200),
  });
  const aggregate = aggregateRuns(rows);
  res.json({
    aggregate,
    runs: rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      conversationId: r.conversationId,
      prompt: r.prompt,
      provider: r.provider,
      model: r.model,
      mode: r.mode,
      outputKind: r.outputKind,
      latencyMs: r.latencyMs,
      tokensEstimated: r.tokensEstimated,
      modelCalls: r.modelCalls,
      totalArtifacts: r.totalArtifacts,
      grounded: r.grounded,
      qualityScore: r.qualityScore,
      qualityFlags: r.qualityFlags !== null ? parseFlags(r.qualityFlags) : [],
      revisions: r.revisions,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

qualityRouter.get("/summary", async (_req, res): Promise<void> => {
  const [runs, feedback, recentLow] = await Promise.all([
    prisma.runRecord.findMany({ orderBy: { id: "desc" }, take: 300 }),
    prisma.messageFeedback.findMany({ orderBy: { id: "desc" }, take: 100 }),
    prisma.message.findMany({
      where: { role: "assistant", qualityScore: { lt: 60 } },
      orderBy: { id: "desc" },
      take: 10,
      select: {
        id: true,
        content: true,
        qualityScore: true,
        qualityFlags: true,
        qualityRevisions: true,
        grounded: true,
        latencyMs: true,
        conversationId: true,
        conversation: { select: { title: true } },
      },
    }),
  ]);
  const aggregate = aggregateRuns(runs);
  res.json({
    aggregate,
    feedback: {
      total: feedback.length,
      ups: feedback.filter((f) => f.vote > 0).length,
      downs: feedback.filter((f) => f.vote < 0).length,
    },
    recentLow: recentLow.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      title: m.conversation.title,
      content: m.content.slice(0, 200),
      qualityScore: m.qualityScore,
      qualityFlags: m.qualityFlags !== null ? parseFlags(m.qualityFlags) : [],
      qualityRevisions: m.qualityRevisions,
      grounded: m.grounded,
      latencyMs: m.latencyMs,
    })),
  });
});

qualityRouter.get("/settings", async (_req, res): Promise<void> => {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...QA_SETTING_KEYS] } } });
  const values: Record<string, string> = { ...QA_DEFAULTS };
  for (const row of rows) values[row.key] = row.value as string;
  const embedder = activeEmbedder();
  res.json({
    settings: QA_SETTING_KEYS.map((key) => ({ key, value: values[key] })),
    defaults: QA_DEFAULTS,
    judgeModel: values["qa.judgeModel"] || env.judgeModel || null,
    embeddings: {
      mode: embedder.dim === 256 ? "feature-hash" : "provider",
      model: embedder.name,
      configured: env.embeddingsBaseUrl.length > 0 && env.embeddingsApiKey.length > 0,
    },
  });
});

qualityRouter.put("/settings", async (req, res): Promise<void> => {
  const key = typeof req.body?.["key"] === "string" ? req.body["key"] : "";
  const value = typeof req.body?.["value"] === "string" ? req.body["value"] : null;
  if (!(QA_SETTING_KEYS as readonly string[]).includes(key) || value === null) {
    res.status(400).json({ error: "unknown or invalid qa.* setting" });
    return;
  }
  if (key === "qa.threshold") {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 0 || n > 100) {
      res.status(400).json({ error: "threshold must be 0-100" });
      return;
    }
  }
  if (key === "qa.maxRevisions") {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 0 || n > 3) {
      res.status(400).json({ error: "maxRevisions must be 0-3" });
      return;
    }
  }
  if (key === "qa.criticEnabled" && value !== "0" && value !== "1") {
    res.status(400).json({ error: "criticEnabled must be 0 or 1" });
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  await audit("quality:settings", `${key}=${value.slice(0, 100)}`);
  res.json({ ok: true });
});