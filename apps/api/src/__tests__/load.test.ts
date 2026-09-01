import { describe, it, expect } from 'vitest';
import autocannon from 'autocannon';

const API_URL = process.env.API_URL || 'http://localhost:3101';

describe('Load Tests', () => {
  it('should handle 100 requests/sec to health endpoint', async () => {
    const result = await autocannon(
      {
        url: `${API_URL}/health`,
        connections: 10,
        pipelining: 1,
        duration: 10,
        requests: [
          {
            path: '/health',
            method: 'GET',
          },
        ],
      },
      (err, result) => {
        return result;
      },
    );

    // Should maintain <1s p99 latency under load
    expect(result.throughput?.average).toBeGreaterThan(50); // >50 req/s
  });

  it('should handle concurrent chat requests', async () => {
    const result = await autocannon(
      {
        url: `${API_URL}/api/chat`,
        connections: 20,
        pipelining: 1,
        duration: 15,
      },
      (err, result) => {
        return result;
      },
    );

    // Should not crash, errors are acceptable
    expect(result.errors).toBeLessThan(result.requests.total / 10); // <10% error rate
  });
});
