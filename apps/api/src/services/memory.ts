import fs from "node:fs/promises";
import path from "node:path";

import { chunkText, cosine, hashEmbed, keywordScore } from "@xtiand/mjane-core";

import { prisma } from "../lib/db";
import {
  annReady,
  currentVecDim,
  dropVectorIndex,
  ensureVecTable,
  pruneStaleVectors,
  rebuildVectorIndex,
  searchVectors,
  upsertVector,
  vectorCount,
} from "../lib/vec";
import { activeEmbedder, embedBatchWithFallback } from "./embedding";

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

interface ChunkRow {
  source: string;
  path: string | null;
  chunkIndex: number;
  content: string;
}

/**
 * Embed a list of chunks via the active embedder (real provider when
 * configured, feature-hash otherwise), insert them into MemoryChunk and the
 * ANN index, then drop stale vectors. Returns the number of chunks inserted.
 */
async function storeChunks(chunks: ChunkRow[]): Promise<number> {
  if (chunks.length === 0) return 0;
  const texts = chunks.map((c) => c.content);
  const { vectors } = await embedBatchWithFallback(texts);
  let dimOk = false;
  try {
    const dim = activeEmbedder().dim;
    if (dim !== currentVecDim()) dropVectorIndex();
    ensureVecTable(dim);
    dimOk = true;
  } catch {
    dimOk = false;
  }
  let inserted = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const vec = vectors[i] ?? Float32Array.from(hashEmbed(chunks[i]!.content));
    const row = await prisma.memoryChunk.create({
      data: {
        source: chunks[i]!.source,
        path: chunks[i]!.path,
        chunkIndex: chunks[i]!.chunkIndex,
        content: chunks[i]!.content,
        embeddingJson: JSON.stringify(Array.from(vec)),
      },
    });
    inserted += 1;
    if (dimOk) {
      try {
        upsertVector(row.id, vec);
      } catch {
        /* ANN write must never break indexing */
      }
    }
  }
  if (dimOk) pruneStaleVectors();
  invalidateMemoryIndex();
  return inserted;
}

/** Rebuilds the semantic index of the vault (chunk + embed every file). */
export async function reindexVault(vaultPath: string): Promise<number> {
  const relFiles: string[] = [];
  await walk(vaultPath, vaultPath, relFiles);
  invalidateMemoryIndex();
  await prisma.memoryChunk.deleteMany({ where: { source: "vault" } });

  let count = 0;
  const batch: ChunkRow[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    count += await storeChunks(batch.splice(0));
  };

  for (const rel of relFiles) {
    const full = path.join(vaultPath, rel);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > 400_000) continue;
    const content = await fs.readFile(full, "utf8").catch(() => "");
    const sub = chunkText(content);
    for (let i = 0; i < sub.length; i += 1) {
      batch.push({ source: "vault", path: rel, chunkIndex: i, content: sub[i]! });
    }
    if (batch.length >= 200) await flush();
  }
  await flush();
  if (vectorCount() === 0) {
    // no vectors went into the ANN table — rebuild from what we persisted
    await rebuildVectorIndex().catch(() => undefined);
  }
  invalidateMemoryIndex();
  return count;
}

export interface MemoryHit {
  id: number;
  path: string | null;
  content: string;
  score: number;
}

interface MemoryIndexEntry {
  id: number;
  source: string;
  path: string | null;
  content: string;
  vector: Float32Array;
  createdMs: number;
}

let cachedIndex: MemoryIndexEntry[] | null = null;
let loadingIndex: Promise<MemoryIndexEntry[]> | null = null;

/**
 * Lazy in-memory index of the most recent 3000 memory chunks. Only used when
 * the ANN table is unavailable/empty — the fast path searches vec0 directly.
 */
async function memoryIndex(): Promise<MemoryIndexEntry[]> {
  if (cachedIndex !== null) return cachedIndex;
  if (loadingIndex !== null) return loadingIndex;
  loadingIndex = (async () => {
    const rows = await prisma.memoryChunk.findMany({
      select: { id: true, source: true, path: true, content: true, embeddingJson: true, createdAt: true },
      orderBy: { id: "desc" },
      take: 3000,
    });
    const entries = rows.map((row) => {
      let vec: number[] = [];
      try {
        vec = JSON.parse(row.embeddingJson) as number[];
      } catch {
        vec = [];
      }
      return {
        id: row.id,
        source: row.source,
        path: row.path,
        content: row.content,
        vector:
          vec.length > 0
            ? Float32Array.from(vec)
            : Float32Array.from(hashEmbed(row.content)),
        createdMs: row.createdAt.getTime(),
      };
    });
    cachedIndex = entries;
    loadingIndex = null;
    return entries;
  })();
  return loadingIndex;
}

