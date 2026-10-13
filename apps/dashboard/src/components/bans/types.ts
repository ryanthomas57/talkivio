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

/** Same masking the API stores for display (first two IPv4 octets / IPv6 groups). */
export function maskIp(raw: string): string | null {
  const ip = raw.trim().replace(/\/(32|128)$/, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  if (ip.includes(':') && /^[0-9a-f:.]+$/i.test(ip)) {
    const groups = ip.split(':').filter(Boolean);
    return groups.length ? `${groups.slice(0, 2).join(':').toLowerCase()}:…` : null;
  }
  return null;
}
