/**
 * IP address parsing shared by the API (allowlist validation and matching, rate-limit buckets, bans)
 * and the dashboard (allowlist and ban inputs). Pure TypeScript, so it also runs in the browser.
 */

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** Dotted-quad IPv4 as an unsigned 32-bit number; null unless exactly four decimal octets (no leading zeros). */
export function parseIpv4(input: string): number | null {
  const parts = input.split('.');
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/**
 * The eight 16-bit groups of an IPv6 address, or null when invalid. Accepts `::` compression, any
 * letter case and a trailing dotted IPv4 (`::ffff:192.0.2.1`); rejects zone ids (`%eth0`).
 */
export function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (!s.includes(':')) return null;
  const tail = s.slice(s.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, s.length - tail.length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const count = head.length + (rest?.length ?? 0);
  if (rest === null ? count !== 8 : count > 7) return null;
  const groups = rest === null ? head : [...head, ...Array<string>(8 - count).fill('0'), ...rest];
  if (!groups.every((g) => HEXTET.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** RFC 5952 text for eight groups: lowercase, no leading zeros, the first longest run of 2+ zero groups as `::`. */
export function formatIpv6(groups: readonly number[]): string {
  let start = -1;
  let len = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > len) [start, len] = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  return start < 0 ? hex.join(':') : `${hex.slice(0, start).join(':')}::${hex.slice(start + len).join(':')}`;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), or null for any other address. */
export function mappedIpv4(groups: readonly number[]): string | null {
  if (groups.length !== 8 || groups.slice(0, 5).some((g) => g !== 0) || groups[5] !== 0xffff) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

export interface IpRule {
  family: 4 | 6;
  /** Canonical text (dotted IPv4 or RFC 5952 IPv6). Host bits after the prefix are kept as entered. */
  address: string;
  /** 32 or 128 for an exact address. */
  prefix: number;
}

/** Broadest range a workspace allowlist entry may name per family; wider ranges would make the list pointless. */
export const IP_RULE_MIN_PREFIX = { 4: 8, 6: 16 } as const;

/**
 * Parses a workspace allowlist entry: an exact IPv4 or IPv6 address, or a CIDR range (IPv4 /8 to /32,
 * IPv6 /16 to /128). An IPv4-mapped IPv6 address counts as its IPv4 address. Null when invalid.
 */
export function parseIpRule(input: string): IpRule | null {
  const [addr, bits, extra] = input.trim().split('/');
  if (extra !== undefined || !addr) return null;
  let rule: IpRule;
  if (parseIpv4(addr) !== null) rule = { family: 4, address: addr, prefix: 32 };
  else {
    const groups = parseIpv6(addr);
    if (!groups) return null;
    const v4 = mappedIpv4(groups);
    if (v4 && bits !== undefined) return null;
    rule = v4
      ? { family: 4, address: v4, prefix: 32 }
      : { family: 6, address: formatIpv6(groups), prefix: 128 };
  }
  if (bits === undefined) return rule;
  const prefix = Number(bits);
  if (!/^\d{1,3}$/.test(bits) || prefix < IP_RULE_MIN_PREFIX[rule.family] || prefix > rule.prefix)
    return null;
  return { ...rule, prefix };
}