/** Drop the cached index after any write so the next search sees fresh rows. */
export function invalidateMemoryIndex(): void {
  cachedIndex = null;
  loadingIndex = null;
}

// Warm the index in the background at startup so the first chat turn doesn't
// pay the initial load + embed-parse cost.
void memoryIndex().catch(() => undefined);

/** Hybrid retrieval: vector similarity (ANN) + keyword overlap + recency. */
export async function searchMemory(
  query: string,
  opts: { source?: string; limit?: number } = {},
): Promise<MemoryHit[]> {
  const limit = opts.limit ?? 6;
  const queryEmbed = await embedQuery(query);

  // Fast path: ANN over the vec0 table.
  if (annReady(queryEmbed.length)) {
    const approx = searchVectors(queryEmbed, limit * 4);
    if (approx.length > 0) {
      const ids = approx.map((a) => a.id);
      const rows = await prisma.memoryChunk.findMany({
        where: { id: { in: ids } },
        select: { id: true, source: true, path: true, content: true, createdAt: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const scored = approx
        .map((a) => {
          const row = byId.get(a.id);
          if (!row) return null;
          if (opts.source && row.source !== opts.source) return null;
          const kwScore = keywordScore(query, row.content);
          const ageDays = (Date.now() - row.createdAt.getTime()) / 86_400_000;
          const recency = Math.exp(-ageDays / 30);
          return {
            id: row.id,
            path: row.path,
            content: row.content.slice(0, 600),
            score: a.similarity * 0.5 + kwScore * 0.4 + recency * 0.1,
          };
        })
        .filter((x): x is MemoryHit => x !== null);
      scored.sort((a, b) => b.score - a.score);
      return scored.filter((hit) => hit.score > 0.05).slice(0, limit);
    }
  }

  // Fallback: brute-force cosine over the in-memory index.
  const entries = await memoryIndex();
  const base = opts.source ? entries.filter((e) => e.source === opts.source) : entries;
  const scored = base.map((entry) => {
    const vecScore = entry.vector.length > 0 ? cosine(queryEmbed, entry.vector) : 0;
    const kwScore = keywordScore(query, entry.content);
    const ageDays = (Date.now() - entry.createdMs) / 86_400_000;
    const recency = Math.exp(-ageDays / 30);
    return {
      id: entry.id,
      path: entry.path,
      content: entry.content.slice(0, 600),
      score: vecScore * 0.5 + kwScore * 0.4 + recency * 0.1,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((hit) => hit.score > 0.05).slice(0, limit);
}

/** Embed a single query string with the active embedder (hash fallback). */
async function embedQuery(text: string): Promise<Float32Array> {
  const embedder = activeEmbedder();
  if (embedder.dim === 256) return Float32Array.from(hashEmbed(text));
  try {
    const got = await embedQueryProvider(text);
    return got ?? Float32Array.from(hashEmbed(text));
  } catch {
    return Float32Array.from(hashEmbed(text));
  }
}

async function embedQueryProvider(text: string): Promise<Float32Array | null> {
  const { env } = await import("../lib/env");
  const { embed } = await import("@xtiand/mjane-core");
  const vectors = await embed(env.embeddingsBaseUrl, env.embeddingsApiKey, [text]);
  return vectors && vectors.length === 1 ? Float32Array.from(vectors[0]!) : null;
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
  invalidateMemoryIndex();
  await prisma.memoryChunk.deleteMany({ where: { source: "conversation", path: relPath } });

  const sub = chunkText(transcript).filter((c) => c.trim().length >= 40);
  if (sub.length === 0) return 0;
  const count = await storeChunks(
    sub.map((content, chunkIndex) => ({
      source: "conversation",
      path: relPath,
      chunkIndex,
      content,
    })),
  );
  invalidateMemoryIndex();
  return count;
}

/** Remove the whole memory index (vault + conversations) and its ANN table. */
export async function clearMemory(): Promise<void> {
  invalidateMemoryIndex();
  await prisma.memoryChunk.deleteMany({});
  dropVectorIndex();
}

/** Number of vectors in the ANN table (0 = table missing/empty). */
export function annVectorCount(): number {
  return vectorCount();
}