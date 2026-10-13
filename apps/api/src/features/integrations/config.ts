/**
 * Integration settings (ch. 55). Read from `process.env` directly so this feature
 * does not need to change the shared env schema. Every value has a safe default.
 *
 *   TALKIVIO_WEBHOOK_ALLOW_PRIVATE=true         test-only: permit private/loopback webhook targets that
 *                                                match TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS. Refused (ignored,
 *                                                logged) when NODE_ENV=production. Metadata/link-local never allowed.
 *   TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS        comma list of host or host:port (default 127.0.0.1,localhost,::1)
 *   TALKIVIO_WEBHOOK_RETRY_SCHEDULE_MS          non-production override of the retry schedule (comma list, ms)
 *   TALKIVIO_WEBHOOK_TIMEOUT_MS                 HTTP timeout (default 10000, max 10000)
 *   TALKIVIO_WEBHOOK_ROTATION_OVERLAP_MINUTES   default overlap for secret rotation (default 60, max 1440)
 */

/** Spec schedule: attempts at ≈ 0, 10 s, 1 m, 5 m, 30 m, 2 h, 8 h, 24 h, then dead letter. */
export const DEFAULT_RETRY_SCHEDULE_MS = [
  0, 10_000, 60_000, 300_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000,
] as const;

export interface PrivateHostRule {
  host: string;
  port: number | null;
}

export interface IntegrationsConfig {
  production: boolean;
  /** Test-only exception for a local receiver (never true in production). */
  allowPrivate: boolean;
  /** True when the flag was set but refused because NODE_ENV=production. */
  allowPrivateRefused: boolean;
  privateAllowlist: PrivateHostRule[];
  /** HTTPS required for webhook URLs (production); plain HTTP allowed elsewhere for local receivers. */
  requireHttps: boolean;
  retryScheduleMs: number[];
  timeoutMs: number;
  maxResponseBytes: number;
  /** Upper bound applied to a receiver's Retry-After header. */
  maxRetryAfterMs: number;
  rotationOverlapMinutes: number;
  maxEndpointsPerTenant: number;
  maxActiveTokensPerTenant: number;
}

function parseRules(raw: string | undefined): PrivateHostRule[] {
  const list = (raw ?? '127.0.0.1,localhost,::1')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.map((entry) => {
    // [::1]:4196, ::1, 127.0.0.1:4196, localhost
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracket) return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : null };
    const parts = entry.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) return { host: parts[0], port: Number(parts[1]) };
    return { host: entry, port: null };
  });
}

function parseSchedule(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const values = raw.split(',').map((s) => Number(s.trim()));
  if (
    !values.length ||
    values.length > 12 ||
    values.some((v) => !Number.isFinite(v) || v < 0 || v > 7 * 86_400_000)
  )
    return null;
  values[0] = 0;
  return values;
}

function intEnv(source: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = source[name];
  const v = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function loadIntegrationsConfig(source: NodeJS.ProcessEnv = process.env): IntegrationsConfig {
  const production = source.NODE_ENV === 'production';
  const flag =
    source.TALKIVIO_WEBHOOK_ALLOW_PRIVATE === 'true' || source.TALKIVIO_WEBHOOK_ALLOW_PRIVATE === '1';
  const override = production ? null : parseSchedule(source.TALKIVIO_WEBHOOK_RETRY_SCHEDULE_MS);
  return {
    production,
    allowPrivate: flag && !production,
    allowPrivateRefused: flag && production,
    privateAllowlist: parseRules(source.TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS),
    requireHttps: production,
    retryScheduleMs: override ?? [...DEFAULT_RETRY_SCHEDULE_MS],
    timeoutMs: intEnv(source, 'TALKIVIO_WEBHOOK_TIMEOUT_MS', 10_000, 1000, 10_000),
    maxResponseBytes: 64 * 1024,
    maxRetryAfterMs: 3_600_000,
    rotationOverlapMinutes: intEnv(source, 'TALKIVIO_WEBHOOK_ROTATION_OVERLAP_MINUTES', 60, 0, 1440),
    maxEndpointsPerTenant: 20,
    maxActiveTokensPerTenant: 50,
  };
}

let cached: IntegrationsConfig | null = null;
export function integrationsConfig(): IntegrationsConfig {
  return (cached ??= loadIntegrationsConfig());
}
