/**
 * Site origin allowlist (ch. 08): entries are exact scheme+host+optional port, or
 * explicit subdomain patterns. HTTPS is required outside localhost.
 */

export interface OriginRule {
  origin: string;
  patternType: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Minimal public-suffix guard: wildcard patterns must have at least a registrable domain. */
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'org.uk', 'ac.uk', 'gov.uk', 'com.mx', 'co.za']);

export function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.includes('://') ? input : `https://${input}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'http:' && !LOCAL_HOSTS.has(host) && !host.endsWith('.localhost') && !host.endsWith('.test')) return null;
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function validateOriginRule(origin: string, patternType: 'exact' | 'subdomain'): string | null {
  const norm = normalizeOrigin(origin);
  if (!norm) return 'Use an origin like https://example.com (http only for localhost)';
  if (patternType === 'subdomain') {
    const host = new URL(norm).hostname;
    const labels = host.split('.');
    const suffix2 = labels.slice(-2).join('.');
    if (labels.length < 2 || (MULTI_PART_SUFFIXES.has(suffix2) && labels.length < 3)) return 'Wildcard patterns must cover a domain you control, not a public suffix';
  }
  return null;
}

export function originAllowed(hostOrigin: string | null | undefined, rules: OriginRule[]): boolean {
  if (!hostOrigin) return false;
  const norm = normalizeOrigin(hostOrigin);
  if (!norm) return false;
  const u = new URL(norm);
  for (const r of rules) {
    const ruleNorm = normalizeOrigin(r.origin);
    if (!ruleNorm) continue;
    if (r.patternType === 'exact' && ruleNorm === norm) return true;
    if (r.patternType === 'subdomain') {
      const ru = new URL(ruleNorm);
      if (ru.protocol !== u.protocol || ru.port !== u.port) continue;
      if (u.hostname === ru.hostname || u.hostname.endsWith(`.${ru.hostname}`)) return true;
    }
  }
  return false;
}

/** CSP frame-ancestors source list generated from approved origins. */
export function frameAncestors(rules: OriginRule[]): string {
  const out = new Set<string>();
  for (const r of rules) {
    const n = normalizeOrigin(r.origin);
    if (!n) continue;
    out.add(n);
    if (r.patternType === 'subdomain') {
      const u = new URL(n);
      out.add(`${u.protocol}//*.${u.host}`);
    }
  }
  return [...out].join(' ') || "'none'";
}

/** Sanitize a tracked URL: origin + path, fragments removed, query limited to an allowlist (default none). */
export function sanitizeTrackedUrl(input: string | null | undefined, allowlist: string[] = []): string | null {
  if (!input) return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const kept = new URLSearchParams();
    for (const key of allowlist) {
      const v = u.searchParams.get(key);
      if (v !== null) kept.set(key, v.slice(0, 200));
    }
    const q = kept.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ''}`.slice(0, 2000);
  } catch {
    return null;
  }
}

export function originOfUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}
