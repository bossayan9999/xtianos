/**
 * Active text-embedding strategy.
 *
 * When EMBEDDINGS_BASE_URL + EMBEDDINGS_API_KEY are set in .env, chunks are
 * embedded with a real provider (OpenAI-compatible /embeddings) which yields
 * much better retrieval quality than the local feature-hash fallback. Without
 * them, mjane falls back to hashEmbed — zero-config, works offline, but
 * coarser. All chunks share one strategy so the ANN table has a single
 * dimension (either 256 for hash or the model's real dimension).
 */

import { embed, hashEmbed } from "@xtiand/mjane-core";

import { env } from "../lib/env";

export interface Embedder {
  /** Dimension every produced vector has. */
  dim: number;
  name: string;
  /** Returns null when a real-provider call fails (caller falls back to hash). */
  embedBatch(texts: string[]): Promise<Float32Array[] | null>;
}

const CONCURRENCY = 4;
const BATCH_SIZE = 32;

class HashEmbedder implements Embedder {
  readonly dim = 256;
  readonly name = "feature-hash";
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => Float32Array.from(hashEmbed(t)));
  }
}

class ProviderEmbedder implements Embedder {
  readonly dim: number;
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    // text-embedding-3-small is the only model embed() speaks; others return 1536
    this.dim = 1536;
    this.name = this.model;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const slice = texts.slice(i, i + BATCH_SIZE);
      const vectors = await embed(this.baseUrl, this.apiKey, slice).catch(() => null);
      if (!vectors || vectors.length !== slice.length) return null;
      out.push(...vectors.map((v) => Float32Array.from(v)));
    }
    return out;
  }
}

let cached: Embedder | null = null;

/** Build (and cache) the current embedder from env/config. */
export function activeEmbedder(): Embedder {
  if (cached !== null) return cached;
  cached =
    env.embeddingsBaseUrl.length > 0 && env.embeddingsApiKey.length > 0
      ? new ProviderEmbedder(env.embeddingsBaseUrl, env.embeddingsApiKey, env.embeddingsModel)
      : new HashEmbedder();
  return cached;
}

/** Reset the cached embedder (after env reload or settings change). */
export function resetEmbedder(): void {
  cached = null;
}

/** Embed a batch with bounded concurrency, falling back to hash on provider failure. */
export async function embedBatchWithFallback(
  texts: string[],
): Promise<{ vectors: (Float32Array | null)[]; fellBack: boolean }> {
  if (texts.length === 0) return { vectors: [], fellBack: false };
  const embedder = activeEmbedder();
  if (embedder.dim === 256) {
    const vectors = await embedder.embedBatch(texts);
    return { vectors: vectors ?? [], fellBack: false };
  }
  const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
  let fellBack = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const next = cursor;
      cursor += 1;
      if (next >= texts.length) return;
      const slice = texts.slice(next, Math.min(next + BATCH_SIZE, texts.length));
      let vectors: Float32Array[] | null = null;
      try {
        const got = await embed(env.embeddingsBaseUrl, env.embeddingsApiKey, slice);
        vectors = got !== null ? got.map((v) => Float32Array.from(v)) : null;
      } catch {
        vectors = null;
      }
      if (vectors !== null && vectors.length === slice.length) {
        for (let n = 0; n < slice.length; n += 1) results[next + n] = vectors[n]!;
      } else {
        fellBack = true;
        for (let n = 0; n < slice.length; n += 1) results[next + n] = Float32Array.from(hashEmbed(slice[n]!));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { vectors: results, fellBack };
}