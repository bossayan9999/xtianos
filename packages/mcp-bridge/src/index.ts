import { spawn } from "node:child_process";

export interface McpToolInfo {
  name: string;
  description: string;
}

interface McpResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

/** Minimal MCP stdio client (JSON-RPC over the child process pipes). */
export class McpStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, (value: McpResponse) => void>();
  private buffer = "";
  private child: ReturnType<typeof spawn> | null = null;
  readonly tools = new Map<string, McpToolInfo>();

  async connect(command: string, args: string[], envJson: string): Promise<McpToolInfo[]> {
    await this.startChild(command, args, envJson);
    const init = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "xtiandOS", version: "0.1.0" },
      },
    };
    const initRes = await this.request(init);
    if (initRes.error) throw new Error(`MCP initialize failed: ${initRes.error.message}`);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listRes = await this.request({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
      params: {},
    });
    const result = listRes.result as { tools?: { name: string; description?: string }[] } | undefined;
    for (const tool of result?.tools ?? []) {
      this.tools.set(tool.name, { name: tool.name, description: tool.description ?? "" });
    }
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
    const content = (res.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
    return content.map((c) => c.text ?? "").join("\n") || "OK";
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.tools.clear();
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
      setTimeout(resolvePromise, 300);
    });
  }
}
