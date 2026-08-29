/**
 * sqlite-vec vector index for memory chunks.
 *
 * A separate better-sqlite3 connection to the same SQLite file hosts a vec0
 * virtual table (memory_chunks_vec) whose rowid equals the MemoryChunk.id.
 * Prisma owns the relational data; this module owns approximate-nearest-
 * neighbour search. ANN is the fast path — when the table is empty or the
 * extension cannot load, callers fall back to the in-memory brute-force pass.
 *
 * NOTE: sqlite-vec on this platform rejects integer rowids bound as JS numbers
 * (better-sqlite3 binds them as REAL). Bind rowid values with BigInt instead.
 */

import path from "node:path";

import Database from "better-sqlite3";
import sqliteVec from "sqlite-vec";

import { prisma } from "./db";

const databaseFile = path.resolve(__dirname, "../../prisma/dev.db");
const VEC_TABLE = "memory_chunks_vec";
const HASH_DIM = 256;

let conn: Database.Database | null = null;
let vecDim = 0;

function vecDb(): Database.Database {
  if (conn !== null) return conn;
  const db = new Database(databaseFile);
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
  } catch (error: unknown) {
    db.close();
    conn = null;
    console.error("sqlite-vec extension failed to load:", error);
    throw error;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 8000");
  conn = db;
  return db;
}

/** Dimension of an existing vec0 table, or 0 when none has been created yet. */
function tableDim(): number {
  const db = vecDb();
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(VEC_TABLE) as { sql: string } | undefined;
  if (!row) return 0;
  const match = /float\[(\d+)\]/i.exec(row.sql);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Ensure the vec0 table exists for the given embedding dimension. If the
 * table was created with a different dimension (e.g. embedder changed), it is
 * dropped and rebuilt — callers then re-index before searching.
 */
export function ensureVecTable(dim: number): void {
  if (dim <= 0) return;
  vecDim = dim;
  const db = vecDb();
  const existing = tableDim();
  if (existing !== 0 && existing !== dim) {
    db.exec("DROP TABLE " + VEC_TABLE);
  }
  if (existing !== dim) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    );
  }
}

/** Vector dimension the vec table is currently built for, or the hash default. */
export function currentVecDim(): number {
  if (vecDim > 0) return vecDim;
  const existing = tableDim();
  return existing > 0 ? existing : HASH_DIM;
}

/** Insert or replace the vector for a chunk (rowid = MemoryChunk.id). */
export function upsertVector(chunkId: number, embedding: ArrayLike<number> | Float32Array): void {
  const db = vecDb();
  db.prepare(`INSERT OR REPLACE INTO ${VEC_TABLE}(rowid, embedding) VALUES(?,?)`).run(
    BigInt(chunkId),
    Float32Array.from(embedding),
  );
}

export function vectorExists(chunkId: number): boolean {
  const db = vecDb();
  return db.prepare(`SELECT 1 FROM ${VEC_TABLE} WHERE rowid=?`).get(BigInt(chunkId)) !== undefined;
}

/** Delete vectors for removed chunks (batched to stay under SQLite variable limits). */
export function deleteVectors(chunkIds: number[]): void {
  if (chunkIds.length === 0) return;
  const db = vecDb();
  const run = db.prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid IN (${chunkIds.map(() => "?").join(",")})`);
  const ids = chunkIds.map((id) => BigInt(id));
  for (let i = 0; i < ids.length; i += 400) {
    run.run(...ids.slice(i, i + 400));
  }
}

/**
 * Drop every vector whose chunk no longer exists in the relational table.
 * Keeps the ANN index consistent with MemoryChunk after writes.
 */
export function pruneStaleVectors(): number {
  const db = vecDb();
  const result = db
    .prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid NOT IN (SELECT id FROM MemoryChunk)`)
    .run();
  return Number(result.changes);
}

/** Cosine top-k search. Returns chunk ids with similarity in (0,1]. */
export function searchVectors(embedding: ArrayLike<number> | Float32Array, k: number): { id: number; similarity: number }[] {
  if (k <= 0) return [];
  const db = vecDb();
  let rows: unknown[];
  try {
    rows = db
      .prepare(`SELECT rowid, distance FROM ${VEC_TABLE} WHERE embedding MATCH ? AND k=? ORDER BY distance`)
      .all(Float32Array.from(embedding), k) as Array<{ rowid: number | bigint; distance: number }>;
  } catch {
    return [];
  }
  return rows.map((row) => {
    const r = row as { rowid: number | bigint; distance: number };
    const id = typeof r.rowid === "bigint" ? Number(r.rowid) : (r.rowid as number);
    const similarity = Math.max(0, Math.min(1, 1 - (typeof r.distance === "number" ? r.distance : 0)));
    return { id, similarity };
  });
}

export function vectorCount(): number {
  try {
    const db = vecDb();
    return (db.prepare(`SELECT count(*) AS c FROM ${VEC_TABLE}`).get() as { c: number }).c;
  } catch {
    return 0;
  }
}

/** True when the ANN index has any rows to search. */
export function annReady(dim: number): boolean {
  try {
    ensureVecTable(dim);
    return vectorCount() > 0;
  } catch {
    return false;
  }
}

/** Full re-sync: rebuild the vec index from the current MemoryChunk rows. */
export async function rebuildVectorIndex(): Promise<number> {
  const rows = await prisma.memoryChunk.findMany({
    select: { id: true, embeddingJson: true },
    orderBy: { id: "asc" },
  });
  const parsed = rows
    .map((row) => {
      try {
        const v = JSON.parse(row.embeddingJson) as number[];
        return v.length > 0 ? { id: row.id, v } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { id: number; v: number[] } => x !== null);
  if (parsed.length === 0) return 0;
  const dim = parsed[0]?.v.length ?? 0;
  if (dim === 0) return 0;
  const db = vecDb();
  db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
  ensureVecTable(dim);
  const insert = db.prepare(`INSERT OR REPLACE INTO ${VEC_TABLE}(rowid, embedding) VALUES(?,?)`);
  const tx = db.transaction((items: { id: number; v: number[] }[]) => {
    for (const item of items) insert.run(BigInt(item.id), Float32Array.from(item.v));
  });
  tx(parsed);
  vecDim = dim;
  return parsed.length;
}

/** Drop the whole vector index (e.g. when memory is cleared). */
export function dropVectorIndex(): void {
  try {
    vecDb().exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
  } catch {
    /* connection may be unavailable; ignore */
  }
  vecDim = 0;
}