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

export async function chat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reply = await chatOnce(baseUrl, apiKey, model, messages, tools);
      // gateways sometimes answer 200 with nothing — treat as transient
      if (reply.content.trim().length === 0 && reply.toolCalls.length === 0 && attempt < 2) {
        await delay(1200 * (attempt + 1));
        continue;
      }
      return reply;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const status = Number.parseInt(/^provider chat failed \((\d{3})\)/.exec(lastError.message)?.[1] ?? "0", 10);
      if (!TRANSIENT.has(status) || attempt === 2) throw lastError;
      await delay(1500 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("provider chat failed");
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
