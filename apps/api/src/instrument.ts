/**
 * Optional observability. Loaded before the application:
 *  - SENTRY_DSN                    → Sentry-compatible error reporting
 *  - OTEL_EXPORTER_OTLP_ENDPOINT   → OpenTelemetry traces (HTTP, Express, Redis, Socket.IO, and the outbox publish
 *                                    span that continues each request's trace — see common/tracing.ts)
 * Both SDKs are optional dependencies and are skipped silently when absent. Every span is scrubbed before export
 * (common/trace-scrub.ts): no query strings, client addresses, user agents, Redis arguments or exception messages.
 */
import { setErrorReporter } from './common/http';
import { scrubAttributes, type Attributes } from './common/trace-scrub';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { SpanKind } = require('@opentelemetry/api');
    type ExportedSpan = { kind: number; attributes: Attributes; events: Array<{ attributes?: Attributes }> };
    const scrub = (span: ExportedSpan) => {
      const outgoing = span.kind === SpanKind.CLIENT;
      return Object.create(span, {
        attributes: { value: scrubAttributes(span.attributes, outgoing), enumerable: true },
        events: { value: span.events.map((e) => ({ ...e, attributes: e.attributes ? scrubAttributes(e.attributes, outgoing) : e.attributes })), enumerable: true },
      }) as ExportedSpan;
    };
    const otlp = new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` });
    const sdk = new NodeSDK({
      serviceName: `talkivio-${process.env.TALKIVIO_PROCESS ?? 'api'}`,
      traceExporter: {
        export: (spans: ExportedSpan[], done: (result: unknown) => void) => otlp.export(spans.map(scrub), done),
        shutdown: () => otlp.shutdown(),
        forceFlush: () => otlp.forceFlush(),
      },
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          // Probes and scrapes are not user work; they would drown the traces.
          '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: (req: { url?: string }) => (req.url ?? '').startsWith('/health/') },
          // Command names only — arguments carry job data and socket frames.
          // Only inside traced work (requests, publishes): background queue polling would be all noise.
          '@opentelemetry/instrumentation-ioredis': { dbStatementSerializer: (command: string) => command, requireParentSpan: true },
        }),
      ],
    });
    sdk.start();
    process.on('SIGTERM', () => void sdk.shutdown());
  } catch (err) {
    console.warn(`[otel] disabled: ${(err as Error).message}`);
  }
}

if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      sendDefaultPii: false,
    });
    setErrorReporter((err) => Sentry.captureException(err));
  } catch (err) {
    console.warn(`[sentry] disabled: ${(err as Error).message}`);
  }
}
