import { prisma } from '../lib/db';
import {
  hashEmbed,
  cosine,
  keywordScore,
  chunkText,
} from '@xtiand/mjane-core';
import { getCachedMemorySearch, cacheMemorySearch, invalidateMemoryCache } from './cache';

export interface MemorySearchHit {
  source: string;
  path: string | null;
  content: string;
  score: number;
}

export async function searchMemoryEnhanced(
  query: string,
  options: { limit?: number; useCache?: boolean } = {},
): Promise<MemorySearchHit[]> {
  const { limit = 10, useCache = true } = options;

  // Check cache first
  if (useCache) {
    const cached = await getCachedMemorySearch(query);
    if (cached) {
      return cached as MemorySearchHit[];
    }
  }

  // Retrieve all memory chunks
  const chunks = await prisma.memoryChunk.findMany();
  const queryEmbed = await hashEmbed(query);
  const queryEmbedVec = queryEmbed.split(',').map((x) => Number.parseFloat(x));

  // Score all chunks
  const scored = chunks.map((chunk) => {
    const chunkEmbedVec = JSON.parse(chunk.embeddingJson) as number[];
    const cosineSim = cosine(queryEmbedVec, chunkEmbedVec);
    const kwScore = keywordScore(query, chunk.content);
    const recencyDecay = Math.exp(-((Date.now() - chunk.createdAt.getTime()) / (30 * 24 * 60 * 60 * 1000)));
    const finalScore = cosineSim * 0.5 + kwScore * 0.4 + recencyDecay * 0.1;

    return {
      ...chunk,
      score: finalScore,
    };
  });

  // Sort and limit
  const hits = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((chunk) => ({
      source: chunk.source,
      path: chunk.path,
      content: chunk.content,
      score: chunk.score,
    }));

  // Cache results
  if (useCache) {
    await cacheMemorySearch(query, hits);
  }

  return hits;
}

export async function indexConversationEnhanced(
  conversationId: number,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  const source = `conversation:${conversationId}`;
  const text = messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
  const chunks = chunkText(text, { size: 500, overlap: 100 });

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await hashEmbed(chunks[i]);
    await prisma.memoryChunk.create({
      data: {
        source,
        path: `turn_${i}`,
        chunkIndex: i,
        content: chunks[i],
        embeddingJson: embedding,
      },
    });
  }

  // Invalidate cache for this conversation
  await invalidateMemoryCache(source);
}

export async function reindexVault(vaultPath: string): Promise<{ indexed: number; errors: number }> {
  let indexed = 0;
  let errors = 0;

  try {
    const { promises: fsp } = await import('node:fs');
    const files = await fsp.readdir(vaultPath, { recursive: true });

    for (const file of files) {
      if (typeof file !== 'string' || !file.endsWith('.md')) continue;
      try {
        const filePath = `${vaultPath}/${file}`;
        const content = await fsp.readFile(filePath, 'utf-8');
        const chunks = chunkText(content, { size: 800, overlap: 200 });

        for (let i = 0; i < chunks.length; i++) {
          const embedding = await hashEmbed(chunks[i]);
          await prisma.memoryChunk.upsert({
            where: {
              id: 0, // Placeholder
            },
            create: {
              source: 'vault',
              path: file,
              chunkIndex: i,
              content: chunks[i],
              embeddingJson: embedding,
            },
            update: {
              content: chunks[i],
              embeddingJson: embedding,
            },
          });
        }
        indexed += chunks.length;
      } catch (err) {
        console.error(`Failed to index ${file}:`, err);
        errors++;
      }
    }
  } catch (err) {
    console.error('Vault reindex failed:', err);
    errors++;
  }

  await invalidateMemoryCache('vault');
  return { indexed, errors };
}
