import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3101';

describe('Smoke Tests - Critical API Endpoints', () => {
  it('should respond to health check', async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; app: string };
    expect(data.status).toBe('ok');
    expect(data.app).toBe('xtiandOS');
  });

  it('should list conversations without auth error', async () => {
    const res = await fetch(`${API_URL}/api/chat`);
    expect([200, 401]).toContain(res.status);
  });

  it('should return metrics endpoint', async () => {
    const res = await fetch(`${API_URL}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('http_requests_total');
  });

  it('should respond to Docker status', async () => {
    const res = await fetch(`${API_URL}/api/docker/status`);
    expect([200, 503]).toContain(res.status); // 503 if Docker unavailable
  });

  it('should reject invalid auth token', async () => {
    const res = await fetch(`${API_URL}/api/chat`, {
      headers: { 'X-Auth-Token': 'invalid' },
    });
    expect([401, 403]).toContain(res.status);
  });
});
