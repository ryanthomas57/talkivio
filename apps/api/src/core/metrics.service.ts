import { Injectable } from '@nestjs/common';

/**
 * Minimal Prometheus registry (text exposition format 0.0.4) for the metric
 * contract in docs/operations/alerts.md. Label values must come from bounded
 * sets (route groups, command names, outcomes) — never ids, emails or URLs.
 */
type Labels = Record<string, string>;

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface MetricDef {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  buckets?: number[];
}

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');
}

class Counter {
  readonly values = new Map<string, number>();
  constructor(readonly def: MetricDef) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
}

class Gauge {
  readonly values = new Map<string, number>();
  constructor(readonly def: MetricDef) {}
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  /** Drop every series (the value is unknown, e.g. its source is unreachable) — absent, never stale. */
  reset(): void {
    this.values.clear();
  }
}

class Histogram {
  readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  readonly buckets: number[];
  constructor(readonly def: MetricDef) {
    this.buckets = def.buckets ?? DEFAULT_BUCKETS;
  }
  observe(labels: Labels, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { buckets: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (seconds <= b) s!.buckets[i]! += 1;
    });
    s.sum += seconds;
    s.count += 1;
  }
}

@Injectable()
export class MetricsService {
  private get service(): string {
    return process.env.TALKIVIO_PROCESS ?? 'api';
  }
  private readonly collectors = new Set<() => Promise<void> | void>();

