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
  onToken?: (delta: string) => void;
  onStreamStart?: () => void;
  onVisionStripped?: () => void;
}): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  const cacheKey = stableKey([input.kind, input.baseUrl, input.model, input.messages]);
  const cached = chatCache.get(cacheKey);
  if (cached) return cached;
  const onToken = input.onToken;
  const call = (messages: ChatMessage[]): Promise<{ content: string; toolCalls: ToolCallDto[] }> =>
    input.kind === "anthropic"
      ? anthropicChat(input.apiKey, input.model, messages, input.tools)
      : openaiChat(input.baseUrl, input.apiKey, input.model, messages, input.tools, {
          onToken,
          onStreamStart: input.onStreamStart,
        });

  let reply: { content: string; toolCalls: ToolCallDto[] };
  try {
    reply = await call(input.messages);
  } catch (error: unknown) {
    // Some endpoints/models can't receive images at all (e.g. OpenRouter
    // free text models: 404 "No endpoints found that support image input").
    // If the model merely READ a generated image (image_read), don't let that
    // kill the whole run — degrade to the same call without the image parts so
    // the reply (with its ARTIFACT:<id>) still gets produced and displayed.
    const message = error instanceof Error ? error.message : String(error);
    const hasImages = input.messages.some((m) => m.images && m.images.length > 0);
    if (hasImages && /image input|image_url|vision|multimodal/i.test(message)) {
      const stripped = input.messages.map((m) =>
        m.images && m.images.length > 0
          ? {
              ...m,
              images: undefined,
              content: `${m.content}\n\n(Note: this model cannot receive the attached image, so it was removed. Answer using the tool results above.)`,
            }
          : m,
      );
      reply = await call(stripped);
      input.onVisionStripped?.();
    } else {
      throw error;
    }
  }
  // only cache final answers — tool-call turns depend on external state
  if (onToken === undefined && reply.toolCalls.length === 0 && reply.content.trim().length > 0) {
    chatCache.set(cacheKey, reply);
  }
  return reply;
}

/** Static starter catalog merged with live /models when reachable. */
export function starterCatalog(): ModelInfo[] {
  const openai = [
    "gpt-5.2",
    "gpt-5-mini",
    "gpt-5-nano",
    "o4-mini",
    "o3",
    "text-embedding-3-small",
  ].map((id) => ({ id, label: `OpenAI ${id}`, providerId: null, kind: "openai-compat" as ProviderKind }));
  const anthropicModels = ["claude-sonnet-4-6", "claude-opus-4-1", "claude-haiku-4-5"].map(
    (id) => ({ id, label: `Anthropic ${id}`, providerId: null, kind: "anthropic" as ProviderKind }),
  );
  const openrouter = [
    "openai/gpt-5.2",
    "openai/gpt-5-mini",
    "openai/o4-mini",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4-1",
    "anthropic/claude-haiku-4-5",
    "google/gemini-3-flash",
    "google/gemini-3-pro",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-r1",
    "meta-llama/llama-4-maverick",
    "meta-llama/llama-4-scout",
    "qwen/qwen3-235b-a22b",
    "mistralai/mistral-large-2411",
    "x-ai/grok-3",
    "minimax/minimax-m3:free",
    "google/gemma-4-26b-a4b-it:free",
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
    "qwen3-235b-a22b",
    "llama-4-maverick",
  ].map((id) => ({
    id,
    label: `OpenCode ${id}${id.endsWith("-free") ? " (free)" : ""}`,
    providerId: null,
    kind: "openai-compat" as ProviderKind,
  }));
  const nvidia = [
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "nvidia/llama-3.3-70b-instruct",
    "nvidia/mistral-nemo-12b-instruct",
    "nvidia/phi-3.5-mini-instruct",
    "nvidia/llama-3.1-8b-instruct",
    "nvidia/gemma-2-9b-it",
    "nvidia/nemotron-3-8b-chat-SteerLM",
    "nvidia/nemotron-mini-4b-instruct",
  ].map((id) => ({
    id,
    label: `NVIDIA ${id.split("/")[1]}`,
    providerId: null,
    kind: "openai-compat" as ProviderKind,
  }));
  const local = ["ollama/llama3.3", "ollama/qwen3-coder"].map((id) => ({
    id,
    label: `Local ${id}`,
    providerId: null,
    kind: "openai-compat" as ProviderKind,
  }));
  return [...openai, ...anthropicModels, ...openrouter, ...zen, ...nvidia, ...local];
}
