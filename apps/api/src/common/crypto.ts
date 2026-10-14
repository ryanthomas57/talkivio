import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env';
import { ipBucket } from './ip';

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes)
    .toString('base64url')
    .replace(/[-_]/g, '')
    .slice(0, Math.ceil(bytes * 1.3))}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string, payload: string, encoding: 'hex' | 'base64url' = 'hex'): string {
  return createHmac('sha256', secret).update(payload).digest(encoding);
}

/**
 * Keyed lookup hash for exact-match email search (ch. 17/39). Keyed with the app
 * secret so a leaked table cannot be reversed with a dictionary of addresses.
 */
export function emailLookupHash(email: string): string {
  return hmacSha256(`email-lookup:${env().APP_SECRET}`, email.trim().toLowerCase());
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(`enc:${env().APP_SECRET}`).digest();
}

/** AES-256-GCM encryption for secrets at rest (MFA secrets, webhook secrets). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

export function decrypt(payload: string): string {
  const [version, ivB, tagB, dataB] = payload.split(':');
  if (version !== 'v1' || !ivB || !tagB || !dataB) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8');
}

/** One-way hash for IP addresses (privacy-preserving, per-deployment salt). */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return hmacSha256(`ip:${env().APP_SECRET}`, ip).slice(0, 32);
}

/**
 * Keyed hash of an address's rate-limit bucket (`ipBucket`: the IPv4 address or the IPv6 /64). Use it for
 * per-network limits; exact-address records (sessions, audit, visitor ipHash) keep `hashIp`.
 */
export function hashIpBucket(ip: string | null | undefined): string | null {
  return ip ? hashIp(ipBucket(ip)) : null;
}

/** Verify an HS256 JWT. Returns the payload or null. */
export function verifyJwtHS256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    if (!safeEqual(expected, s)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const skew = 120;
    if (typeof payload.exp === 'number' && payload.exp < now - skew) return null;
    if (typeof payload.iat === 'number' && payload.iat > now + skew) return null;
    return payload;
  } catch {
    return null;
  }
}

export function signJwtHS256(payload: Record<string, unknown>, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

/** Short-lived signed URL token for file downloads. */
export function signFileToken(fileId: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmacSha256(`file:${env().APP_SECRET}`, `${fileId}.${exp}`, 'base64url').slice(0, 32);
  return `${exp}.${sig}`;
}

export function verifyFileToken(fileId: string, token: string): boolean {
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = hmacSha256(`file:${env().APP_SECRET}`, `${fileId}.${exp}`, 'base64url').slice(0, 32);
  return safeEqual(expected, sig);
}
