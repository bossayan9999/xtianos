import fs from "node:fs/promises";
import path from "node:path";

import type { McpServerConfig } from "@xtiand/shared";

import { prisma } from "../lib/db";

export interface McpConfigFileEntry {
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string | string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpConfigFileEntry>;
}

export function parseMcpConfig(content: string): McpConfigFile {
  const raw = JSON.parse(content) as Partial<McpConfigFile>;
  if (!raw.mcpServers || typeof raw.mcpServers !== "object") {
    throw new Error("mcp.json must have a top-level `mcpServers` map");
  }
  return { mcpServers: raw.mcpServers };
}

export function defaultMcpConfigPath(root: string): string {
  return path.join(root, "mcp.json");
}

/** Read `mcp.json` (claude_desktop_config.json-compatible format). */
export async function readMcpConfigFile(root: string): Promise<McpConfigFile> {
  const content = await fs
    .readFile(defaultMcpConfigPath(root), "utf8")
    .catch(() => "");
  if (!content.trim()) return { mcpServers: {} };
  return parseMcpConfig(content);
}

/** Convert the file format into DB rows (id assigned by caller). */
export function mcpConfigRowsToDto(
  config: McpConfigFile,
  makeId: (index: number) => number,
): McpServerConfig[] {
  const rows: McpServerConfig[] = [];
  let index = 0;
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
    const transport = entry.transport ?? (entry.url ? "http" : "stdio");
    const args = Array.isArray(entry.args) ? entry.args.join(" ") : (entry.args ?? "");
    rows.push({
      id: makeId(index),
      name,
      transport,
      command: entry.command ?? "",
      args,
      envJson: JSON.stringify(entry.env ?? {}),
      url: entry.url ?? "",
      headersJson: JSON.stringify(entry.headers ?? {}),
      oauth: entry.url && !entry.headers ? "linking" : "none",
      enabled: entry.enabled ?? true,
    });
    index += 1;
  }
  return rows;
}

/**
 * Sync servers from `mcp.json` (at repo root or WORKSPACE_DIR) into the DB.
 * Servers defined in the file are upserted by name; ones no longer present are
 * left alone (they may be user-created). Returns the created/updated count.
 */
export async function syncMcpConfigFromFile(root: string): Promise<{ added: number; updated: number }> {
  const config = await readMcpConfigFile(root);
  const entries = Object.entries(config.mcpServers ?? {});
  let added = 0;
  let updated = 0;
  for (const [name, entry] of entries) {
    const existing = await prisma.mcpServer
      .findFirst({ where: { name } })
      .catch(() => null);
    const data = {
      transport: entry.transport ?? (entry.url ? "http" : "stdio"),
      command: entry.command ?? "",
      args: Array.isArray(entry.args) ? entry.args.join(" ") : (entry.args ?? ""),
      envJson: JSON.stringify(entry.env ?? {}),
      url: entry.url ?? "",
      headersJson: JSON.stringify(entry.headers ?? {}),
      enabled: entry.enabled ?? true,
    };
    if (existing) {
      await prisma.mcpServer.update({ where: { id: existing.id }, data }).catch(() => undefined);
      updated += 1;
    } else {
      await prisma.mcpServer.create({ data: { name, ...data } }).catch(() => undefined);
      added += 1;
    }
  }
  return { added, updated };
}