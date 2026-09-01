import { spawn } from "node:child_process";

export type McpTransportType = "stdio" | "http" | "sse";

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpServerSpec {
  command: string;
  args?: string[];
  envJson?: string;
  url?: string;
  headersJson?: string;
  transport?: McpTransportType;
}

export interface McpClientLike {
  readonly tools: Map<string, McpToolInfo>;
  readonly resources: Map<string, McpResourceInfo>;
  readonly prompts: Map<string, McpPromptInfo>;
  connect(spec: McpServerSpec): Promise<McpToolInfo[]>;
  call(name: string, argsJson: string): Promise<string>;
  listResources(): Promise<McpResourceInfo[]>;
  readResource(uri: string): Promise<string>;
  listPrompts(): Promise<McpPromptInfo[]>;
  getPrompt(name: string, argsJson: string): Promise<string>;
  dispose(): void;
}

interface McpResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

export class McpStdioClient implements McpClientLike {
  private nextId = 1;
  private readonly pending = new Map<number, (value: McpResponse) => void>();
  private buffer = "";
  private child: ReturnType<typeof spawn> | null = null;
  readonly tools = new Map<string, McpToolInfo>();
  readonly resources = new Map<string, McpResourceInfo>();
  readonly prompts = new Map<string, McpPromptInfo>();

  async connect(spec: McpServerSpec, _extra?: unknown): Promise<McpToolInfo[]> {
    const args = spec.args ?? [];
    const envJson = spec.envJson ?? "{}";
    await this.startChild(spec.command, args, envJson);
    const init = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
        clientInfo: { name: "xtiandOS", version: "0.1.0" },
      },
    };
    const initRes = await this.request(init);
    if (initRes.error) throw new Error(`MCP initialize failed: ${initRes.error.message}`);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    await this.refreshTools();
    await this.refreshResources();
    await this.refreshPrompts();
    return [...this.tools.values()];
  }

  async call(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return "ERROR invalid JSON arguments";
    }
    const res = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (res.error) return `ERROR ${res.error.message}`;
    const resResult = res.result as
      | { content?: { type?: string; text?: string; data?: string; mimeType?: string }[] }
      | undefined;
    const content = resResult?.content ?? [];
    return content
      .map((c) => {
        if (c.type === "image" && typeof c.data === "string") {
          const mime = typeof c.mimeType === "string" && /^image\//.test(c.mimeType) ? c.mimeType : "image/png";
          return `data:${mime};base64,${c.data}`;
        }
        if (c.type === "text") return c.text ?? "";
        if (typeof c.text === "string") return c.text;
        return JSON.stringify(c);
      })
      .join("\n")
      .trim() || "OK";
  }

  async listResources(): Promise<McpResourceInfo[]> {
    await this.refreshResources();
    return [...this.resources.values()];
  }

  async readResource(uri: string): Promise<string> {
    const res = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "resources/read",
      params: { uri },
    });
    if (res.error) return `ERROR ${res.error.message}`;
    const contents = (res.result as { contents?: { text?: string }[] })?.contents ?? [];
    return contents.map((c) => c.text ?? "").join("\n");
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    await this.refreshPrompts();
    return [...this.prompts.values()];
  }

  async getPrompt(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return "ERROR invalid JSON arguments";
    }
    const res = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "prompts/get",
      params: { name, arguments: args },
    });
    if (res.error) return `ERROR ${res.error.message}`;
    const messages = (res.result as { messages?: { role?: string; content?: unknown }[] })?.messages ?? [];
    return JSON.stringify(messages, null, 2);
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
  }

  private async refreshTools(): Promise<void> {
    const listRes = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
      params: {},
    });
    const result = listRes.result as { tools?: { name: string; description?: string }[] } | undefined;
    this.tools.clear();
    for (const tool of result?.tools ?? []) {
      this.tools.set(tool.name, { name: tool.name, description: tool.description ?? "" });
    }
  }

  private async refreshResources(): Promise<void> {
    const listRes = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "resources/list",
      params: {},
    });
    const result = listRes.result as { resources?: McpResourceInfo[] } | undefined;
    this.resources.clear();
    for (const r of result?.resources ?? []) {
      this.resources.set(r.uri, r);
    }
  }

  private async refreshPrompts(): Promise<void> {
    const listRes = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "prompts/list",
      params: {},
    });
    const result = listRes.result as { prompts?: McpPromptInfo[] } | undefined;
    this.prompts.clear();
    for (const p of result?.prompts ?? []) {
      this.prompts.set(p.name, p);
    }
  }

  private send(msg: object): void {
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private request(msg: object): Promise<McpResponse> {
    const id = (msg as { id: number }).id;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error("MCP request timeout"));
      }, 15_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      });
      this.send(msg);
    });
  }

  private startChild(command: string, args: string[], envJson: string): Promise<void> {
    let extraEnv: Record<string, string> = {};
    try {
      extraEnv = JSON.parse(envJson || "{}") as Record<string, string>;
    } catch {
      extraEnv = {};
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.child = spawn(command, args, {
        env: { ...process.env, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
        // Windows can't spawn .cmd/.bat shims without a shell, and passing an
        // absolute path with spaces as the command breaks under the shell.
        // Spawn the bare command through cmd.exe on Windows so it resolves the
        // shim (e.g. npx.cmd) from PATH itself. Other platforms are unchanged.
        shell: process.platform === "win32",
      });
      this.child.stdout?.setEncoding("utf8");
      this.child.stdout?.on("data", (chunk: string) => {
        this.buffer += chunk;
        let idx = this.buffer.indexOf("\n");
        while (idx >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line.length > 0) {
            try {
              const msg = JSON.parse(line) as McpResponse;
              if (typeof msg.id === "number") {
                this.pending.get(msg.id)?.(msg);
                this.pending.delete(msg.id);
              }
            } catch {
              // ignore non-JSON lines
            }
          }
          idx = this.buffer.indexOf("\n");
        }
      });
      this.child.stderr?.on("data", () => undefined);
      this.child.on("error", rejectPromise);
      setTimeout(resolvePromise, process.platform === "win32" ? 3000 : 300);
    });
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport
// ---------------------------------------------------------------------------

