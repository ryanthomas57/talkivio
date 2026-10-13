/**
 * Webhook signing contract (ch. 55):
 *   X-Talkivio-Timestamp: <unix seconds>
 *   X-Talkivio-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>
 *
 * During a secret rotation overlap the header carries one `v1=` entry per valid
 * secret, comma separated (newest first): `v1=<new>,v1=<previous>`. Receivers accept
 * the request when ANY entry matches one of their configured secrets.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function signV1(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function signatureHeader(secrets: string[], timestamp: string, rawBody: string): string {
  return secrets.map((s) => `v1=${signV1(s, timestamp, rawBody)}`).join(',');
}

function equalHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify a signature header against any of the receiver's secrets and the timestamp window. */
export function verifySignature(
  header: string | undefined | null,
  timestamp: string | undefined | null,
  rawBody: string,
  secrets: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): { ok: boolean; reason?: 'missing' | 'stale_timestamp' | 'bad_signature' } {
  if (!header || !timestamp || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'missing' };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds)
    return { ok: false, reason: 'stale_timestamp' };
  const candidates = header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  for (const secret of secrets) {
    const expected = signV1(secret, timestamp, rawBody);
    if (candidates.some((c) => equalHex(c, expected))) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b(whsec|rdt|rdvc|rdsk|rds|sk|pk|rk)_[a-z0-9_-]{8,}/gi,
  /\b(eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})/gi,
  /("?(password|secret|token|api[_-]?key|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,&}]+)/gi,
];

/** Response excerpt for delivery history: ≤ 1000 chars, printable, credentials masked. */
export function sanitizeExcerpt(raw: string, max = 1000): string {
  let s = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const re of SECRET_PATTERNS)
    s = s.replace(re, (m, a: string) => (re.source.startsWith('("?') ? `${a}[redacted]` : '[redacted]'));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Parse Retry-After (delta seconds or HTTP date) → milliseconds, or null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

export type DeliveryOutcome = 'delivered' | 'retry' | 'permanent';

/** 2xx delivered; 408/429/5xx and network/timeouts retry; other statuses (incl. redirects) permanent. */
export function classifyResponse(status: number | null): DeliveryOutcome {
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'permanent';
}

/**
 * Delay before the next attempt after `attemptsMade` attempts (1-based), or null when
 * the schedule is exhausted (dead letter). ±10 % jitter; a receiver Retry-After is
 * honoured up to `maxRetryAfterMs`.
 */
export function nextRetryDelay(
  attemptsMade: number,
  schedule: readonly number[],
  retryAfterMs: number | null,
  maxRetryAfterMs: number,
  random: () => number = Math.random,
): number | null {
  if (attemptsMade >= schedule.length) return null;
  const base = schedule[attemptsMade];
  const jittered = Math.round(base * (0.9 + random() * 0.2));
  const hinted = retryAfterMs === null ? 0 : Math.min(retryAfterMs, maxRetryAfterMs);
  return Math.max(jittered, hinted);
}
