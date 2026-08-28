/**
 * Shared MCP JSON-RPC handler for xtiandOS MCP server.
 *
 * Implemented by both the stdio transport (index.ts) and the Streamable HTTP
 * transport (http-server.ts).
 */

import { spawn } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";

const API = (process.env.XTIANDOS_API_URL ?? "http://127.0.0.1:3101").trim();
const VAULT = (process.env.XTIANDOS_VAULT ?? "").trim();

const SERVER_INFO = {
  name: "xtiandos-mcp",
  version: "0.1.0",
};

export const CAPABILITIES = {
  tools: {},
  resources: { subscribe: true, listChanged: true },
  prompts: {},
  sampling: {},
  roots: { listChanged: true },
};

// ---------------------------------------------------------------------------
// API proxy helpers
// ---------------------------------------------------------------------------

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "xtiandos_status",
    description: "Check if xtiandOS is running and get basic health info.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "xtiandos_brain_search",
    description:
      "Search the xtiandOS brain vault for notes relevant to a query. Returns ranked paths + snippets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "xtiandos_brain_read",
    description: "Read a note from the xtiandOS brain vault by relative path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path inside the vault" },
      },
      required: ["path"],
    },
  },
  {
    name: "xtiandos_brain_write",
    description: "Create or update a note in the xtiandOS brain vault.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path inside the vault" },
        content: { type: "string", description: "Full markdown content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "xtiandos_brain_tree",
    description: "List files and folders in the xtiandOS brain vault.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path (default: root)" },
      },
    },
  },
  {
    name: "xtiandos_vault_list",
    description:
      "List notes in the Obsidian vault. Optionally filter by subfolder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder: { type: "string", description: "Subfolder relative to vault root" },
      },
    },
  },
  {
    name: "xtiandos_memory_search",
    description:
      "Search xtiandOS long-term memory (RAG index) for relevant context from past sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "What to recall" },
      },
      required: ["query"],
    },
  },
  {
    name: "xtiandos_send_message",
    description:
      "Send a message to xtiandOS mjane via the inter-agent message bus. mjane will see it in her next session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type: command, query, status, response",
          enum: ["command", "query", "status", "response"],
        },
      },
      required: ["content"],
    },
  },
  {
    name: "xtiandos_read_messages",
    description:
      "Read unread messages from the xtiandOS message bus (messages addressed to 'copilot' or broadcast).",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Filter by sender agent ID (optional)",
        },
      },
    },
  },
  {
    name: "xtiandos_chat",
    description:
      "Send a message to mjane's chat and get a response (uses xtiandOS agent loop).",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "Message to send to mjane" },
        model: {
          type: "string",
          description: "Optional model override (providerId:model)",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "xtiandos_conversations",
    description: "List recent xtiandOS chat conversations.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "xtiandos_shell",
    description:
      "Run a shell command on the host (destructive commands are audit-logged and blocked).",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory (defaults to workspace)" },
      },
      required: ["command"],
    },
  },
  {
    name: "xtiandos_docker",
    description: "Control Docker: list containers, start/stop/restart, logs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description: "list | start | stop | restart | logs | ps",
          enum: ["list", "start", "stop", "restart", "logs", "ps"],
        },
        container: { type: "string", description: "Container name/id (required for start/stop/restart/logs)" },
        tail: { type: "number", description: "Lines of logs to return (default 100)" },
      },
      required: ["action"],
    },
  },
  {
    name: "xtiandos_artifact",
    description: "Generate an artifact (code, docs, SVG, or image prompt) into the workspace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Relative output filename" },
        content: { type: "string", description: "File content" },
        kind: { type: "string", description: "code | doc | svg | image" },
      },
      required: ["filename", "content"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const RESOURCES = [
  {
    uri: "vault://notes/list",
    name: "Vault notes index",
    description: "List of all notes in the Obsidian vault",
    mimeType: "application/json",
  },
  {
    uri: "vault://notes/",
    name: "Vault note content",
    description: "Read a note by path: vault://notes/{path}",
    mimeType: "text/markdown",
  },
  {
    uri: "memory://chunks",
    name: "Memory chunks (recent)",
    description: "Most recent RAG memory chunks indexed by mjane",
    mimeType: "application/json",
  },
  {
    uri: "system://health",
    name: "xtiandOS health",
    description: "API health + basic system status",
    mimeType: "application/json",
  },
  {
    uri: "system://env",
    name: "Environment snapshot",
    description: "Non-secret environment variables relevant to xtiandOS",
    mimeType: "application/json",
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "vault://notes/{path}",
    name: "Vault note",
    description: "Read any note in the vault by relative path",
    mimeType: "text/markdown",
  },
  {
    uriTemplate: "memory://chunks/{id}",
    name: "Memory chunk",
    description: "Read a specific RAG memory chunk by id",
    mimeType: "application/json",
  },
];

async function readResource(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const { pathname } = new URL(uri);

  if (uri === "vault://notes/list") {
    const tree = (await api("/api/brain/tree?path=")) as unknown;
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(tree, null, 2) }] };
  }

  if (uri.startsWith("vault://notes/")) {
    const rel = pathname.replace(/^\/notes\//, "");
    const result = (await api(`/api/brain/file?path=${encodeURIComponent(rel)}`)) as { content?: string };
    return { contents: [{ uri, mimeType: "text/markdown", text: result.content ?? "" }] };
  }

  if (uri.startsWith("memory://chunks/")) {
    const id = pathname.replace(/^\/chunks\//, "");
    const result = (await api(`/api/memory/chunks/${encodeURIComponent(id)}`)) as unknown;
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
  }

  if (uri === "memory://chunks") {
    const chunks = (await api("/api/memory/chunks")) as unknown;
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(chunks, null, 2) }] };
  }

  if (uri === "system://health") {
    const health = (await api("/health")) as unknown;
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(health, null, 2) }] };
  }

  if (uri === "system://env") {
    const safe = Object.entries(process.env)
      .filter(([k]) => !/^(?:.*(?:KEY|SECRET|TOKEN|PASSWORD|MASTER)|NODE_ENV)/i.test(k))
      .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(safe, null, 2) }] };
  }

  throw Object.assign(new Error("Resource not found"), { code: -32002 });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PROMPTS = [
  {
    name: "analyze-note",
    description: "Analyze a vault note and summarize its key points.",
    arguments: [
      { name: "path", description: "Relative vault note path", required: true },
    ],
  },
  {
    name: "plan-task",
    description: "Break a task into actionable steps with a kanban-style checklist.",
    arguments: [
      { name: "task", description: "The task to plan", required: true },
      { name: "model", description: "Optional model override", required: false },
    ],
  },
  {
    name: "summarize-conversation",
    description: "Summarize a recent xtiandOS chat conversation.",
    arguments: [
      { name: "conversationId", description: "Numeric conversation id", required: true },
    ],
  },
];

