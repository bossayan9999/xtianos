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
    input.onStep({ type: "status", data: `thinking (turn ${turns + 1}/${maxTurns})` });
    const reply = await providerChat({
      kind: input.provider.kind,
      baseUrl: input.provider.baseUrl,
      apiKey: input.provider.apiKey,
      model: input.provider.model,
      messages,
      tools: input.registry.list(),
    });

    messages.push({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls.length > 0 ? reply.toolCalls : undefined,
    });

    if (reply.content.length > 0) {
      input.onStep({ type: "message", data: reply.content });
    }

    if (reply.toolCalls.length === 0) {
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

    for (const call of reply.toolCalls) {
      const tool = input.registry.get(call.name);
      const scopes = tool ? tool.scopes.join(",") : "unknown";
      input.onStep({
        type: "tool-start",
        data: { id: call.id, name: call.name, argsJson: call.argsJson, scopes },
      });
      toolCallsUsed += 1;
      const signature = `${call.name}:${call.argsJson}`;
      let result: string;
      if (signature === lastCallSignature) {
        result =
          "ERROR duplicate call — you already ran this exact call with the same arguments. Use the earlier result instead of repeating yourself.";
      } else if (toolCallsUsed > maxToolCalls) {
        result = "ERROR tool-call budget exhausted — answer now with what you have.";
      } else {
        result = await input.registry.execute(call.name, call.argsJson, input.ctx);
        lastCallSignature = signature;
      }
      input.onStep({
        type: "tool-end",
        data: { id: call.id, name: call.name, result: result.slice(0, 4000) },
      });
      messages.push({ role: "tool", content: result, toolCallId: call.id });
    }
  }

  return { messages, turnsUsed: turns };
}
