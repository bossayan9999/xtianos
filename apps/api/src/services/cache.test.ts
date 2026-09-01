import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getRedis, closeRedis, cacheMemorySearch, getCachedMemorySearch } from '../services/cache';

describe('Cache Service', () => {
  beforeEach(async () => {
    // Use test Redis instance
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
  });

  afterEach(async () => {
    try {
      await closeRedis();
    } catch {
      // ignore
    }
  });

  it('should cache memory search results', async () => {
    const query = 'test query';
    const results = [{ source: 'vault', content: 'test', score: 0.9 }];

    await cacheMemorySearch(query, results);
    const cached = await getCachedMemorySearch(query);

    expect(cached).toEqual(results);
  });

  it('should return null for uncached queries', async () => {
    const cached = await getCachedMemorySearch('nonexistent');
    expect(cached).toBeNull();
  });

  it('should expire cached results after TTL', async () => {
    const query = 'expiring query';
    const results = [{ source: 'vault', content: 'test', score: 0.9 }];

    await cacheMemorySearch(query, results, 1); // 1 second TTL
    let cached = await getCachedMemorySearch(query);
    expect(cached).toEqual(results);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    cached = await getCachedMemorySearch(query);
    expect(cached).toBeNull();
  });
});
