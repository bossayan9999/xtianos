import redis, { type Redis } from 'ioredis';
import { env } from '../lib/env';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      enableOfflineQueue: true,
    });
    redisClient.on('error', (err) => console.error('Redis error:', err));
    redisClient.on('connect', () => console.log('Redis connected'));
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/** Cache memory chunk search results (1 hour TTL). */
export async function cacheMemorySearch(
  query: string,
  results: unknown[],
  ttlSeconds: number = 3600,
): Promise<void> {
  const key = `memory:search:${Buffer.from(query).toString('base64')}`;
  await getRedis().setex(key, ttlSeconds, JSON.stringify(results));
}

/** Retrieve cached memory search results. */
export async function getCachedMemorySearch(
  query: string,
): Promise<unknown[] | null> {
  const key = `memory:search:${Buffer.from(query).toString('base64')}`;
  const cached = await getRedis().get(key);
  return cached ? JSON.parse(cached) : null;
}

/** Cache generated image (1 day TTL for large payloads). */
export async function cacheGeneratedImage(
  promptHash: string,
  imageBase64: string,
  ttlSeconds: number = 86400,
): Promise<void> {
  const key = `image:gen:${promptHash}`;
  // Split large values into chunks to avoid Redis limits
  const chunkSize = 512 * 1024; // 512KB chunks
  const chunks = [];
  for (let i = 0; i < imageBase64.length; i += chunkSize) {
    chunks.push(imageBase64.slice(i, i + chunkSize));
  }
  if (chunks.length === 1) {
    await getRedis().setex(key, ttlSeconds, imageBase64);
  } else {
    const pipe = getRedis().pipeline();
    chunks.forEach((chunk, idx) => {
      pipe.setex(`${key}:${idx}`, ttlSeconds, chunk);
    });
    pipe.setex(`${key}:count`, ttlSeconds, String(chunks.length));
    await pipe.exec();
  }
}

/** Retrieve cached generated image. */
export async function getCachedGeneratedImage(
  promptHash: string,
): Promise<string | null> {
  const key = `image:gen:${promptHash}`;
  const count = await getRedis().get(`${key}:count`);
  if (count) {
    const chunkCount = Number.parseInt(count, 10);
    const chunks: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const chunk = await getRedis().get(`${key}:${i}`);
      if (chunk) chunks.push(chunk);
    }
    return chunks.join('');
  }
  const single = await getRedis().get(key);
  return single || null;
}

/** Cache MCP server tool catalog (30 min TTL). */
export async function cacheMcpCatalog(
  serverId: string,
  catalog: unknown,
  ttlSeconds: number = 1800,
): Promise<void> {
  const key = `mcp:catalog:${serverId}`;
  await getRedis().setex(key, ttlSeconds, JSON.stringify(catalog));
}

/** Retrieve cached MCP catalog. */
export async function getCachedMcpCatalog(
  serverId: string,
): Promise<unknown | null> {
  const key = `mcp:catalog:${serverId}`;
  const cached = await getRedis().get(key);
  return cached ? JSON.parse(cached) : null;
}

/** Invalidate memory search cache for a source. */
export async function invalidateMemoryCache(source: string): Promise<void> {
  const pattern = `memory:search:*`;
  const keys = await getRedis().keys(pattern);
  if (keys.length > 0) {
    await getRedis().del(...keys);
  }
}

/** Health check for Redis connection. */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
