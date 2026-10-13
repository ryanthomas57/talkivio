/**
 * Message-lifecycle tracing (AUD-72-27) on the optional OpenTelemetry SDK started by src/instrument.ts.
 * A request that writes outbox rows stores its W3C `traceparent` with them; the worker's publish span continues
 * that trace, so one trace follows a message from the HTTP/socket command through commit to the socket fan-out
 * and the internal event queue. Without the SDK or OTEL_EXPORTER_OTLP_ENDPOINT every function is a cheap no-op.
 * Span attributes are identifiers, types and counts only — never bodies, emails, tokens or URLs.
 */
import type * as Otel from '@opentelemetry/api';

let otel: typeof Otel | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  otel = require('@opentelemetry/api') as typeof Otel;
} catch {
  otel = null;
}

export type SpanAttributes = Record<string, string | number | boolean>;

/** W3C traceparent of the active span (null when tracing is off or nothing is being traced). */
export function activeTraceparent(): string | null {
  if (!otel || !otel.trace.getActiveSpan()) return null;
  const carrier: Record<string, string> = {};
  otel.propagation.inject(otel.context.active(), carrier);
  return carrier.traceparent ?? null;
}

function parentContext(traceparent: string | null): Otel.Context {
  return traceparent ? otel!.propagation.extract(otel!.ROOT_CONTEXT, { traceparent }) : otel!.ROOT_CONTEXT;
}

function fail(span: Otel.Span, err: unknown): void {
  // The error type only: messages can quote input.
  span.setStatus({ code: otel!.SpanStatusCode.ERROR, message: (err as Error)?.name ?? 'Error' });
}

/** Runs `fn` in a span that continues the trace in `traceparent` (a new root when null). */
export function inSpanSync<T>(name: string, traceparent: string | null, attributes: SpanAttributes, fn: () => T): T {
  if (!otel) return fn();
  return otel.trace.getTracer('talkivio').startActiveSpan(name, { kind: otel.SpanKind.PRODUCER, attributes }, parentContext(traceparent), (span) => {
    try {
      return fn();
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Async variant; `links` attach further traces (e.g. every event in one queued batch). */
export async function inSpan<T>(name: string, traceparent: string | null, attributes: SpanAttributes, fn: () => Promise<T>, links: Array<string | null> = []): Promise<T> {
  if (!otel) return fn();
  const api = otel;
  const spanLinks = links.flatMap((tp) => {
    const sc = tp ? api.trace.getSpanContext(parentContext(tp)) : undefined;
    return sc ? [{ context: sc }] : [];
  });
  return api.trace.getTracer('talkivio').startActiveSpan(name, { kind: api.SpanKind.PRODUCER, attributes, links: spanLinks }, parentContext(traceparent), async (span) => {
    try {
      return await fn();
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}
