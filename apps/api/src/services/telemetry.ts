import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { B3Propagator } from '@opentelemetry/propagator-b3';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { W3CTraceContextPropagator as W3C } from '@opentelemetry/core';

let tracer: ReturnType<typeof trace.getTracer> | null = null;

export function initializeOpenTelemetry(): void {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const jaegerHost = process.env['JAEGER_HOST'] || 'localhost';
  const jaegerPort = Number.parseInt(process.env['JAEGER_PORT'] || '6831', 10);

  const tracerProvider = new NodeTracerProvider();

  // Add span processors
  if (nodeEnv === 'production') {
    // Export to Jaeger in production
    const jaegerExporter = new JaegerExporter({
      endpoint: `http://${jaegerHost}:${jaegerPort}`,
    });
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(jaegerExporter));
  } else {
    // Console export in development
    tracerProvider.addSpanProcessor(
      new SimpleSpanProcessor(new ConsoleSpanExporter()),
    );
  }

  // Set propagator
  const propagator = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new B3Propagator()],
  });

  tracerProvider.register({ propagators: [propagator] });
  tracer = trace.getTracer('xtiandos-api');
}

export function getTracer(): ReturnType<typeof trace.getTracer> {
  if (!tracer) {
    initializeOpenTelemetry();
  }
  return tracer!;
}

export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(name, { attributes });

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
