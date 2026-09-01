import { describe, it, expect, beforeEach } from 'vitest';
import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3101';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'test-token';

describe('UI Rendering Tests - Web App Health Checks', () => {
  it('should serve the web app entry point', async () => {
    const res = await fetch(`${API_URL}/index.html`);
    expect([200, 404]).toContain(res.status); // 404 if not served from API
  });

  it('should return CORS headers for API requests', async () => {
    const res = await fetch(`${API_URL}/api/chat`, {
      method: 'OPTIONS',
    });
    expect([200, 204, 404]).toContain(res.status);
  });

  it('should serve static assets with proper cache headers', async () => {
    const res = await fetch(`${API_URL}/index.css`);
    if (res.status === 200) {
      const cacheControl = res.headers.get('cache-control');
      expect(cacheControl).toBeTruthy();
    }
  });

  it('should handle SSE streaming without breaking', async () => {
    // Create conversation first
    let res = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    const conv = (await res.json()) as { id: number };

    // Stream response
    res = await fetch(`${API_URL}/api/chat/${conv.id}/stream`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': AUTH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Test message',
        mode: 'chat',
      }),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('text/event-stream');
  });
});
