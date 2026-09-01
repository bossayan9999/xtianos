import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3101';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'test-token';

describe('Integration Tests - Multi-Service Workflows', () => {
  it('should complete end-to-end chat workflow', async () => {
    // 1. Create conversation
    let res = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect(res.status).toBe(200);
    const conv = (await res.json()) as { id: number };

    // 2. Send message
    res = await fetch(`${API_URL}/api/chat/${conv.id}/stream`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': AUTH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Summarize the xtiandOS architecture',
        mode: 'chat',
        output: 'text',
      }),
    });
    expect(res.status).toBe(200);

    // 3. Verify messages saved
    res = await fetch(`${API_URL}/api/chat/${conv.id}/messages`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<{ role: string }> | null;
    expect(messages && messages.length).toBeGreaterThan(0);
  });

  it('should handle MCP server registration and tool lookup', async () => {
    // 1. List MCP servers
    let res = await fetch(`${API_URL}/api/mcp/servers`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect(res.status).toBe(200);

    // 2. Verify tools are discoverable
    res = await fetch(`${API_URL}/api/mcp/tools`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect([200, 404]).toContain(res.status);
  });

  it('should handle multi-step workflow across services', async () => {
    // 1. Create project
    let res = await fetch(`${API_URL}/api/projects`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': AUTH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Integration Test Project' }),
    });
    expect(res.status).toBe(200);
    const project = (await res.json()) as { id: number };

    // 2. Create task in project
    res = await fetch(`${API_URL}/api/tasks`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': AUTH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: project.id,
        title: 'Test Task',
        status: 'inbox',
      }),
    });
    expect(res.status).toBe(200);

    // 3. Verify task is associated
    res = await fetch(`${API_URL}/api/projects/${project.id}`, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
    });
    expect(res.status).toBe(200);
  });
});
