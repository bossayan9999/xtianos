import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3101';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'test-token';

let conversationId: number;

describe('Functional Tests - Chat & Agent Loop', () => {
  beforeEach(async () => {
    const res = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    const data = (await res.json()) as { id: number };
    conversationId = data.id;
  });

  it('should create a new conversation', () => {
    expect(conversationId).toBeGreaterThan(0);
  });

  it('should retrieve conversation history', async () => {
    const res = await fetch(
      `${API_URL}/api/chat/${conversationId}/messages`,
      {
        headers: { 'X-Auth-Token': AUTH_TOKEN },
      },
    );
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<{ role: string }> | null;
    expect(Array.isArray(messages)).toBe(true);
  });

  it('should accept a chat message', async () => {
    const res = await fetch(
      `${API_URL}/api/chat/${conversationId}/stream`,
      {
        method: 'POST',
        headers: {
          'X-Auth-Token': AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'What is 2+2?',
          mode: 'chat',
          output: 'text',
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('should list agents', async () => {
    const res = await fetch(`${API_URL}/api/agents`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect(res.status).toBe(200);
    const agents = (await res.json()) as Array<{ name: string }> | null;
    expect(Array.isArray(agents)).toBe(true);
    if (agents && agents.length > 0) {
      expect(agents[0]).toHaveProperty('name');
    }
  });

  it('should list memory chunks', async () => {
    const res = await fetch(`${API_URL}/api/memory/chunks`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect([200, 404]).toContain(res.status);
  });

  it('should get image config', async () => {
    const res = await fetch(`${API_URL}/api/image-config`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect(res.status).toBe(200);
    const config = (await res.json()) as {
      provider: string;
      hasKey: boolean;
    } | null;
    expect(config).toHaveProperty('provider');
  });
});
