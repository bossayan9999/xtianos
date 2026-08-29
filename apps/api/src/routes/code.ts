import fs from "node:fs/promises";
import path from "node:path";

import { Router, type Request, type Response } from "express";

import type { BrainNode } from "@xtiand/shared";

export const codeRouter = Router();

const ROOT = path.resolve(
  process.env["XTIANDOS_CODE_ROOT"] ?? path.resolve(__dirname, "../../../../"),
);

const MAX_FILE_BYTES = 512_000;
const MAX_ENTRIES = 600;

const EXCLUDED = new Set([
  "node_modules",
  ".git",
  "dist",
  ".vite",
  ".turbo",
  "coverage",
  ".tmp",
  "artifacts",
  "vault",
  "skills-installed",
  "logs",
  ".obsidian",
  ".claude",
  ".agents",
  ".opencode",
  "graphify-out",
  "Wisdio",
  "omni-root",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".avif",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".db", ".sqlite", ".sqlite3", ".db-shm", ".db-wal",
  ".zip", ".gz", ".tgz", ".jar", ".exe", ".dll", ".so", ".dylib", ".bin", ".pdf",
]);

function insideCode(rel: string): string {
  const clean = rel.replace(/^[/\\]+/, "");
  const target = path.resolve(ROOT, clean);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error("path escapes code root");
  }
  const parts = target.slice(ROOT.length).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith(".env")) throw new Error("secrets are not browsable");
    if (EXCLUDED.has(part)) throw new Error("path excluded");
  }
  return target;
}

codeRouter.get("/tree", async (_req: Request, res: Response): Promise<void> => {
  const rel = typeof _req.query["path"] === "string" ? _req.query["path"] : "";
  const dir = insideCode(rel);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nodes: BrainNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDED.has(entry.name)) continue;
    if (entry.name.endsWith(".env")) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    if (nodes.length >= MAX_ENTRIES) break;
    nodes.push({
      name: entry.name,
      path: path.posix.join(rel.replace(/\\/g, "/"), entry.name),
      isDir: entry.isDirectory(),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  res.json(nodes);
});

codeRouter.get("/file", async (req: Request, res: Response): Promise<void> => {
  const rel = typeof req.query["path"] === "string" ? req.query["path"] : "";
  if (rel.length === 0) {
    res.status(400).json({ error: "path required" });
    return;
  }
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) {
    res.status(415).json({ error: "binary file" });
    return;
  }
  let target: string;
  try {
    target = insideCode(rel);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "bad path" });
    return;
  }
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || stat.isDirectory()) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (stat.size > MAX_FILE_BYTES) {
    res.status(413).json({ error: `file too large (${stat.size} bytes)` });
    return;
  }
  const content = await fs.readFile(target, "utf8").catch(() => null);
  if (content === null) {
    res.status(404).json({ error: "unreadable" });
    return;
  }
  res.json({ path: rel, content });
});