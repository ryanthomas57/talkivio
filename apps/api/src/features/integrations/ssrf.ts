/**
 * SSRF protection for outbound webhook delivery (ch. 55, SEC SSRF tests).
 *
 * - Only http/https URLs without embedded credentials; HTTPS required in production.
 * - The hostname is resolved and EVERY resolved address must be public. Loopback,
 *   private, CGNAT, link-local, cloud metadata, multicast, reserved and IPv4-mapped
 *   variants are blocked — at save time and again at every dispatch (DNS rebinding).
 * - The dispatcher connects to the address validated here (pinned lookup), so a
 *   second DNS answer between check and connect cannot redirect the request.
 * - A test-only exception permits loopback/private targets that match an explicit
 *   host[:port] allowlist when TALKIVIO_WEBHOOK_ALLOW_PRIVATE=true outside production.
 *   Link-local and metadata addresses are never allowed.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { IntegrationsConfig, PrivateHostRule } from './config';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link_local'
  | 'metadata'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

export type SsrfCode =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'https_required'
  | 'credentials_in_url'
  | 'blocked_address'
  | 'dns_failed';

export class SsrfError extends Error {
  constructor(
    readonly code: SsrfCode,
    message: string,
    readonly addressClass?: AddressClass,
  ) {
    super(message);
  }
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(n: number, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const b = v4ToInt(base)!;
  const size = 2 ** (32 - Number(bits));
  return n >= b - (b % size) && n < b - (b % size) + size;
}

const V4_RULES: Array<[string, AddressClass]> = [
  ['169.254.169.254/32', 'metadata'],
  ['169.254.170.2/32', 'metadata'], // ECS task metadata
  ['100.100.100.200/32', 'metadata'], // Alibaba Cloud metadata
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link_local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'reserved'],
  ['192.0.2.0/24', 'reserved'],
  ['192.88.99.0/24', 'reserved'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'reserved'],
  ['198.51.100.0/24', 'reserved'],
  ['203.0.113.0/24', 'reserved'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
];

function classifyV4(ip: string): AddressClass {
  const n = v4ToInt(ip);
  if (n === null) return 'reserved';
  for (const [cidr, cls] of V4_RULES) if (inV4(n, cidr)) return cls;
  return 'public';
}

/** Expand an IPv6 address to 8 16-bit groups (embedded IPv4 tail supported). */
export function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const n = v4ToInt(s.slice(lastColon + 1));
    if (n === null) return null;
    tail = [Math.floor(n / 65536), n % 65536];
    s = `${s.slice(0, lastColon + 1)}x`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const toNums = (groups: string[]) =>
    groups.flatMap((g) => {
      if (g === 'x') return tail;
      if (!/^[0-9a-f]{1,4}$/.test(g)) return [NaN];
      return [parseInt(g, 16)];
    });
  const h = toNums(head);
  const r = toNums(rest);
  if ([...h, ...r].some((v) => Number.isNaN(v))) return null;
  const fill = 8 - h.length - r.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  return [...h, ...Array(Math.max(0, fill)).fill(0), ...r];
}

function classifyV6(ip: string): AddressClass {
  const g = expandV6(ip);
  if (!g) return 'reserved';
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return 'unspecified';
  if (allZero(0, 7) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d) → classify the IPv4 part.
  if (allZero(0, 5) && g[5] === 0xffff)
    return classifyV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if (allZero(0, 4) && g[4] === 0xffff && g[5] === 0)
    return classifyV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if (allZero(0, 6)) return 'reserved'; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return 'reserved'; // NAT64 can reach internal IPv4
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && allZero(2, 7) && g[7] === 0x254) return 'metadata'; // AWS IMDS IPv6
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return 'link_local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'reserved'; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'reserved'; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return 'reserved'; // Teredo
  if (g[0] === 0x2002) return 'reserved'; // 6to4 may embed private IPv4
  if (g[0] === 0x0100 && allZero(1, 4)) return 'reserved'; // discard-only
  return 'public';
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address.split('%')[0]);
  if (family === 4) return classifyV4(address);
  if (family === 6) return classifyV6(address);
  return 'reserved';
}

/** Syntactic validation (scheme, credentials, length). Does not resolve DNS. */
export function parseWebhookUrl(raw: string, cfg: Pick<IntegrationsConfig, 'requireHttps'>): URL {
  if (typeof raw !== 'string' || raw.length > 2048)
    throw new SsrfError('invalid_url', 'Enter a valid URL (max 2048 characters)');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfError('invalid_url', 'Enter a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new SsrfError('scheme_not_allowed', 'Only http and https URLs are allowed');
  if (cfg.requireHttps && url.protocol !== 'https:')
    throw new SsrfError('https_required', 'Webhook URLs must use https');
  if (url.username || url.password)
    throw new SsrfError(
      'credentials_in_url',
      'Do not put credentials in the URL; verify the signature header instead',
    );
  if (!url.hostname || url.hostname.length > 253)
    throw new SsrfError('invalid_url', 'Enter a valid host name');
  if (url.hash) throw new SsrfError('invalid_url', 'URL fragments are not allowed');
  return url;
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function allowlisted(url: URL, rules: PrivateHostRule[]): boolean {
  const host = bareHost(url);
  const port = effectivePort(url);
  return rules.some((r) => r.host === host && (r.port === null || r.port === port));
}

/** Classes the test-only exception may open (never metadata or link-local). */
const TEST_EXCEPTION_CLASSES: ReadonlySet<AddressClass> = new Set(['loopback', 'private']);

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemResolver: Resolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  /** True when the target was admitted through the test-only private exception. */
  viaTestException: boolean;
}

/**
 * Resolve and validate a webhook target. Every resolved address must be allowed;
 * the first address is returned so the caller can pin the connection to it.
 */
export async function resolveWebhookTarget(
  raw: string | URL,
  cfg: Pick<IntegrationsConfig, 'requireHttps' | 'allowPrivate' | 'privateAllowlist'>,
  resolver: Resolver = systemResolver,
): Promise<ResolvedTarget> {
  const url = typeof raw === 'string' ? parseWebhookUrl(raw, cfg) : raw;
  const host = bareHost(url);
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new SsrfError('dns_failed', 'The webhook host name could not be resolved');
    }
    if (!addresses.length) throw new SsrfError('dns_failed', 'The webhook host name could not be resolved');
  }
  let viaTestException = false;
  for (const a of addresses) {
    const cls = classifyAddress(a.address);
    if (cls === 'public') continue;
    if (cfg.allowPrivate && TEST_EXCEPTION_CLASSES.has(cls) && allowlisted(url, cfg.privateAllowlist)) {
      viaTestException = true;
      continue;
    }
    throw new SsrfError(
      'blocked_address',
      `Webhook URLs may not point to ${cls.replace('_', '-')} addresses`,
      cls,
    );
  }
  const first = addresses[0];
  return { url, address: first.address, family: first.family === 6 ? 6 : 4, viaTestException };
}
