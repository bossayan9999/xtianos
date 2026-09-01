import { Router, type Request, type Response } from 'express';
import { register } from 'prom-client';
import {
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

collectDefaultMetrics();

// ── API Metrics ──
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

// ── Agent Loop Metrics ──
export const agentLoopDuration = new Histogram({
  name: 'agent_loop_duration_seconds',
  help: 'Duration of agent loop execution',
  labelNames: ['agent', 'mode'],
  buckets: [1, 5, 10, 30, 60, 300],
});

export const toolCallCount = new Counter({
  name: 'tool_calls_total',
  help: 'Total number of tool calls',
  labelNames: ['tool', 'agent', 'status'],
});

export const toolCallDuration = new Histogram({
  name: 'tool_call_duration_seconds',
  help: 'Duration of tool execution',
  labelNames: ['tool'],
  buckets: [0.1, 0.5, 1, 5, 10],
});

// ── Memory Metrics ──
export const memorySearchDuration = new Histogram({
  name: 'memory_search_duration_seconds',
  help: 'Duration of memory search operations',
  labelNames: ['cache_hit'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1],
});

export const memoryChunkCount = new Gauge({
  name: 'memory_chunks_total',
  help: 'Total number of memory chunks',
});

// ── Image Generation Metrics ──
export const imageGenerationDuration = new Histogram({
  name: 'image_generation_duration_seconds',
  help: 'Duration of image generation',
  labelNames: ['provider', 'cached'],
  buckets: [1, 5, 10, 30, 60, 120, 240],
});

export const imageGenerationCost = new Counter({
  name: 'image_generation_cost_usd',
  help: 'Total cost of image generation',
  labelNames: ['provider'],
});

// ── Database Metrics ──
export const databaseQueryDuration = new Histogram({
  name: 'database_query_duration_seconds',
  help: 'Duration of database queries',
  labelNames: ['operation', 'model'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1],
});

export const databaseErrorTotal = new Counter({
  name: 'database_errors_total',
  help: 'Total number of database errors',
  labelNames: ['model', 'operation'],
});

export const metricsRouter = Router();

metricsRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
