/**
 * LLM-critic quality subsystem.
 *
 * A dedicated judge model (configured via Settings → qa.judgeModel, or the
 * JUDGE_MODEL env var; falls back to the default chat provider) reviews every
 * assistant answer against the retrieved memory context. It produces a 0-100
 * score, a grounded verdict and a small set of flags. When the score drops
 * below the configurable threshold, the answer can be revised up to
 * maxRevisions times with the reviewer feedback fed back in.
 */

import { providerChat } from "@xtiand/mjane-core";

import { prisma } from "../lib/db";
import { resolveProvider, type ResolvedProvider } from "../services/agent-service";
import { env } from "../lib/env";

export const ALLOWED_FLAGS = [
  "grounded",
  "not_grounded",
  "concise",
  "vague",
  "incomplete",
  "hallucination_risk",
  "unsupported_claims",
  "unhelpful",
  "off_topic",
] as const;

export type QualityFlag = (typeof ALLOWED_FLAGS)[number];

export interface Grade {
  score: number | null;
  grounded: boolean;
  flags: QualityFlag[];
  verdict: string;
  raw: string;
}

export interface MemorySnippet {
  path: string | null;
  content: string;
}

const ALLOWED_FLAG_TEXT = ALLOWED_FLAGS.map((f) => `"${f}"`).join(", ");

const JUDGE_SYSTEM = `You are the quality critic for mjane, an agentic copilot on xtiandOS.
You review the assistant's answer given the user's question and the memory/context available to the assistant.
Rubric (100-point scale):
- 90-100: accurate, fully grounded in provided context, complete, helpful, well structured.
- 70-89: solid answer, mostly grounded, minor gaps.
- 50-69: partial or vague; some claims unsupported; missing key parts.
- 0-49: unhelpful, off-topic, or makes claims contradicted by / absent from the provided context.
Apply the "not_grounded"/"hallucination_risk"/"unsupported_claims" flags ONLY when the answer introduces material claims that cannot be supported by the provided context.
Reply with ONLY a JSON object, no prose, of exactly this shape:
{"score":<int 0-100>,"grounded":<true|false>,"flags":[subset of ${ALLOWED_FLAG_TEXT}],"verdict":"one sentence for the author"}`;

/** Extract the first JSON object from a model reply, tolerating code fences. */
export function parseJudgeJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    /* fall through to brace extraction */
  }
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** Strictly validate a parsed judge object into a Grade. */
function normalizeGrade(parsed: Record<string, unknown>, raw: string): Grade {
  const scoreRaw = parsed["score"];
  let score: number | null = null;
  if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw)) {
    score = Math.max(0, Math.min(100, Math.round(scoreRaw)));
  } else if (typeof scoreRaw === "string") {
    const n = Number.parseInt(scoreRaw, 10);
    if (Number.isFinite(n)) score = Math.max(0, Math.min(100, n));
  }
  const flags = Array.isArray(parsed["flags"])
    ? (parsed["flags"] as unknown[])
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim())
        .filter((f): f is QualityFlag => (ALLOWED_FLAGS as readonly string[]).includes(f))
        .slice(0, 6)
    : [];
  return {
    score,
    grounded: Boolean(parsed["grounded"]),
    flags,
    verdict: typeof parsed["verdict"] === "string" ? parsed["verdict"].slice(0, 300) : "",
    raw,
  };
}

function memoryBlock(memories: MemorySnippet[]): string {
  if (memories.length === 0) return "[no memory context was provided]";
  return memories
    .map((m) => `- [${m.path ?? "memory"}] ${m.content.slice(0, 500).replace(/\n/g, " ")}`)
    .join("\n");
}

export function buildJudgeMessages(input: {
  question: string;
  answer: string;
  memories: MemorySnippet[];
}): import("@xtiand/shared").ChatMessage[] {
  return [
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content: `QUESTION:\n${input.question.slice(0, 2000)}\n\nCONTEXT AVAILABLE TO THE ASSISTANT:\n${memoryBlock(
        input.memories,
      )}\n\nASSISTANT ANSWER TO REVIEW:\n${input.answer.slice(0, 8000)}`,
    },
  ];
}