function buildPrompt(name: string, args: Record<string, unknown>): { description: string; messages: { role: string; content: { type: string; text: string }[] }[] } {
  switch (name) {
    case "analyze-note": {
      const path = String(args["path"] ?? "");
      return {
        description: `Analyze the vault note ${path}`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Read the note at vault://notes/${path}, then give a structured summary: purpose, main sections, open questions.`,
              },
            ],
          },
        ],
      };
    }
    case "plan-task": {
      const task = String(args["task"] ?? "");
      return {
        description: `Plan: ${task}`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Create an action plan for: ${task}\nReturn as a checklist with owner, effort, and dependency notes.`,
              },
            ],
          },
        ],
      };
    }
    case "summarize-conversation": {
      const id = String(args["conversationId"] ?? "");
      return {
        description: `Summarize conversation #${id}`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Summarize xtiandOS chat conversation ${id}: topic, decisions, follow-ups.`,
              },
            ],
          },
        ],
      };
    }
    default:
      throw Object.assign(new Error(`Prompt not found: ${name}`), { code: -32002 });
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

const BLOCKED_PREFIXES = [
  "rm -rf /",
  "mkfs.",
  "dd if=",
  ":(){ :|:& };:",
  "shutdown",
  "reboot",
  "poweroff",
  "chmod -R 777 /",
  "kill -9 1",
  "> /dev/sda",
];