interface HttpSessionState {
  sessionId: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: {
    tools?: unknown;
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: unknown;
  };
}

/**
 * MCP client over Streamable HTTP (POST JSON-RPC). Tracks the server-provided
 * session id so subsequent calls stay on the same server session.
 */
export class McpHttpClient implements McpClientLike {
  private nextId = 1;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private state: HttpSessionState | null = null;
  readonly tools = new Map<string, McpToolInfo>();
  readonly resources = new Map<string, McpResourceInfo>();
  readonly prompts = new Map<string, McpPromptInfo>();

  constructor(spec: McpServerSpec) {
    if (!spec.url) throw new Error("http transport requires a url");
    this.baseUrl = spec.url.replace(/\/+$/, "");
    try {
      this.headers = JSON.parse(spec.headersJson || "{}") as Record<string, string>;
    } catch {
      this.headers = {};
    }
  }

  async connect(_spec: McpServerSpec): Promise<McpToolInfo[]> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
        clientInfo: { name: "xtiandOS", version: "0.1.0" },
      },
    });
    if (!res.ok) throw new Error(`MCP HTTP initialize failed: HTTP ${res.status}`);
    const result = (res.json as { result?: { serverInfo?: { name?: string }; capabilities?: HttpSessionState["capabilities"] } }).result ?? {};
    const sessionId = res.sessionId;
    this.state = {
      sessionId,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
    };
    if (sessionId) void this.post({ jsonrpc: "2.0", method: "notifications/initialized" });

    await this.refreshTools();
    await this.refreshResources();
    await this.refreshPrompts();
    return [...this.tools.values()];
  }

  async call(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return "ERROR invalid JSON arguments";
    }
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (!res.ok) return `ERROR HTTP ${res.status}`;
    const r = res.json as {
      result?: { isError?: boolean; content?: { type?: string; text?: string; data?: string; mimeType?: string }[] };
      error?: { message?: string };
    };
    if (r.error?.message) return `ERROR ${r.error.message}`;
    const content = r.result?.content ?? [];
    return content
      .map((c) => {
        if (c.type === "image" && typeof c.data === "string") {
          const mime = typeof c.mimeType === "string" && /^image\//.test(c.mimeType) ? c.mimeType : "image/png";
          return `data:${mime};base64,${c.data}`;
        }
        return typeof c.text === "string" ? c.text : JSON.stringify(c);
      })
      .join("\n") || "OK";
  }

  async listResources(): Promise<McpResourceInfo[]> {
    await this.refreshResources();
    return [...this.resources.values()];
  }

  async readResource(uri: string): Promise<string> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "resources/read",
      params: { uri },
    });
    if (!res.ok) return `ERROR HTTP ${res.status}`;
    const r = res.json as { result?: { contents?: { text?: string }[] }; error?: { message?: string } };
    if (r.error?.message) return `ERROR ${r.error.message}`;
    return (r.result?.contents ?? []).map((c) => c.text ?? "").join("\n");
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    await this.refreshPrompts();
    return [...this.prompts.values()];
  }

  async getPrompt(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return "ERROR invalid JSON arguments";
    }
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "prompts/get",
      params: { name, arguments: args },
    });
    if (!res.ok) return `ERROR HTTP ${res.status}`;
    const r = res.json as { result?: { messages?: { role?: string; content?: unknown }[] }; error?: { message?: string } };
    if (r.error?.message) return `ERROR ${r.error.message}`;
    return JSON.stringify(r.result?.messages ?? [], null, 2);
  }

  dispose(): void {
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
    this.state = null;
  }

  private async refreshTools(): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} });
    if (!res.ok) return;
    const tools = (res.json as { result?: { tools?: McpToolInfo[] } }).result?.tools ?? [];
    this.tools.clear();
    for (const t of tools) this.tools.set(t.name, t);
  }

  private async refreshResources(): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "resources/list", params: {} });
    if (!res.ok) return;
    const resources = (res.json as { result?: { resources?: McpResourceInfo[] } }).result?.resources ?? [];
    this.resources.clear();
    for (const r of resources) this.resources.set(r.uri, r);
  }

  private async refreshPrompts(): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "prompts/list", params: {} });
    if (!res.ok) return;
    const prompts = (res.json as { result?: { prompts?: McpPromptInfo[] } }).result?.prompts ?? [];
    this.prompts.clear();
    for (const p of prompts) this.prompts.set(p.name, p);
  }

  private async post(
    body: object,
  ): Promise<{ ok: boolean; status: number; json: unknown; sessionId: string }> {
    const initHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.state?.sessionId) initHeaders["Mcp-Session-Id"] = this.state.sessionId;

    const raw = await fetch(this.baseUrl, {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const sessionId = raw.headers.get("mcp-session-id") ?? this.state?.sessionId ?? "";
    const text = await raw.text();
    let json: unknown = {};
    try {
      json = text.startsWith("{") ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { ok: raw.ok, status: raw.status, json, sessionId };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpClient(spec: McpServerSpec): McpClientLike {
  const transport = spec.transport ?? (spec.url ? "http" : "stdio");
  if (transport === "http" || transport === "sse") {
    if (!spec.url) throw new Error(`transport ${transport} requires a url`);
    return new McpHttpClient(spec);
  }
  return new McpStdioClient();
}

export type Me = McpClientLike;