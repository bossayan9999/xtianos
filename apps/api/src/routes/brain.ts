import fs from "node:fs/promises";
import path from "node:path";

import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { env } from "../lib/env";
import { reindexVault } from "../services/memory";
import { ingestRepoToBrain } from "../services/ingest";
import type { BrainNode } from "@xtiand/shared";

export const brainRouter = Router();

function insideVault(relative: string): string {
  const target = path.resolve(env.vaultPath, relative);
  if (!target.startsWith(path.resolve(env.vaultPath))) {
    throw new Error("path escapes vault");
  }
  return target;
}

brainRouter.get("/tree", async (req: Request, res: Response): Promise<void> => {
  const rel = typeof req.query["path"] === "string" ? req.query["path"] : "";
  const dir = insideVault(rel);
  await fs.mkdir(env.vaultPath, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nodes: BrainNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
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

brainRouter.get("/file", async (req, res): Promise<void> => {
  const rel = typeof req.query["path"] === "string" ? req.query["path"] : "";
  if (rel.length === 0) {
    res.status(400).json({ error: "path required" });
    return;
  }
  const content = await fs.readFile(insideVault(rel), "utf8").catch(() => null);
  if (content === null) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ path: rel, content });
});

brainRouter.put("/file", async (req, res): Promise<void> => {
  const rel = typeof req.body?.["path"] === "string" ? req.body["path"] : "";
  const content = typeof req.body?.["content"] === "string" ? req.body["content"] : null;
  if (rel.length === 0 || content === null) {
    res.status(400).json({ error: "path and content required" });
    return;
  }
  const full = insideVault(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  await audit("brain:write", rel);
  void reindexVault(env.vaultPath).catch(() => undefined);
  res.json({ ok: true });
});

brainRouter.delete("/file", async (req, res): Promise<void> => {
  const rel = typeof req.query["path"] === "string" ? req.query["path"] : "";
  if (rel.length === 0) {
    res.status(400).json({ error: "path required" });
    return;
  }
  await fs.rm(insideVault(rel), { force: true });
  await audit("brain:delete", rel);
  res.json({ ok: true });
});

/** Move/rename a vault file (used by the organizer + manual tidy-up). */
brainRouter.post("/move", async (req, res): Promise<void> => {
  const from = typeof req.body?.["from"] === "string" ? req.body["from"] : "";
  const to = typeof req.body?.["to"] === "string" ? req.body["to"] : "";
  if (from.length === 0 || to.length === 0) {
    res.status(400).json({ error: "from and to required" });
    return;
  }
  const src = insideVault(from);
  const dst = insideVault(to);
  if (src === dst) {
    res.status(400).json({ error: "from and to are the same path" });
    return;
  }
  if ((await fs.stat(src).catch(() => null)) === null) {
    res.status(404).json({ error: `not found: ${from}` });
    return;
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    await audit("brain:move", `${from} -> ${to}`);
    void reindexVault(env.vaultPath).catch(() => undefined);
    res.json({ ok: true });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Clean report: orphans (unlinked), oversized notes, stale notes. */
brainRouter.get("/clean-report", async (_req, res): Promise<void> => {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) files.push(path.relative(env.vaultPath, full));
    }
  }
  await fs.mkdir(env.vaultPath, { recursive: true });
  await walk(env.vaultPath);

  const linked = new Set<string>();
  const contents = new Map<string, string>();
  for (const file of files) {
    const content = await fs.readFile(path.join(env.vaultPath, file), "utf8").catch(() => "");
    contents.set(file, content);
    for (const match of content.matchAll(/\[\[([^\]|#]+)/g)) {
      linked.add(`${match[1].trim()}.md`);
      linked.add(match[1].trim());
    }
  }
  const orphans = files.filter(
    (f) =>
      !linked.has(f) &&
      !linked.has(f.replace(/\.md$/, "")) &&
      !["Welcome.md"].includes(f),
  );
  const empty = [...contents.entries()].filter(([, c]) => c.trim().length < 20).map(([f]) => f);
  const staleThreshold = Date.now() - 90 * 86_400_000;
  const stale: string[] = [];
  for (const file of files) {
    const stat = await fs.stat(path.join(env.vaultPath, file)).catch(() => null);
    if (stat && stat.mtimeMs < staleThreshold) stale.push(file);
  }
  res.json({ totalNotes: files.length, orphans, empty, stale: stale.slice(0, 50) });
});

brainRouter.post("/ingest-github", async (req, res): Promise<void> => {
  const url = typeof req.body?.["url"] === "string" ? req.body["url"].trim() : "";
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    const result = await ingestRepoToBrain(url, env.vaultPath);
    await audit("brain:ingest-github", `${result.repo} (${result.notes} notes)`);
    const chunks = await reindexVault(env.vaultPath);
    res.json({ ...result, indexedChunks: chunks });
  } catch (error: unknown) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

brainRouter.post("/reindex", async (_req, res): Promise<void> => {
  await fs.mkdir(env.vaultPath, { recursive: true });
  const count = await reindexVault(env.vaultPath);
  res.json({ indexed: count });
});
