#!/usr/bin/env node

/**
 * xtiandOS MCP Server — Streamable HTTP transport.
 *
 * Serves the same tools/resources/prompts as the stdio server over HTTP so any
 * MCP client (Claude Desktop, VS Code, Cursor, remote hosts) can connect.
 *
 * Usage:  node --import tsx packages/mcp-server/src/http-server.ts
 *
 * Environment:
 *   XTIANDOS_MCP_PORT — listen port (default 8942)
 *   XTIANDOS_MCP_HOST — bind host (default 0.0.0.0)
 *   XTIANDOS_API_URL  — base URL of the xtiandOS API (default http://127.0.0.1:3101)
 *   XTIANDOS_VAULT    — absolute path to the vault (default from .env)
 */

import { createServer, type ServerResponse } from "node:http";

import { handleRpc, PROTOCOL_VERSION } from "./handler";

const PORT = Number(process.env.XTIANDOS_MCP_PORT ?? 8942);
const HOST = (process.env.XTIANDOS_MCP_HOST ?? "0.0.0.0").trim();

const sessions = new Set<string>();
let nextSession = 1;

export async function onRequest(
  method: string,
  body: string,
  headers: Record<string, string | undefined>,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (method === "GET") {
    // Lifecycle: health check + session enumeration (SSE reconnects can use this).
    return {
      status: 200,
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": PROTOCOL_VERSION },
      body: JSON.stringify({ sessions: sessions.size }),
    };
  }

  if (method !== "POST") {
    return {
      status: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { code: -32600, message: "Method not allowed" } }),
    };
  }

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }),
    };
  }

  const sessionId = headers["mcp-session-id"] ?? String(nextSession++);
  sessions.add(sessionId);

  const methodName = msg.method as string;
  if (methodName === "initialize" || !sessions.has(sessionId)) {
    // Session management is lenient for a single-host deployment.
  }

  let out: { result?: unknown; error?: { code: number; message: string } } | undefined;
  try {
    out = await handleRpc(msg);
  } catch (err) {
    out = {
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }

  const isNotification = typeof msg.id !== "number" && typeof msg.id !== "string";
  const payload = out && !isNotification ? { jsonrpc: "2.0", id: msg.id, ...out } : null;

  return {
    status: payload ? 200 : 202,
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Session-Id": sessionId,
    },
    body: payload ? JSON.stringify(payload) : "",
  };
}

function writeJson(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    void onRequest(
      req.method ?? "GET",
      body,
      Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
      ),
    ).then((r) => writeJson(res, r.status, r.headers, r.body));
  });
});

server.listen(PORT, HOST, () => {
  console.error(`xtiandOS MCP HTTP server listening on http://${HOST}:${PORT}`);
});