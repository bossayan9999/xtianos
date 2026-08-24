const DIM = 256;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Deterministic feature-hashing embedding — offline fallback when no
 * embedding provider is configured. Good enough for keyword-ish recall;
 * replaced automatically by real provider embeddings when available.
 */
export function hashEmbed(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  for (const token of tokens) {
    vector[hashToken(token) % DIM] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) dot += a[i] * b[i];
  return dot;
}

/** BM25-lite keyword overlap in [0,1]. */
export function keywordScore(query: string, document: string): number {
  const qTokens = new Set(
    query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
  );
  if (qTokens.size === 0) return 0;
  const dTokens = new Set(
    document.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
  );
  let hits = 0;
  for (const token of qTokens) {
    if (dTokens.has(token)) hits += 1;
  }
  return hits / qTokens.size;
}

export function chunkText(text: string, chunkChars = 900, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= chunkChars) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    chunks.push(clean.slice(start, start + chunkChars));
    start += chunkChars - overlap;
  }
  return chunks;
}
