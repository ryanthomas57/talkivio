'use client';
/**
 * Visitor information beside a docked chat (classic live chat side panel): who they are, where they are, the
 * address and network they use, their device, how often they came and chatted, and the pages of this visit.
 */
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { countryName, flagEmoji, formatNumber, formatRelative, formatTime } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import type { StaffChat } from '@/lib/types';
import { useCan } from '@/stores/session';
import { DEVICE, originLabel, urlLabel } from '@/components/visitors/display';
import { visitorKeys, type VisitorSessionRecord } from '@/components/visitors/types';
import { useVisitorProfile } from '@/components/visitors/use-visitor';
import type { DockVisitor } from '@/stores/dock';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-xs text-fg-2">{label}</dt>
      <dd className="min-w-0 break-anywhere text-sm text-fg">{children}</dd>
    </div>
  );
}

function localTime(timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(
      new Date(),
    );
  } catch {
    return null;
  }
}

export function VisitorInfo({
  visitorId,
  chat,
  fallback,
}: {
  visitorId: string;
  chat?: StaffChat;
  fallback?: DockVisitor;
}) {
  const t = useT();
  const canView = useCan('visitors.view');
  const profile = useVisitorProfile(canView ? visitorId : null);
  const latest = useQuery({
    queryKey: [...visitorKeys.sessions(visitorId), 'latest'],
    queryFn: () => api.page<VisitorSessionRecord>(`/visitors/${visitorId}/sessions`, { limit: 1 }),
    enabled: canView,
    staleTime: 15_000,
    retry: false,
  });
  const departments = byId(useDepartments().data);
  const p = profile.data;
  const s = latest.data?.items[0];

  const name = p?.displayName ?? chat?.visitor.displayName ?? fallback?.name ?? t('common.visitor');
  const email = p?.fields.email?.value ?? null;
  const phone = p?.fields.phone?.value ?? null;
  const code =
    p?.location?.countryCode ?? s?.country ?? chat?.visitor.countryCode ?? fallback?.country ?? null;
  const place = [p?.location?.city, p?.location?.region, countryName(code)].filter(Boolean).join(', ');
  const ip = s?.ipAddress ?? fallback?.ipAddress ?? null;
  const device = s?.device ?? p?.device ?? null;
  const deviceLabel =
    device?.category && DEVICE[device.category] ? t(DEVICE[device.category]!.label) : device?.category;
  const deviceText = [deviceLabel, device?.browser, device?.os].filter(Boolean).join(' · ');
  const time = localTime(p?.timezone ?? null);
  const pages = s && !s.browsingHidden ? [...s.pages].reverse().slice(0, 10) : [];
  const dept = chat?.departmentId ? departments.get(chat.departmentId)?.name : null;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <p className="flex items-center gap-1.5 text-base font-semibold text-fg">
          <bdi className="truncate">{name}</bdi>
          {p?.verified && (
            <BadgeCheck
              className="size-4 shrink-0 text-success"
              aria-label={t('visitors.display.verified')}
            />
          )}
        </p>
        {email && (
          <p className="truncate text-sm text-fg-2" dir="ltr">
            {email}
          </p>
        )}
        {phone && (
          <p className="truncate text-sm text-fg-2" dir="ltr">
            {phone}
          </p>
        )}
      </div>

      <dl className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
        {place && (
          <Row label={t('dock.info.location')}>
            {flagEmoji(code) && <span className="me-1.5">{flagEmoji(code)}</span>}
            {place}
          </Row>
        )}
        {time && <Row label={t('dock.info.localTime')}>{time}</Row>}
        {ip && (
          <Row label={t('visitors.live.col.ip')}>
            <span className="font-mono text-xs" dir="ltr">
              {ip}
            </span>
            {s?.network && <span className="block text-xs text-fg-2">{s.network}</span>}
          </Row>
        )}
        {deviceText && <Row label={t('dock.info.device')}>{deviceText}</Row>}
        {p?.language && (
          <Row label={t('common.language')}>
            <span dir="ltr">{p.language}</span>
          </Row>
        )}
        {s && !s.browsingHidden && s.referrerOrigin && (
          <Row label={t('visitors.live.col.referrer')}>{originLabel(s.referrerOrigin)}</Row>
        )}
        {p && (
          <Row label={t('dock.info.history')}>
            {t('dock.info.visitsChats', {
              visits: formatNumber(p.visitCount),
              chats: formatNumber(p.chatCount),
            })}
          </Row>
        )}
        {chat && <Row label={t('common.department')}>{dept ? <bdi>{dept}</bdi> : t('common.none')}</Row>}
      </dl>

      {pages.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-2">
            {t('dock.info.path')}
          </h3>
          <ol className="flex flex-col">
            {pages.map((pg, i) => (
              <li key={`${pg.enteredAt}-${i}`} className="flex items-baseline gap-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto" title={urlLabel(pg.url)}>
                  {pg.title || urlLabel(pg.url)}
                </span>
                <time dateTime={pg.enteredAt} className="shrink-0 text-xs text-fg-3">
                  {formatTime(pg.enteredAt)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      )}

      {canView && (
        <p className="text-xs text-fg-2">
          {p && t('dock.info.firstSeen', { when: formatRelative(p.firstSeenAt) })}{' '}
          <Link href={`/visitors/${visitorId}`} className="font-medium text-primary hover:underline">
            {t('inbox.visitor.openProfile')}
          </Link>
        </p>
      )}
    </div>
  );
}
