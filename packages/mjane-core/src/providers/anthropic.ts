import type { ChatMessage, ToolCallDto } from "@xtiand/shared";

import type { ToolDef } from "../types";

const ANTHROPIC_VERSION = "2023-06-01";

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: { role: string; content: unknown }[];
} {
  let system = "";
  const out: { role: string; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += `${m.content}\n`;
    } else if (m.role === "tool") {
      const last = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.argsJson);
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }
  return { system: system.trim(), messages: out };
}

function toAnthropicTools(tools: ToolDef[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        tool.params.map((param) => [
          param.name,
          { type: param.type, description: param.description },
        ]),
      ),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }));
}

function fromAnthropicToolCalls(content: unknown): ToolCallDto[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCallDto[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (
      b["type"] === "tool_use" &&
      typeof b["id"] === "string" &&
      typeof b["name"] === "string"
    ) {
      out.push({
        id: b["id"],
        name: b["name"],
        argsJson: JSON.stringify(b["input"] ?? {}),
      });
    }
  }
  return out;
}

export async function chat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
): Promise<{ content: string; toolCalls: ToolCallDto[] }> {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: anthropicMessages,
  };
  if (system) body["system"] = system;
  if (tools.length > 0) body["tools"] = toAnthropicTools(tools);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`anthropic chat failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const content = json["content"] as Record<string, unknown>[] | undefined;
  const text = (content ?? [])
    .filter((b) => b["type"] === "text")
    .map((b) => String(b["text"] ?? ""))
    .join("");
  return { content: text, toolCalls: fromAnthropicToolCalls(content) };
}
