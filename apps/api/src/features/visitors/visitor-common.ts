/**
 * Small shared helpers for the visitors feature (records, monitoring, bans,
 * custom fields, identity). Pure functions only.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { generatedVisitorName } from '@talkivio/contracts';
import { AppError } from '../../common/http';
import { normalizeIp } from '../../common/ip';

/** Wire-level page size rules (ch. 40): default 50, maximum 100. */
export function pageLimit(raw: number | undefined, def = 50, max = 100): number {
  if (!raw || !Number.isFinite(raw)) return def;
  return Math.max(1, Math.min(max, Math.floor(raw)));
}

export function displayNameOf(v: { id: string; name: string | null; anonymousLabel?: string | null }): string {
  return v.name?.trim() || v.anonymousLabel || generatedVisitorName(v.id);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: string | null | undefined): string | null {
  const e = input?.trim().toLowerCase();
  return e ? e.slice(0, 200) : null;
}

/** Lookup hash used for exact-email search (matches the widget/chat writers). */
/** @deprecated use `emailLookupHash` from common/crypto (keyed HMAC). */
export function emailLookupKey(email: string): string {
  return `email:${email}`;
}

/** Escape a user string for use inside ILIKE patterns. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Optimistic concurrency precondition (ch. 40): PATCH requires an entity
 * version via `If-Match` (`"3"`, `W/"3"` or `3`) or `expected_version` in the
 * body. Missing → 428, stale → 409.
 */
export function requireVersion(ifMatch: string | string[] | undefined, bodyVersion: number | undefined | null): number {
  const raw = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
  let v: number | null = null;
  if (raw) {
    const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
    if (!m) throw new AppError(422, 'VALIDATION_FAILED', 'If-Match must carry the entity version', { fieldErrors: { if_match: ['Use the version number returned by GET'] } });
    v = Number(m[1]);
  }
  if (v === null && typeof bodyVersion === 'number') v = bodyVersion;
  if (v === null) throw new AppError(428, 'PRECONDITION_REQUIRED', 'Send If-Match with the current version to update this resource');
  return v;
}

export function staleVersion(): AppError {
  return new AppError(409, 'VERSION_CONFLICT', 'This record changed since you loaded it. Refresh and try again.', { retryable: true });
}

// ───────── IP addresses (bans) ─────────

/** Canonical textual form of an exact IP address, or null when invalid. */
export function canonicalIp(input: string): string | null {
  let ip = input.trim();
  if (ip.endsWith('/32') && isIPv4(ip.slice(0, -3))) ip = ip.slice(0, -3);
  if (ip.endsWith('/128') && isIPv6(ip.slice(0, -4))) ip = ip.slice(0, -4);
  ip = normalizeIp(ip.toLowerCase());
  if (isIPv4(ip)) return ip.split('.').map((o) => String(Number(o))).join('.');
  if (isIPv6(ip)) {
    try {
      return new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return null;
    }
  }
  return null;
}

/** Masked display for an address (never reveals the full value to ordinary staff). */
export function maskIp(ip: string): string {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.');
    return `${a}.${b}.x.x`;
  }
  const groups = ip.split(':').filter(Boolean);
  return `${groups.slice(0, 2).join(':')}:…`;
}
