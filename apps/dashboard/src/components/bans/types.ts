import { formatIpv6, mappedIpv4, parseIpv4, parseIpv6 } from '@talkivio/contracts';

/** Ban resource (mirrors `BanResource` in apps/api/src/features/visitors/bans.service.ts). */
export interface Ban {
  id: string;
  target: { kind: 'visitor'; visitorId: string; displayName: string | null } | { kind: 'ip'; masked: string };
  siteId: string | null;
  reason: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
  createdAt: string;
  /** User id of the staff member who created the ban. */
  createdBy: string;
  revokedBy: string | null;
  collateralWarning?: string;
  closedChatIds?: string[];
}

export const bansKey = (active: string) => ['bans', active] as const;

/**
 * Same masking the API stores for display (first two IPv4 octets / IPv6 groups of the canonical text;
 * an IPv6 /64 ban keeps its `/64`). Null for anything the API would refuse as a ban target.
 */
export function maskIp(raw: string): string | null {
  const [, ip, bits] = /^(.*?)(?:\/(32|64|128))?$/.exec(raw.trim())!;
  const groups = ip.includes(':') ? parseIpv6(ip) : null;
  const v4 = groups ? mappedIpv4(groups) : parseIpv4(ip) !== null ? ip : null;
  const exact = !bits || bits === (groups ? '128' : '32');
  if (v4) return exact ? `${v4.split('.').slice(0, 2).join('.')}.x.x` : null;
  if (!groups || !(exact || bits === '64')) return null;
  const shown = bits === '64' ? [...groups.slice(0, 4), 0, 0, 0, 0] : groups;
  const head = formatIpv6(shown).split(':').filter(Boolean).slice(0, 2).join(':');
  return `${head}:…${bits === '64' ? '/64' : ''}`;
}
