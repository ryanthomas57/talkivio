import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** Worker probe + metrics listener (`/health/live|ready|metrics`); 0 disables it. */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(4010),
  /** Optional bearer token for `/health/metrics`; without it only private-network clients may scrape. */
  METRICS_TOKEN: z.string().min(16).optional(),
  HOST: z.string().default('0.0.0.0'),
  /** Public base URL of this API (used for widget asset URLs, OAuth callbacks, file links). */
  API_URL: z.string().url().default('http://localhost:4000'),
  /** Public base URL of the dashboard. */
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Base URL from which widget assets are served (defaults to API_URL/widget). */
  WIDGET_CDN_URL: z.string().url().optional(),
  BRAND_NAME: z.string().default('Talkivio'),
  DATABASE_URL: z.string().min(1),
  /** Owner connection used only for migrations/seed (never by running services). */
  DATABASE_OWNER_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  /** 32+ byte secret used for encryption at rest and HMACs. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool,
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.string().default('loopback'),

  // Email
  EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  EMAIL_FROM: z.string().default('Talkivio <no-reply@talkivio.local>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool,

  // Storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  /** Private bucket receiving untrusted uploads (defaults to S3_BUCKET). Never served directly. */
  S3_QUARANTINE_BUCKET: z.string().optional(),
  /** Private bucket for scanned (clean) files and export artifacts (defaults to S3_BUCKET). */
  S3_CLEAN_BUCKET: z.string().optional(),
  S3_QUARANTINE_PREFIX: z.string().default('quarantine/'),
  S3_CLEAN_PREFIX: z.string().default('clean/'),
  S3_EXPORTS_PREFIX: z.string().default('exports/'),
  /** Browser-reachable endpoint used only when signing URLs (e.g. MinIO behind a different host). */
  S3_PRESIGN_ENDPOINT: z.string().optional(),
  /** `presigned`: short presigned GET from the bucket; `proxy`: stream through the API (adds nosniff/CSP headers). */
  S3_DOWNLOAD_MODE: z.enum(['presigned', 'proxy']).default('presigned'),

  // File scanning (ch. 19). `dev_unscanned` is refused in production.
  SCAN_MODE: z.enum(['clamav', 'dev_unscanned']).default('clamav'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  /** Default per-tenant daily upload quota (tenant settings `files.dailyQuotaMb/dailyQuotaFiles` override). */
  UPLOAD_DAILY_QUOTA_MB: z.coerce.number().int().min(1).default(2048),
  UPLOAD_DAILY_QUOTA_FILES: z.coerce.number().int().min(1).default(5000),

  // OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  // Billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_TEAM: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),

  // Geo
  /** MaxMind-format city/country database (e.g. DB-IP City Lite, CC BY 4.0); reloaded when the file changes. */
  GEOIP_DB_PATH: z.string().optional(),
  /** Edges whose location headers are trusted: comma list of cloudflare, vercel, fastly, proxy — or none. */
  GEO_TRUSTED_HEADERS: z.string().default('none'),
  /** Development only (ignored in production): public IP looked up for loopback/private visitors. */
  GEO_DEV_IP: z.string().ip().optional(),

  // Observability
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // Realtime tuning
  VISITOR_HEARTBEAT_MS: z.coerce.number().int().min(5000).default(15000),
  VISITOR_TIMEOUT_MS: z.coerce.number().int().min(10000).default(45000),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(10000).default(45000),
  RUN_WORKERS_IN_API: bool,

  // Graceful drain (common/graceful-shutdown.ts). Delay defaults to 5000 ms in production, 0 otherwise.
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).max(120000).optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(25000),

  // Tenant deletion (ch. 41): cancellation window between the owner's request and destruction.
  TENANT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  /** Test-only override of the window in seconds (end-to-end tests). Refused in production. */
  TENANT_DELETION_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(30 * 86_400)
    .optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const refused = productionRefusals(parsed.data);
  if (refused.length)
    throw new Error(
      `Invalid environment configuration for production:\n${refused.map((r) => `  - ${r}`).join('\n')}`,
    );
  cached = parsed.data;
  return cached;
}

/**
 * Development conveniences that would make production lie: the console mailer marks mail
 * accepted without sending it (and logs recipients); dev_unscanned marks files clean unscanned;
 * a seconds-long tenant deletion window removes the owner's chance to cancel.
 */
export function productionRefusals(
  e: Pick<Env, 'NODE_ENV' | 'EMAIL_PROVIDER' | 'SCAN_MODE'> &
    Partial<Pick<Env, 'TENANT_DELETION_GRACE_SECONDS'>>,
): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  if (e.EMAIL_PROVIDER === 'console') out.push('EMAIL_PROVIDER=console is refused in production (use smtp)');
  if (e.SCAN_MODE === 'dev_unscanned')
    out.push('SCAN_MODE=dev_unscanned is refused in production (use clamav)');
  if (e.TENANT_DELETION_GRACE_SECONDS !== undefined)
    out.push(
      'TENANT_DELETION_GRACE_SECONDS is a test-only override and is refused in production (use TENANT_DELETION_GRACE_DAYS)',
    );
  return out;
}

/** Cancellation window for tenant deletion requests, in seconds. */
export function tenantDeletionGraceSeconds(
  e: Pick<Env, 'NODE_ENV' | 'TENANT_DELETION_GRACE_DAYS' | 'TENANT_DELETION_GRACE_SECONDS'> = env(),
): number {
  return e.NODE_ENV !== 'production' && e.TENANT_DELETION_GRACE_SECONDS
    ? e.TENANT_DELETION_GRACE_SECONDS
    : e.TENANT_DELETION_GRACE_DAYS * 86_400;
}

export function widgetBaseUrl(): string {
  const e = env();
  return (e.WIDGET_CDN_URL ?? `${e.API_URL}/widget`).replace(/\/$/, '');
}

export const isProd = () => env().NODE_ENV === 'production';

/**
 * Origins the browser talks to directly for files (presigned upload PUTs, in-place downloads)
 * when objects live in S3-compatible storage — the widget frame CSP must allow them in connect-src.
 */
export function storageBrowserOrigins(
  e: Pick<
    Env,
    | 'STORAGE_DRIVER'
    | 'S3_BUCKET'
    | 'S3_QUARANTINE_BUCKET'
    | 'S3_CLEAN_BUCKET'
    | 'S3_ENDPOINT'
    | 'S3_PRESIGN_ENDPOINT'
    | 'S3_FORCE_PATH_STYLE'
    | 'S3_REGION'
  > = env(),
): string[] {
  if (e.STORAGE_DRIVER !== 's3') return [];
  const buckets = [
    ...new Set(
      [e.S3_QUARANTINE_BUCKET ?? e.S3_BUCKET, e.S3_CLEAN_BUCKET ?? e.S3_BUCKET].filter(
        (b): b is string => !!b,
      ),
    ),
  ];
  const endpoint = e.S3_PRESIGN_ENDPOINT ?? e.S3_ENDPOINT;
  if (endpoint) {
    const u = new URL(endpoint);
    return e.S3_FORCE_PATH_STYLE ? [u.origin] : buckets.map((b) => `${u.protocol}//${b}.${u.host}`);
  }
  return buckets.map((b) => `https://${b}.s3.${e.S3_REGION}.amazonaws.com`);
}