  readonly commands = new Counter({ name: 'talkivio_commands_total', help: 'Commands by outcome (error budget).', type: 'counter' });
  readonly httpDuration = new Histogram({ name: 'talkivio_http_request_duration_seconds', help: 'REST request duration.', type: 'histogram' });
  readonly messageDelivery = new Histogram({ name: 'talkivio_message_delivery_seconds', help: 'Commit to socket emit for durable events.', type: 'histogram' });
  readonly outboxStage = new Histogram({ name: 'talkivio_outbox_publish_stage_seconds', help: 'Outbox publisher batch time by stage (claim, emit, dispatch, mark).', type: 'histogram', buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] });
  readonly outboxBatchRows = new Histogram({ name: 'talkivio_outbox_batch_rows', help: 'Rows claimed per outbox publisher batch.', type: 'histogram', buckets: [1, 5, 10, 25, 50, 100, 200, 500] });
  readonly outboxDeferred = new Counter({ name: 'talkivio_outbox_deferred_total', help: 'Outbox rows pushed back after a failed emit or dispatch.', type: 'counter' });
  readonly outboxLag = new Gauge({ name: 'talkivio_outbox_oldest_unpublished_seconds', help: 'Age of the oldest unpublished outbox row.', type: 'gauge' });
  readonly queueOldest = new Gauge({ name: 'talkivio_routing_queue_oldest_seconds', help: 'Age of the oldest queued chat.', type: 'gauge' });
  readonly offerSeconds = new Histogram({ name: 'talkivio_routing_offer_seconds', help: 'Routing pass duration that created an offer.', type: 'histogram' });
  readonly socketsConnected = new Gauge({ name: 'talkivio_sockets_connected', help: 'Connected sockets on this node.', type: 'gauge' });
  readonly socketOverloads = new Counter({ name: 'talkivio_socket_overloads_total', help: 'Slow consumers closed for exceeding the outbound buffer (1000 events / 1 MiB).', type: 'counter' });
  readonly socketOutboundBytes = new Gauge({ name: 'talkivio_socket_outbound_buffered_bytes', help: 'Bytes waiting in socket transports on this node (slow-consumer pressure, sampled every second).', type: 'gauge' });
  readonly socketOutboundPackets = new Gauge({ name: 'talkivio_socket_outbound_queued_packets', help: 'Packets queued for sockets on this node and not yet written (sampled every second).', type: 'gauge' });
  readonly socketReconnects = new Counter({ name: 'talkivio_socket_reconnects_total', help: 'Socket connections established (reconnect storms show as spikes).', type: 'counter' });
  readonly jobFailures = new Counter({ name: 'talkivio_job_failures_total', help: 'Failed background jobs.', type: 'counter' });
  readonly jobDuration = new Histogram({ name: 'talkivio_job_duration_seconds', help: 'Background job duration.', type: 'histogram', buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300] });
  readonly scanDuration = new Histogram({ name: 'talkivio_scan_duration_seconds', help: 'Malware scan duration.', type: 'histogram', buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60] });
  readonly scanBacklog = new Gauge({ name: 'talkivio_scan_backlog_seconds', help: 'Age of the oldest file awaiting a scan verdict.', type: 'gauge' });
  readonly emailDeliveries = new Counter({ name: 'talkivio_email_deliveries_total', help: 'Outbound email attempts.', type: 'counter' });
  readonly webhookDeliveries = new Counter({ name: 'talkivio_webhook_deliveries_total', help: 'Webhook delivery attempts.', type: 'counter' });
  readonly monitorFreshness = new Gauge({ name: 'talkivio_monitor_freshness_seconds', help: 'Age of the newest monitor snapshot pushed.', type: 'gauge' });
  readonly processRss = new Gauge({ name: 'talkivio_process_resident_memory_bytes', help: 'Resident memory of this process (sampled at scrape).', type: 'gauge' });

  private readonly all = [
    this.commands,
    this.httpDuration,
    this.messageDelivery,
    this.outboxStage,
    this.outboxBatchRows,
    this.outboxDeferred,
    this.outboxLag,
    this.queueOldest,
    this.offerSeconds,
    this.socketsConnected,
    this.socketOverloads,
    this.socketOutboundBytes,
    this.socketOutboundPackets,
    this.socketReconnects,
    this.jobFailures,
    this.jobDuration,
    this.scanDuration,
    this.scanBacklog,
    this.emailDeliveries,
    this.webhookDeliveries,
    this.monitorFreshness,
    this.processRss,
  ];

  /** Label helper that always carries the process role. */
  labels(extra: Labels = {}): Labels {
    return { service: this.service, ...extra };
  }

  command(command: string, outcome: 'ok' | 'validation' | 'denied' | 'rate_limited' | 'server_error' | 'dependency_error'): void {
    this.commands.inc(this.labels({ command, outcome }));
  }

  /** Map an error code / HTTP status to a bounded outcome label. */
  outcomeFor(status: number, code?: string): 'ok' | 'validation' | 'denied' | 'rate_limited' | 'server_error' | 'dependency_error' {
    if (status < 400) return 'ok';
    if (status === 429 || code === 'RATE_LIMITED') return 'rate_limited';
    if (status === 401 || status === 403 || status === 404) return 'denied';
    if (code === 'SERVICE_UNAVAILABLE' || code === 'INTEGRATION_UNAVAILABLE' || status === 502 || status === 503 || status === 504) return 'dependency_error';
    if (status >= 500) return 'server_error';
    return 'validation';
  }

  /** Register a scrape-time collector (e.g. DB-derived gauges). */
  onCollect(fn: () => Promise<void> | void): void {
    this.collectors.add(fn);
  }

  async render(): Promise<string> {
    this.processRss.set(this.labels(), process.memoryUsage().rss);
    for (const c of this.collectors) {
      try {
        await c();
      } catch {
        /* a failing collector must not break the scrape */
      }
    }
    const out: string[] = [];
    for (const m of this.all) {
      out.push(`# HELP ${m.def.name} ${m.def.help}`, `# TYPE ${m.def.name} ${m.def.type}`);
      if (m instanceof Histogram) {
        for (const [k, s] of m.series) {
          const sep = k ? ',' : '';
          m.buckets.forEach((b, i) => out.push(`${m.def.name}_bucket{${k}${sep}le="${b}"} ${s.buckets[i]}`));
          out.push(`${m.def.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`, `${m.def.name}_sum{${k}} ${s.sum}`, `${m.def.name}_count{${k}} ${s.count}`);
        }
      } else {
        for (const [k, v] of m.values) out.push(`${m.def.name}${k ? `{${k}}` : ''} ${v}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
}

/**
 * Scrape authorization: a bearer `METRICS_TOKEN` when configured, otherwise only
 * loopback/private-network clients (internal Prometheus) may read metrics.
 */
export function metricsAllowed(remoteAddress: string | undefined, authorization: string | undefined, isPrivate: (ip: string) => boolean): boolean {
  const token = process.env.METRICS_TOKEN;
  if (token) return authorization === `Bearer ${token}`;
  return !!remoteAddress && isPrivate(remoteAddress);
}

/** Bounded route group for HTTP metrics: `/api/v1/chats/:id/messages` → `chats`. */
export function routeGroup(path: string): string {
  const p = path.split('?')[0] ?? '';
  const m = /^\/(?:api\/v1|widget\/v1|widget)\/([a-z-]+)/.exec(p);
  if (p.startsWith('/health')) return 'health';
  if (p.startsWith('/metrics')) return 'metrics';
  if (p.startsWith('/widget/')) return m ? `widget_${m[1]}` : 'widget_assets';
  if (m?.[1]) return m[1] === 'exports' ? 'export' : m[1];
  return 'other';
}