/** Judge provider: qa.judgeModel setting → JUDGE_MODEL env → default chat provider. */
export async function resolveJudgeProvider(): Promise<ResolvedProvider> {
  const setting = await prisma.setting.findUnique({ where: { key: "qa.judgeModel" } });
  const spec = setting?.value && setting.value.length > 0 ? setting.value : env.judgeModel;
  if (typeof spec === "string" && spec.length > 0) {
    return resolveProvider(spec);
  }
  return resolveProvider(null);
}

/** Ask the judge model to grade an answer. Never throws — returns a best-effort Grade. */
export async function gradeAnswer(opts: {
  provider: ResolvedProvider;
  question: string;
  answer: string;
  memories: MemorySnippet[];
}): Promise<Grade> {
  const messages = buildJudgeMessages(opts);
  let raw = "";
  try {
    const reply = await providerChat({
      kind: opts.provider.kind,
      baseUrl: opts.provider.baseUrl,
      apiKey: opts.provider.apiKey,
      model: opts.provider.model,
      messages,
      tools: [],
    });
    raw = reply.content.trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { score: null, grounded: false, flags: [], verdict: "", raw: `grade failed: ${message}` };
  }
  const parsed = parseJudgeJson(raw);
  if (!parsed) {
    return { score: null, grounded: false, flags: [], verdict: "", raw } as Grade;
  }
  return normalizeGrade(parsed, raw);
}

/** Feed the reviewer feedback back and produce a corrected answer. */
export async function reviseAnswer(opts: {
  provider: ResolvedProvider;
  question: string;
  answer: string;
  memories: MemorySnippet[];
  feedback: string;
}): Promise<{ content: string; failed: boolean }> {
  try {
    const reply = await providerChat({
      kind: opts.provider.kind,
      baseUrl: opts.provider.baseUrl,
      apiKey: opts.provider.apiKey,
      model: opts.provider.model,
      messages: [
        {
          role: "system",
          content:
            "You are rewriting a previous answer to fix the issues a quality reviewer found. Keep the original tone and any required output format. Reply with ONLY the corrected answer text — no preamble.",
        },
        {
          role: "user",
          content: `QUESTION:\n${opts.question.slice(0, 2000)}\n\nCONTEXT AVAILABLE:\n${memoryBlock(
            opts.memories,
          )}\n\nORIGINAL ANSWER:\n${opts.answer.slice(0, 8000)}\n\nREVIEWER FEEDBACK:\n${opts.feedback.slice(0, 800)}\n\nReturn the corrected answer only.`,
        },
      ],
      tools: [],
    });
    const content = reply.content.trim();
    return { content, failed: content.length === 0 };
  } catch {
    return { content: opts.answer, failed: true };
  }
}

/** Compose reviewer feedback from a grade for the revise prompt. */
export function feedbackFromGrade(grade: Grade): string {
  const parts: string[] = [];
  if (grade.flags.length > 0) parts.push(`flagged: ${grade.flags.join(", ")}`);
  if (grade.verdict.length > 0) parts.push(`verdict: ${grade.verdict}`);
  if (grade.score !== null) parts.push(`score: ${grade.score}/100`);
  return parts.length > 0 ? parts.join(" · ") : "answer needs improvement";
}

/** Read quality settings from the Setting table with defaults. */
export async function qualitySettings(): Promise<{
  criticEnabled: boolean;
  threshold: number;
  maxRevisions: number;
}> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["qa.criticEnabled", "qa.threshold", "qa.maxRevisions"] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    criticEnabled: (map.get("qa.criticEnabled") ?? "1") !== "0",
    threshold: Math.max(0, Math.min(100, Number.parseInt(map.get("qa.threshold") ?? "60", 10) || 60)),
    maxRevisions: Math.max(0, Math.min(3, Number.parseInt(map.get("qa.maxRevisions") ?? "1", 10) || 1)),
  };
}