function isDestructive(command: string): boolean {
  const lower = command.toLowerCase();
  return BLOCKED_PREFIXES.some((p) => lower.includes(p));
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise<string>((resolvePromise) => {
    const child = spawn("bash", ["-lc", command], { cwd, timeout: 30_000, shell: false });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", (error: Error) => resolvePromise(`ERROR ${error.message}`));
    child.on("close", (code: number | null) => resolvePromise(`exit=${code ?? "signal"}\n${out.slice(0, 8000)}`));
  });
}

function dockerAction(action: string, container: string | undefined, tail: number): Promise<string> {
  const args: string[] = [];
  switch (action) {
    case "list":
    case "ps":
      args.push("ps", "-a");
      break;
    case "start":
      args.push("start", container ?? "");
      break;
    case "stop":
      args.push("stop", container ?? "");
      break;
    case "restart":
      args.push("restart", container ?? "");
      break;
    case "logs":
      args.push("logs", "--tail", String(tail || 100), container ?? "");
      break;
    default:
      return Promise.resolve(`Unknown docker action: ${action}`);
  }
  return new Promise<string>((resolvePromise) => {
    const child = spawn("docker", args, { timeout: 30_000 });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", (error: Error) => resolvePromise(`ERROR ${error.message}`));
    child.on("close", (code: number | null) => resolvePromise(`exit=${code ?? "signal"}\n${out.slice(0, 8000)}`));
  });
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "xtiandos_status": {
      const health = await api("/health");
      return JSON.stringify(health, null, 2);
    }

    case "xtiandos_brain_search": {
      const q = encodeURIComponent(String(args.query ?? ""));
      const hits = await api(`/api/memory/search?q=${q}`);
      return JSON.stringify(hits, null, 2);
    }

    case "xtiandos_brain_read": {
      const p = encodeURIComponent(String(args.path ?? ""));
      const result = await api(`/api/brain/file?path=${p}`);
      return JSON.stringify(result, null, 2);
    }

    case "xtiandos_brain_write": {
      const result = await api("/api/brain/file", {
        method: "PUT",
        body: JSON.stringify({
          path: args.path,
          content: args.content,
        }),
      });
      return JSON.stringify(result, null, 2);
    }

    case "xtiandos_brain_tree":
    case "xtiandos_vault_list": {
      const p = encodeURIComponent(String(args.path ?? args.folder ?? ""));
      const result = await api(`/api/brain/tree?path=${p}`);
      return JSON.stringify(result, null, 2);
    }

    case "xtiandos_memory_search": {
      const q = encodeURIComponent(String(args.query ?? ""));
      const hits = await api(`/api/memory/search?q=${q}`);
      return JSON.stringify(hits, null, 2);
    }

    case "xtiandos_send_message": {
      const result = await api("/api/tunnel/send", {
        method: "POST",
        body: JSON.stringify({
          from: "copilot",
          to: "mjane",
          content: args.content,
          type: args.type ?? "query",
        }),
      });
      return JSON.stringify(result, null, 2);
    }

    case "xtiandos_read_messages": {
      const agent = args.agent ? `?agent=${encodeURIComponent(String(args.agent))}` : "";
      const messages = await api(`/api/tunnel/messages${agent}`);
      return JSON.stringify(messages, null, 2);
    }

    case "xtiandos_chat": {
      const conversations = (await api("/api/chat")) as Array<{ id: number; title: string }>;
      let convId: number;
      if (conversations.length > 0) {
        convId = conversations[0].id;
      } else {
        const newConv = (await api("/api/chat", { method: "POST" })) as { id: number };
        convId = newConv.id;
      }
      const streamRes = await fetch(`${API}/api/chat/${convId}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: args.message,
          model: args.model ?? null,
        }),
      });
      const text = await streamRes.text();
      const events = text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => {
          try {
            return JSON.parse(l.slice(6));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const messages = events
        .filter(
          (e: Record<string, unknown>) =>
            e.type === "message" && typeof e.data === "string",
        )
        .map((e: Record<string, unknown>) => e.data);
      return messages.length > 0
        ? messages.join("\n")
        : "No response from mjane.";
    }

    case "xtiandos_conversations": {
      const convs = await api("/api/chat");
      return JSON.stringify(convs, null, 2);
    }

    case "xtiandos_shell": {
      const command = String(args["command"] ?? "");
      const cwd = String(args["cwd"] ?? process.cwd());
      if (isDestructive(command)) {
        return "BLOCKED: destructive command — requires prior human approval in the UI.";
      }
      return runShell(command, cwd);
    }

    case "xtiandos_docker": {
      return dockerAction(
        String(args["action"] ?? "list"),
        args["container"] !== undefined ? String(args["container"]) : undefined,
        Number(args["tail"] ?? 100),
      );
    }

    case "xtiandos_artifact": {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const filename = String(args["filename"] ?? "");
      const content = String(args["content"] ?? "");
      const root = VAULT || process.cwd();
      const full = path.resolve(root, filename);
      if (!full.startsWith(path.resolve(root))) {
        return "ERROR path escapes workspace";
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      return `OK wrote ${filename}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Public JSON-RPC dispatch
// ---------------------------------------------------------------------------

export interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Handle one JSON-RPC request. Returns undefined when no response is expected
 * (e.g. notifications).
 */
export async function handleRpc(msg: Record<string, unknown>): Promise<RpcResult | undefined> {
  const method = msg.method as string;
  if (!method) return { error: { code: -32600, message: "Invalid request" } };
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const isNotification = typeof msg.id !== "number" && typeof msg.id !== "string";

  switch (method) {
    case "initialize":
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      };

    case "notifications/initialized":
      return undefined;

    case "tools/list":
      return { result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await executeTool(toolName, toolArgs);
        return { result: { content: [{ type: "text", text }] } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          result: {
            content: [{ type: "text", text: `ERROR: ${message}` }],
            isError: true,
          },
        };
      }
    }

    case "resources/list":
      return { result: { resources: RESOURCES } };

    case "resources/templates/list":
      return { result: { resourceTemplates: RESOURCE_TEMPLATES } };

    case "resources/read": {
      const uri = params.uri as string;
      try {
        const result = await readResource(uri);
        return { result };
      } catch (err) {
        return {
          error: {
            code: (err as { code?: number }).code ?? -32000,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    case "resources/subscribe":
    case "resources/unsubscribe":
      return { result: {} };

    case "prompts/list":
      return { result: { prompts: PROMPTS } };

    case "prompts/get": {
      const name = params.name as string;
      const promptArgs = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return { result: buildPrompt(name, promptArgs) };
      } catch (err) {
        return {
          error: {
            code: (err as { code?: number }).code ?? -32000,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    case "roots/list":
      return {
        result: {
          roots: VAULT ? [{ uri: `file://${VAULT}`, name: "vault" }] : [],
        },
      };

    case "sampling/createMessage":
      return {
        error: { code: -32001, message: "sampling/createMessage not configured on this server" },
      };

    case "ping":
      return { result: {} };

    default:
      return isNotification
        ? undefined
        : { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export { TOOLS, RESOURCES, PROMPTS, executeTool, readResource, buildPrompt };