import fs from "node:fs/promises";
import path from "node:path";

import { prisma } from "../lib/db";
import { chunkText, cosine, hashEmbed, keywordScore } from "@xtiand/mjane-core";

const CODE_RE = /\.(md|txt|json|ts|js|mjs|py|sh|ya?ml)$/i;

async function walk(dir: string, base: string, out: string[], limit = 500): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out, limit);
    else if (CODE_RE.test(entry.name)) out.push(path.relative(base, full));
  }
}

/** Rebuilds the semantic index of the vault (chunk + embed every file). */
export async function reindexVault(vaultPath: string): Promise<number> {
  const relFiles: string[] = [];
  await walk(vaultPath, vaultPath, relFiles);
  await prisma.memoryChunk.deleteMany({ where: { source: "vault" } });

  let count = 0;
  const batch: {
    source: string;
    path: string;
    chunkIndex: number;
    content: string;
    embeddingJson: string;
  }[] = [];

  for (const rel of relFiles) {
    const full = path.join(vaultPath, rel);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > 400_000) continue;
    const content = await fs.readFile(full, "utf8").catch(() => "");
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i += 1) {
      batch.push({
        source: "vault",
        path: rel,
        chunkIndex: i,
        content: chunks[i],
        embeddingJson: JSON.stringify(hashEmbed(chunks[i])),
      });
      count += 1;
    }
    if (batch.length >= 200) {
      await prisma.memoryChunk.createMany({ data: batch.splice(0) });
    }
  }
  if (batch.length > 0) await prisma.memoryChunk.createMany({ data: batch });
  return count;
}

export interface MemoryHit {
  id: number;
  path: string | null;
  content: string;
  score: number;
}

/** Hybrid retrieval: vector cosine (60%) + keyword overlap (40%). */
export async function searchMemory(
  query: string,
  opts: { source?: string; limit?: number } = {},
): Promise<MemoryHit[]> {
  const limit = opts.limit ?? 6;
  const queryVec = hashEmbed(query);
  const rows = await prisma.memoryChunk.findMany({
    where: opts.source ? { source: opts.source } : undefined,
    orderBy: { id: "desc" },
    take: 3000,
  });
  const scored = rows.map((row) => {
    let vector: number[] = [];
    try {
      vector = JSON.parse(row.embeddingJson) as number[];
    } catch {
      vector = [];
    }
    const vecScore = vector.length > 0 ? cosine(queryVec, vector) : 0;
    const kwScore = keywordScore(query, row.content);
    const ageDays = (Date.now() - row.createdAt.getTime()) / 86_400_000;
    const recency = Math.exp(-ageDays / 30);
    return {
      id: row.id,
      path: row.path,
      content: row.content.slice(0, 600),
      score: vecScore * 0.5 + kwScore * 0.4 + recency * 0.1,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((hit) => hit.score > 0.05).slice(0, limit);
}

/**
 * Indexes a conversation transcript into long-term memory so mjane recalls
 * past chats via searchMemory. Re-indexing a conversation replaces its chunks.
 */
export async function indexConversation(
  conversationId: number,
  turns: { role: string; content: string }[],
): Promise<number> {
  const transcript = turns
    .filter((t) => t.content.trim().length > 0)
    .map((t) => `${t.role === "user" ? "User" : "mjane"}: ${t.content}`)
    .join("\n\n");
  if (transcript.trim().length < 60) return 0;

  const relPath = `conversations/${conversationId}`;
  await prisma.memoryChunk.deleteMany({ where: { source: "conversation", path: relPath } });

  const chunks = chunkText(transcript).filter((c) => c.trim().length >= 40);
  if (chunks.length === 0) return 0;
  await prisma.memoryChunk.createMany({
    data: chunks.map((content, chunkIndex) => ({
      source: "conversation",
      path: relPath,
      chunkIndex,
      content,
      embeddingJson: JSON.stringify(hashEmbed(content)),
    })),
  });
  return chunks.length;
}
