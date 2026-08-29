/**
 * Live data-flow store for Mission Control.
 *
 * Every agent run (conversation chat/delegate) records its pipeline steps in
 * memory: goal (user prompt) -> tools/actions (with payload snippets) ->
 * output (final message + any generated artifact). The dashboard polls a small
 * JSON snapshot so it can render "data going up to the output" in real time.
 * In-memory only (bounded ring of recent runs) — nothing durable.
 */

export interface PipelineStep {
  id: number;
  runId: number;
  conversationId: number;
  ts: number;
  stage: "goal" | "act" | "synthesize" | "output" | "error";
  kind:
    | "goal"
    | "tool-start"
    | "tool-end"
    | "delegate"
    | "artifact"
    | "message"
    | "critic"
    | "error"
    | "run-end";
  label: string;
  detail: string;
  tool?: string | null;
  artifactId?: number | null;
  mime?: string | null;
  filename?: string | null;
  running?: boolean;
}

export interface PipelineRun {
  id: number;
  conversationId: number;
  startedAt: number;
  finishedAt: number | null;
  prompt: string;
  provider: string;
  model: string;
  output: string;
  status: "running" | "done" | "error";
}

const MAX_RUNS = 6;
const MAX_STEPS_PER_RUN = 48;

const runs: PipelineRun[] = [];
const stepsByRun = new Map<number, PipelineStep[]>();
let seqId = 0;

function trim(): void {
  while (runs.length > MAX_RUNS) {
    const oldest = runs.pop();
    if (oldest) stepsByRun.delete(oldest.id);
  }
  for (const run of runs) {
    const list = stepsByRun.get(run.id);
    if (list && list.length > MAX_STEPS_PER_RUN) {
      stepsByRun.set(run.id, list.slice(list.length - MAX_STEPS_PER_RUN));
    }
  }
}

export function startPipelineRun(opts: {
  conversationId: number;
  prompt: string;
  output: string;
  provider: string;
  model: string;
}): number {
  seqId += 1;
  const run: PipelineRun = {
    id: seqId,
    conversationId: opts.conversationId,
    startedAt: Date.now(),
    finishedAt: null,
    prompt: opts.prompt.slice(0, 300),
    provider: opts.provider,
    model: opts.model,
    output: opts.output,
    status: "running",
  };
  runs.unshift(run);
  stepsByRun.set(run.id, []);
  trim();
  stepPipeline(run.id, {
    conversationId: opts.conversationId,
    stage: "goal",
    kind: "goal",
    label: "Goal",
    detail: opts.prompt.slice(0, 260),
    running: true,
  });
  return run.id;
}

export function stepPipeline(
  runId: number,
  step: Omit<PipelineStep, "id" | "runId" | "ts">,
): void {
  const list = stepsByRun.get(runId);
  if (!list) return;
  seqId += 1;
  list.push({
    id: seqId,
    runId,
    ts: Date.now(),
    ...step,
  });
  trim();
}

export function finishPipelineRun(runId: number, status: "done" | "error"): void {
  const run = runs.find((r) => r.id === runId);
  if (run) {
    run.finishedAt = Date.now();
    run.status = status;
  }
  stepPipeline(runId, {
    conversationId: run?.conversationId ?? 0,
    stage: status === "error" ? "error" : "synthesize",
    kind: "run-end",
    label: status === "error" ? "Error" : "Done",
    detail: status === "error" ? "Run finished with an error." : "Run complete — output delivered.",
    running: false,
  });
}

export function getPipelineState(): {
  runs: PipelineRun[];
  steps: PipelineStep[];
} {
  const steps: PipelineStep[] = [];
  for (const run of runs) {
    const list = stepsByRun.get(run.id);
    if (list) steps.push(...list);
  }
  return { runs, steps };
}