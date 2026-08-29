/**
 * Durable per-run telemetry for the Quality & speed dashboard.
 *
 * Pipeline.ts keeps a bounded in-memory ring for Mission Control's live view;
 * RunRecord is the persistent history: latency, estimated tokens, model calls,
 * quality score/flags and feedback — aggregated by the /api/quality endpoints.
 */

import { prisma } from "../lib/db";

export interface RunRecordInput {
  runId: number;
  conversationId: number;
  prompt: string;
  provider: string;
  model: string;
  mode: "chat" | "plan" | "build";
  outputKind: string;
  latencyMs: number;
  tokensEstimated: number;
  modelCalls: number;
  totalArtifacts: number;
  grounded: boolean;
  qualityScore: number | null;
  qualityFlags: string | null;
  revisions: number;
  status: "done" | "error";
}

export async function createRunRecord(input: RunRecordInput): Promise<number> {
  const row = await prisma.runRecord.create({
    data: {
      runId: input.runId,
      conversationId: input.conversationId,
      prompt: input.prompt.slice(0, 300),
      provider: input.provider,
      model: input.model,
      mode: input.mode,
      outputKind: input.outputKind,
      latencyMs: input.latencyMs,
      tokensEstimated: input.tokensEstimated,
      modelCalls: input.modelCalls,
      totalArtifacts: input.totalArtifacts,
      grounded: input.grounded,
      qualityScore: input.qualityScore,
      qualityFlags: input.qualityFlags,
      revisions: input.revisions,
      status: input.status,
    },
  });
  return row.id;
}

export interface QualityAggregate {
  runs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgScore: number | null;
  scoredRuns: number;
  groundedRuns: number;
  flaggedRuns: number;
  revisionsTotal: number;
  runsLast24h: number;
  errorRuns: number;
  flagCounts: Record<string, number>;
}

export function aggregateRuns(rows: {
  latencyMs: number;
  qualityScore: number | null;
  qualityFlags: string | null;
  grounded: boolean;
  revisions: number;
  status: string;
  createdAt: Date;
}[]): QualityAggregate {
  const agg: QualityAggregate = {
    runs: rows.length,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    avgScore: null,
    scoredRuns: 0,
    groundedRuns: 0,
    flaggedRuns: 0,
    revisionsTotal: 0,
    runsLast24h: 0,
    errorRuns: 0,
    flagCounts: {},
  };
  if (rows.length === 0) return agg;
  const latency = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  agg.avgLatencyMs = Math.round(latency.reduce((a, b) => a + b, 0) / latency.length);
  agg.p95LatencyMs = latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))] ?? 0;
  const now = Date.now();
  let scoreSum = 0;
  for (const row of rows) {
    if (row.status === "error") agg.errorRuns += 1;
    if (row.grounded) agg.groundedRuns += 1;
    agg.revisionsTotal += row.revisions;
    if (row.qualityScore !== null && row.qualityScore >= 0) {
      agg.scoredRuns += 1;
      scoreSum += row.qualityScore;
    }
    if (row.qualityFlags !== null && row.qualityFlags.trim().length > 0) {
      agg.flaggedRuns += 1;
      const flags = parseFlags(row.qualityFlags);
      for (const flag of flags) agg.flagCounts[flag] = (agg.flagCounts[flag] ?? 0) + 1;
    }
    if (now - row.createdAt.getTime() <= 86_400_000) agg.runsLast24h += 1;
  }
  agg.avgScore = agg.scoredRuns > 0 ? Math.round(scoreSum / agg.scoredRuns) : null;
  return agg;
}

export function parseFlags(qualityFlagsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(qualityFlagsJson);
    if (Array.isArray(parsed)) return parsed.filter((f): f is string => typeof f === "string");
  } catch {
    /* ignore malformed */
  }
  return [];
}