/**
 * Client address helpers: IPv4-mapped normalisation, rate-limit buckets and workspace allowlist
 * matching (exact addresses plus IPv4 and IPv6 CIDR ranges).
 */
import { BlockList } from 'node:net';
import { formatIpv6, mappedIpv4, parseIpRule, parseIpv4, parseIpv6 } from '@talkivio/contracts';

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`, in any spelling) as the plain IPv4 address; anything else unchanged. */
export function normalizeIp(ip: string): string {
  const groups = ip.includes(':') ? parseIpv6(ip) : null;
  return (groups && mappedIpv4(groups)) ?? ip;
}

/**
 * Rate-limit bucket for a client address: IPv4 (including IPv4-mapped IPv6) is the address itself, IPv6
 * is its /64 (`2001:db8:1:2::/64`). A subscriber is normally handed a whole /64 and can rotate through it
 * at will (privacy addresses change daily), so per-address limits keyed on the full IPv6 address are
 * trivially dodged. Unparseable input is returned trimmed.
 */
export function ipBucket(ip: string): string {
  const s = normalizeIp(ip.trim());
  if (parseIpv4(s) !== null) return s;
  const groups = parseIpv6(s.replace(/%.*$/, ''));
  return groups ? `${formatIpv6([...groups.slice(0, 4), 0, 0, 0, 0])}/64` : s;
}

// Separate lists per family: node:net would otherwise match IPv4 clients against IPv6 rules through
// their mapped form (an IPv4 address is inside `::/16`).
type CompiledRules = { v4: BlockList; v6: BlockList };
const compiled = new Map<string, CompiledRules>();

/** Allowlist entries as BlockLists, cached because the same workspace list is checked on every request. */
function compile(rules: readonly string[]): CompiledRules {
  const key = rules.join('\n');
  const hit = compiled.get(key);
  if (hit) return hit;
  const c: CompiledRules = { v4: new BlockList(), v6: new BlockList() };
  for (const rule of rules) {
    const r = parseIpRule(rule);
    if (r?.family === 4) c.v4.addSubnet(r.address, r.prefix, 'ipv4');
    else if (r) c.v6.addSubnet(r.address, r.prefix, 'ipv6');
  }
  if (compiled.size >= 256) compiled.clear();
  compiled.set(key, c);
  return c;
}

function inRules(c: CompiledRules, ipRaw: string): boolean {
  const ip = normalizeIp(ipRaw.trim());
  if (parseIpv4(ip) !== null) return c.v4.check(ip, 'ipv4');
  return parseIpv6(ip) !== null && c.v6.check(ip, 'ipv6');
}

/** Whether an address matches one allowlist entry (exact address or CIDR range, see `parseIpRule`). */
export function ipMatches(ip: string, rule: string): boolean {
  return inRules(compile([rule]), ip);
}

export function ipAllowed(ip: string | null | undefined, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  if (!ip) return false;
  return inRules(compile(allowlist), ip);
}

/** Rejects private, loopback and link-local addresses (SSRF protection for outbound fetches). */
export function isPrivateAddress(address: string): boolean {
  const ip = normalizeIp(address);
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd'))
    return true;
  if (parseIpv4(ip) === null) return false;
  const inRange = (cidr: string) => ipMatches(ip, cidr);
  return [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '0.0.0.0/8',
    '100.64.0.0/10',
  ].some(inRange);
}
