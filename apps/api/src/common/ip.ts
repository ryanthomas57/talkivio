/** IP allowlist matching supporting exact addresses and IPv4 CIDR ranges. */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function ipMatches(ipRaw: string, rule: string): boolean {
  const ip = normalizeIp(ipRaw.trim());
  const r = rule.trim();
  if (!r) return false;
  if (!r.includes('/')) return ip === normalizeIp(r);
  const [base, bitsStr] = r.split('/');
  const bits = Number(bitsStr);
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base);
  if (ipN === null || baseN === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

export function ipAllowed(ip: string | null | undefined, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  if (!ip) return false;
  return allowlist.some((rule) => ipMatches(ip, rule));
}

/** Rejects private, loopback and link-local addresses (SSRF protection for outbound fetches). */
export function isPrivateAddress(address: string): boolean {
  const ip = normalizeIp(address);
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inRange = (cidr: string) => ipMatches(ip, cidr);
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8', '100.64.0.0/10'].some(inRange);
}
