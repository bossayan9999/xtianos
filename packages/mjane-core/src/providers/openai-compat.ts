import type { ChatMessage, ToolCallDto } from "@xtiand/shared";

import { TtlCache } from "../cache";
import type { ToolDef } from "../types";

const modelsCache = new TtlCache<string[]>(40, 10 * 60 * 1000);

function toOpenAiTools(tools: ToolDef[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          tool.params.map((param) => [
            param.name,
            { type: param.type, description: param.description },
          ]),
        ),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }));
}

function fromOpenAiToolCalls(raw: unknown): ToolCallDto[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallDto[] = [];
  for (const call of raw) {
    const c = call as Record<string, unknown>;
    const fn = c["function"] as Record<string, unknown> | undefined;
    if (typeof c["id"] === "string" && typeof fn?.["name"] === "string") {
      out.push({
        id: c["id"],
        name: fn["name"],
        argsJson: typeof fn["arguments"] === "string" ? fn["arguments"] : "{}",
      });
    }
  }
  return out;
}

/** OpenAI content is a string, but some gateways return an array of typed parts. */
export function normalizeContent(message: Record<string, unknown> | undefined): string {
  const raw = message?.["content"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        const p = part as Record<string, unknown>;
        return typeof p["text"] === "string" ? p["text"] : "";
      })
      .join("");
  }
  return "";
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ChatStreamOptions {
  /** Called with each text delta as it streams from the provider. */
  onToken?: (delta: string) => void;
  /** Called once the stream establishes (before first token) so UI can show readiness. */
  onStreamStart?: () => void;
}

/** Max bytes we're willing to see before the first SSE data line before bailing to non-stream. */
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 20_000;

/** Abort the whole stream if it runs this long (bytes may trickle but never complete). */
const STREAM_WATCHDOG_TIMEOUT_MS = 300_000;

/** Abort if no data arrives for this long mid-stream (server stall). */
const STREAM_STALL_TIMEOUT_MS = 60_000;

export async function chat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  opts: ChatStreamOptions = {},
): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const useStream = opts.onToken !== undefined;
    const reply = useStream
      ? await chatStreamOnce(baseUrl, apiKey, model, messages, tools, opts)
      : await chatOnce(baseUrl, apiKey, model, messages, tools);
    // gateways sometimes answer 200 with nothing — treat as transient
    if (reply.content.trim().length === 0 && reply.toolCalls.length === 0 && attempt < 2) {
      await delay(1200 * (attempt + 1));
      continue;
    }
    return reply;
  }
  throw lastError ?? new Error("provider chat failed");
}

/**
 * Streaming-aware single attempt. Requests `stream: true`. If the gateway
 * responds with a non-SSE body (e.g. a free endpoint that ignores streaming),
 * or the stream yields nothing, we gracefully fall back to the buffered path
 * and deliver the full reply once (optionally line-by-line via onToken).
 */
