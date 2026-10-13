import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_SCHEDULE_MS } from './config';
import {
  classifyResponse,
  nextRetryDelay,
  parseRetryAfter,
  sanitizeExcerpt,
  signatureHeader,
  verifySignature,
} from './signing';

describe('webhook signatures', () => {
  const body = '{"id":"e1","type":"chat.closed"}';
  const ts = '1760000000';

  it('matches the documented v1 scheme', () => {
    const expected = createHmac('sha256', 'whsec_a').update(`${ts}.${body}`).digest('hex');
    expect(signatureHeader(['whsec_a'], ts, body)).toBe(`v1=${expected}`);
  });

  it('verifies with any overlapping secret and rejects tampering and stale timestamps', () => {
    const header = signatureHeader(['whsec_new', 'whsec_old'], ts, body);
    expect(verifySignature(header, ts, body, ['whsec_old'], 1760000010).ok).toBe(true);
    expect(verifySignature(header, ts, body, ['whsec_new'], 1760000010).ok).toBe(true);
    expect(verifySignature(header, ts, `${body} `, ['whsec_new'], 1760000010).reason).toBe('bad_signature');
    expect(verifySignature(header, ts, body, ['whsec_other'], 1760000010).reason).toBe('bad_signature');
    expect(verifySignature(header, ts, body, ['whsec_new'], 1760000000 + 301).reason).toBe('stale_timestamp');
  });
});

describe('delivery policy', () => {
  it('classifies statuses', () => {
    expect(classifyResponse(204)).toBe('delivered');
    expect(classifyResponse(408)).toBe('retry');
    expect(classifyResponse(429)).toBe('retry');
    expect(classifyResponse(503)).toBe('retry');
    expect(classifyResponse(null)).toBe('retry');
    expect(classifyResponse(301)).toBe('permanent');
    expect(classifyResponse(400)).toBe('permanent');
    expect(classifyResponse(410)).toBe('permanent');
  });

  it('follows the schedule with bounded jitter, then dead-letters', () => {
    const s = DEFAULT_RETRY_SCHEDULE_MS;
    expect(nextRetryDelay(1, s, null, 3600_000, () => 0.5)).toBe(10_000);
    expect(nextRetryDelay(2, s, null, 3600_000, () => 0)).toBe(54_000);
    expect(nextRetryDelay(7, s, null, 3600_000, () => 1)).toBe(95_040_000);
    expect(nextRetryDelay(8, s, null, 3600_000)).toBeNull();
  });

  it('respects Retry-After up to the bound', () => {
    expect(nextRetryDelay(1, DEFAULT_RETRY_SCHEDULE_MS, 120_000, 3600_000, () => 0.5)).toBe(120_000);
    expect(nextRetryDelay(1, DEFAULT_RETRY_SCHEDULE_MS, 99 * 3600_000, 3600_000, () => 0.5)).toBe(3600_000);
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });

  it('sanitizes response excerpts', () => {
    const out = sanitizeExcerpt(
      `ok\u0000 Authorization: Bearer abcdefghijkl12345 token=sk_live_abcdefghij "password":"hunter22" ${'x'.repeat(2000)}`,
    );
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).not.toContain('abcdefghijkl12345');
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('\u0000');
  });
});
