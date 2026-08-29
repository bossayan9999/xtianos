import type { ChatMessage } from "@xtiand/shared";

import { providerChat } from "./providers";
import type { ToolContext } from "./types";
import type { ToolRegistry } from "./tools/registry";

export interface AgentLoopInput {
  messages: ChatMessage[];
  registry: ToolRegistry;
  ctx: ToolContext;
  provider: {
    kind: "openai-compat" | "anthropic";
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  maxTurns?: number;
  maxToolCalls?: number;
  onStep: (event: { type: string; data: unknown }) => void;
  /** Called with each streamed text delta so the UI can render tokens live. */
  onToken?: (delta: string) => void;
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  turnsUsed: number;
}

/**
 * mjane fast loop: plan -> act -> observe, repeating until the model stops
 * calling tools or maxTurns is hit. Every transition is streamed via onStep.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const messages = [...input.messages];
  const maxTurns = input.maxTurns ?? 8;
  const maxToolCalls = input.maxToolCalls ?? 25;
  let turns = 0;
  let nudged = false;
  let toolCallsUsed = 0;
  let lastCallSignature = "";

  for (; turns < maxTurns; turns += 1) {
    // Reset each turn so a repeat check only guards against the single last
    // call of the previous turn — not whichever parallel call finished last.
    lastCallSignature = "";
    input.onStep({ type: "status", data: `thinking (turn ${turns + 1}/${maxTurns})` });
    const reply = await providerChat({
      kind: input.provider.kind,
      baseUrl: input.provider.baseUrl,
      apiKey: input.provider.apiKey,
      model: input.provider.model,
      messages,
      tools: input.registry.list(),
      onToken: input.onToken
        ? (delta) => input.onStep({ type: "token", data: delta })
        : undefined,
      onVisionStripped: () =>
        input.onStep({
          type: "status",
          data: "⚠ this model can't receive images — they were removed and it answered text-only. For photos/vision, switch to minimax/minimax-m3:free (a free vision model).",
        }),
    });

    messages.push({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls.length > 0 ? reply.toolCalls : undefined,
    });

    if (reply.toolCalls.length === 0) {
      // Concluding turn — emit ONE authoritative message. Intermediate
      // tool-calling turns already streamed their text live via token events;
      // only announce the final answer here so the UI never accumulates or
      // duplicates per-turn partial text (which previously repeated answers).
      if (reply.content.length > 0) {
        input.onStep({ type: "message", data: reply.content });
      }
      // Some models stop dead after tool results without ever answering.
      // Nudge exactly once so the user always gets a reply.
      if (reply.content.trim().length === 0 && !nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content:
            "You stopped without replying. Based on everything above (including any tool results), give your final answer to the user now.",
        });
        continue;
      }
      if (reply.content.trim().length === 0) {
        input.onStep({
          type: "message",
          data: "(the model returned an empty response — try again or switch models)",
        });
      }
      break;
    }

    // Execute all tool calls from this turn. Independent calls run in PARALLEL
    // (Promise.all) so delegating to multiple agents or running several tools
    // at once happens concurrently instead of one-at-a-time.
    const pendingImages: string[] = [];
    const runCtx: ToolContext = { ...input.ctx, attachImage: (dataUrl) => pendingImages.push(dataUrl) };

    const seenInTurn = new Set<string>();
    const entries = reply.toolCalls.map((call) => {
      const signature = `${call.name}:${call.argsJson}`;
      let blocked = "";
      if (signature === lastCallSignature || seenInTurn.has(signature)) {
        blocked =
          "ERROR duplicate call — you already ran this exact call with the same arguments. Use the earlier result instead of repeating yourself.";
      } else if (toolCallsUsed + seenInTurn.size >= maxToolCalls) {
        blocked = "ERROR tool-call budget exhausted — answer now with what you have.";
      } else {
        seenInTurn.add(signature);
      }
      return { call, blocked, signature };
    });

    const results = await Promise.all(
      entries.map(async ({ call, blocked }) => {
        const tool = input.registry.get(call.name);
        const scopes = tool ? tool.scopes.join(",") : "unknown";
        input.onStep({
          type: "tool-start",
          data: { id: call.id, name: call.name, argsJson: call.argsJson, scopes },
        });
        let result: string;
        if (blocked) {
          result = blocked;
        } else {
          try {
            result = await input.registry.execute(call.name, call.argsJson, runCtx);
          } catch (error: unknown) {
            result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        input.onStep({
          type: "tool-end",
          data: { id: call.id, name: call.name, result: result.slice(0, 4000) },
        });
        return { call, result };
      }),
    );

    toolCallsUsed += results.length;
    // Record the last actual (non-blocked) call in call order, deterministically,
    // so the next turn's repeat guard has a stable reference regardless of which
    // parallel call happened to resolve last.
    const lastReal = entries[entries.length - 1];
    if (lastReal && !lastReal.blocked) {
      lastCallSignature = lastReal.signature;
    }
    for (const { call, result } of results) {
      messages.push({ role: "tool", content: result, toolCallId: call.id });
    }

    // If tools attached images (image_generate / image_read), send them to the
    // model as vision input on the next turn so it can actually see them.
    if (pendingImages.length > 0) {
      input.onStep({
        type: "attached-images",
        data: { count: pendingImages.length },
      });
      messages.push({
        role: "user",
        content: `Here ${pendingImages.length === 1 ? "is the image" : "are the images"} from the tool(s) above. Inspect it/them carefully and describe what you see, then incorporate that understanding into your answer.`,
        images: pendingImages.slice(0, 4),
      });
    }
  }

  return { messages, turnsUsed: turns };
}
