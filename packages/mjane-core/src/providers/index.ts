import type { ChatMessage, ModelInfo, ProviderKind, ToolCallDto } from "@xtiand/shared";

import { chat as anthropicChat } from "./anthropic";
import { chat as openaiChat, embed, listModels } from "./openai-compat";
import { TtlCache, stableKey } from "../cache";
import type { ToolDef } from "../types";

const chatCache = new TtlCache<{ content: string; toolCalls: ToolCallDto[] }>(200, 30 * 60 * 1000);

export { embed, listModels };

export async function providerChat(input: {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
}): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  const cacheKey = stableKey([input.kind, input.baseUrl, input.model, input.messages]);
  const cached = chatCache.get(cacheKey);
  if (cached) return cached;
  const reply =
    input.kind === "anthropic"
      ? await anthropicChat(input.apiKey, input.model, input.messages, input.tools)
      : await openaiChat(input.baseUrl, input.apiKey, input.model, input.messages, input.tools);
  // only cache final answers — tool-call turns depend on external state
  if (reply.toolCalls.length === 0 && reply.content.trim().length > 0) {
    chatCache.set(cacheKey, reply);
  }
  return reply;
}

/** Static starter catalog merged with live /models when reachable. */
export function starterCatalog(): ModelInfo[] {
  const openai = [
    "gpt-5.2",
    "gpt-5-mini",
    "o4-mini",
    "text-embedding-3-small",
  ].map((id) => ({ id, label: `OpenAI ${id}`, providerId: null, kind: "openai-compat" as ProviderKind }));
  const anthropicModels = ["claude-sonnet-4-6", "claude-opus-4-1", "claude-haiku-4-5"].map(
    (id) => ({ id, label: `Anthropic ${id}`, providerId: null, kind: "anthropic" as ProviderKind }),
  );
  const openrouter = [
    "openai/gpt-5.2",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-3-flash",
    "deepseek/deepseek-v4-flash",
    "meta-llama/llama-4-maverick:free",
  ].map((id) => ({
    id,
    label: `OpenRouter ${id}`,
    providerId: null,
    kind: "openai-compat" as ProviderKind,
  }));
  // NOTE: GPT-5.x/Claude/Grok-4.x on Zen require the Responses API (/zen/v1/responses),
  // which is not wired up yet — catalog lists only chat/completions models.
  const zen = [
    "big-pickle",
    "kimi-k2.5",
    "glm-5.2",
    "deepseek-v4-flash",
    "minimax-m2.5",
    "x-preview-f-free",
    "nemotron-3-ultra-free",
  ].map((id) => ({
    id,
    label: `Zen ${id}${id.endsWith("-free") ? " (free)" : ""}`,
    providerId: null,
    kind: "openai-compat" as ProviderKind,
  }));
  const local = ["ollama/llama3.3", "ollama/qwen3-coder"].map((id) => ({
    id,
    label: `Local ${id}`,
    providerId: null,
    kind: "openai-compat" as ProviderKind,
  }));
  return [...openai, ...anthropicModels, ...openrouter, ...zen, ...local];
}