async function chatStreamOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  opts: ChatStreamOptions,
): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" }
        : m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
          ? {
              role: "assistant",
              content: m.content,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.argsJson },
              })),
            }
          : m.images && m.images.length > 0
            ? {
                role: m.role,
                content: [
                  { type: "text", text: m.content },
                  ...m.images.map((dataUrl) => ({
                    type: "image_url",
                    image_url: { url: dataUrl.startsWith("data:") ? dataUrl : `data:image/jpeg;base64,${dataUrl}` },
                  })),
                ],
              }
            : { role: m.role, content: m.content },
    ),
  };
  if (tools.length > 0) body["tools"] = toOpenAiTools(tools);

  const controller = new AbortController();
  const firstChunkTimer = setTimeout(
    () => controller.abort(),
    STREAM_FIRST_CHUNK_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // network/timeout before a response — fall back to buffered
    clearTimeout(firstChunkTimer);
    return chatOnce(baseUrl, apiKey, model, messages, tools);
  }
  if (!res.ok) {
    clearTimeout(firstChunkTimer);
    throw new Error(`provider chat failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // endpoint ignored streaming and returned a plain JSON body — 
    // parse the full answer and stream it out once as a fallback.
    clearTimeout(firstChunkTimer);
    try {
      const json = (await res.json()) as Record<string, unknown>;
      const choice = (json["choices"] as Record<string, unknown>[] | undefined)?.[0];
      const message = choice?.["message"] as Record<string, unknown> | undefined;
      const content = normalizeContent(message);
      const toolCalls = fromOpenAiToolCalls(message?.["tool_calls"]);
      opts.onStreamStart?.();
      if (content && toolCalls.length === 0) opts.onToken?.(content);
      return { content, toolCalls };
    } catch {
      // not JSON either — give up on parsing, pull raw text as content
      const raw = await res.text();
      opts.onStreamStart?.();
      if (raw) opts.onToken?.(raw);
      return { content: raw, toolCalls: [] };
    }
  }

  clearTimeout(firstChunkTimer);
  opts.onStreamStart?.();

  // Watchdogs for the body phase: only cover cases the firstChunkTimer no longer guards.
  // Both abort the fetch `controller` so the active reader.read() is interrupted.
  let watchdogTimer = setTimeout(() => controller.abort(), STREAM_WATCHDOG_TIMEOUT_MS);
  let stallTimer = setTimeout(() => controller.abort(), STREAM_STALL_TIMEOUT_MS);
  const kickWatchdogs = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STREAM_STALL_TIMEOUT_MS);
  };
  const stopWatchdogs = (): void => {
    clearTimeout(watchdogTimer);
    clearTimeout(stallTimer);
  };

  let content = "";
  // Keyed by tool-call `index` (present on every chunk), NOT `id`, because
  // OpenAI-compatible streams only carry `id`/`name` on the first delta of a
  // call and every continuation chunk carries only `index` + arguments.
  const toolCallsByIndex = new Map<number, { id: string; name: string; argsJson: string }>();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream body");
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      kickWatchdogs();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: Record<string, unknown> }[];
          };
          const delta = chunk["choices"]?.[0]?.["delta"];
          if (!delta) continue;
          const textDelta = normalizeContent(delta);
          if (textDelta) {
            content += textDelta;
            opts.onToken?.(textDelta);
          }
          const toolCalls = delta["tool_calls"] as Record<string, unknown>[] | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const index = Number(tc["index"] ?? 0);
              const id = String(tc["id"] ?? "");
              const name = String((tc["function"] as Record<string, unknown> | undefined)?.["name"] ?? "");
              const args = String((tc["function"] as Record<string, unknown> | undefined)?.["arguments"] ?? "");
              const existing = toolCallsByIndex.get(index);
              if (existing) {
                existing.argsJson += args;
                if (name) existing.name = name;
                if (id) existing.id = id;
              } else {
                toolCallsByIndex.set(index, { id, name, argsJson: args });
              }
            }
          }
        } catch {
          // malformed SSE line — ignore
        }
      }
      if (controller.signal.aborted) {
        // whole-stream timeout or mid-stream stall fired
        throw new Error("provider stream timed out");
      }
    }
    stopWatchdogs();
    if (buffer.trim()) {
      // trailing buffered data without newline
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
        try {
          const payload = trimmed.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: Record<string, unknown> }[];
            };
            const textDelta = normalizeContent(chunk["choices"]?.[0]?.["delta"]);
            if (textDelta) {
              content += textDelta;
              opts.onToken?.(textDelta);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    const toolCalls = [...toolCallsByIndex.values()].filter((t) => t.name.length > 0);
    return { content, toolCalls };
  } catch (error) {
    // stream errored mid-way; if we already got content, keep it (don't lose work),
    // otherwise fall back to the buffered request.
    stopWatchdogs();
    if (content.length === 0) {
      return chatOnce(baseUrl, apiKey, model, messages, tools);
    }
    return { content, toolCalls: [...toolCallsByIndex.values()].filter((t) => t.name.length > 0) };
  }
}

async function chatOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" }
        : m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
          ? {
              role: "assistant",
              content: m.content,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.argsJson },
              })),
            }
          : m.images && m.images.length > 0
          ? {
              role: m.role,
              content: [
                { type: "text", text: m.content },
                ...m.images.map((dataUrl) => ({
                  type: "image_url",
                  image_url: { url: dataUrl.startsWith("data:") ? dataUrl : `data:image/jpeg;base64,${dataUrl}` },
                })),
              ],
            }
          : { role: m.role, content: m.content },
    ),
  };
  if (tools.length > 0) body["tools"] = toOpenAiTools(tools);

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`provider chat failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const choice = (json["choices"] as Record<string, unknown>[] | undefined)?.[0];
  const message = choice?.["message"] as Record<string, unknown> | undefined;
  return {
    content: normalizeContent(message),
    toolCalls: fromOpenAiToolCalls(message?.["tool_calls"]),
  };
}

export async function embed(
  baseUrl: string,
  apiKey: string,
  input: string[],
): Promise<number[][] | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vectors = (json.data ?? []).map((d) => d.embedding ?? []).filter((v) => v.length > 0);
  return vectors.length === input.length ? vectors : null;
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const cached = modelsCache.get(baseUrl);
  if (cached) return cached;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { id?: string }[] };
  const ids = (json.data ?? [])
    .map((d) => d.id ?? "")
    .filter((id) => id.length > 0)
    .sort();
  modelsCache.set(baseUrl, ids);
  return ids;
}
