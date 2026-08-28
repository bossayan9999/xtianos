#!/usr/bin/env node

/**
 * xtiandOS MCP Server — stdio JSON-RPC transport.
 *
 * Exposes xtiandOS brain, memory, chat, message-bus, shell, docker, and artifact
 * tools so Obsidian Copilot (or any MCP client) can collaborate with mjane.
 *
 * Capabilities: tools, resources (subscribe + listChanged), prompts, sampling,
 * roots, Streamable HTTP (see http-server.ts).
 *
 * Usage:  node --import tsx packages/mcp-server/src/index.ts
 *   or:   npx @xtiand/mcp-server
 *
 * Environment:
 *   XTIANDOS_API_URL  — base URL of the xtiandOS API (default http://127.0.0.1:3101)
 *   XTIANDOS_VAULT    — absolute path to the vault (default from .env)
 */

import { createInterface } from "node:readline";

import { handleRpc } from "./handler";

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleRequest(msg: Record<string, unknown>): Promise<void> {
  const isNotification = typeof msg.id !== "number" && typeof msg.id !== "string";
  try {
    const out = await handleRpc(msg);
    if (out && !isNotification) send({ jsonrpc: "2.0", id: msg.id, ...out });
  } catch (err) {
    if (!isNotification) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  try {
    const msg = JSON.parse(trimmed) as Record<string, unknown>;
    void handleRequest(msg);
  } catch {
    // ignore malformed lines
  }
});

rl.on("close", () => {
  setTimeout(() => process.exit(0), 500);
});

process.stdin.resume();