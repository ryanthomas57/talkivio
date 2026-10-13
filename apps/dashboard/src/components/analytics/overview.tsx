'use client';
/**
 * Role-aware home (ch. 06): agents see their own workload (live from the same
 * realtime events as the inbox), supervisors and admins see today's key measures
 * with freshness and, with `monitor.view`, the live monitor counters. Every
 * number carries its definition on demand.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, BarChart3, ChevronRight, Gauge, History, Inbox, Mail, Settings, UsersRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, Page, PageHeader, PanelError, Skeleton, StatusLabel } from '@/components/ui';
import { MonitorCounters } from '@/components/monitor/counters';
import { useMonitor } from '@/components/monitor/use-monitor';
import { useInboxCounts } from '@/components/shell/inbox-badge';
import { useConnectionState } from '@/hooks/use-realtime';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useCan, useSession } from '@/stores/session';
import { FreshnessBanner, FreshnessLine } from './freshness';
import { MeasureCard, MeasureCardSkeleton } from './measure-card';
import { measureOf } from './measures';
import { addDays, todayIn } from './range';
import type { ChatsReport } from './types';

const TODAY_KEYS = ['requested', 'served', 'missed', 'csat', 'first_response_time'];

export function OverviewView() {
  const t = useT();
  const canServe = useCan('chats.serve');
  const canAnalytics = useCan('analytics.view');
  const canMonitor = useCan('monitor.view');
  const name = useSession((s) => s.agent?.agent.displayName ?? s.me?.user.displayName ?? '');
  const tenantName = useSession((s) => s.tenant?.name ?? null);
  const workspace = tenantName ? isolate(tenantName) : t('analytics.overview.yourWorkspace');
  const first = name ? isolate(name.split(' ')[0]) : '';

  return (
    <Page>
      <PageHeader
        title={t('analytics.overview.title')}
        description={
          canAnalytics
            ? first
              ? t('analytics.overview.descTodayWelcome', { name: first, workspace })
              : t('analytics.overview.descToday', { workspace })
            : first
              ? t('analytics.overview.descWorkWelcome', { name: first, workspace })
              : t('analytics.overview.descWork', { workspace })
        }
      />
      {canServe && <MyWork />}
      {canMonitor && <LiveQueues />}
      {canAnalytics && <TodayMeasures />}
      <QuickLinks />
    </Page>
  );
}

function StatTile({ label, value, sub, definition, href, linkLabel }: { label: string; value: number | null; sub?: ReactNode; definition: string; href?: string; linkLabel?: string }) {
  const t = useT();
  return (
    <article className="flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <h3 className="text-sm font-medium text-fg-2">{label}</h3>
      <div className="text-[28px] font-semibold leading-9 tabular text-fg">{value === null ? <Skeleton className="h-9 w-12" /> : formatNumber(value)}</div>
      {sub}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <details className="group text-xs">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" aria-hidden />
            <span aria-hidden>{t('analytics.card.definition')}</span>
            <span className="sr-only">{t('analytics.card.definitionOf', { label })}</span>
          </summary>
          <p className="mt-1 rounded-md bg-surface-2 p-2.5 text-fg-2">{definition}</p>
        </details>
        {href && (
          <Link href={href} className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:underline">
            {linkLabel}
            <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
          </Link>
        )}
      </div>
    </article>
  );
}

function MyWork() {
  const t = useT();
  const counts = useInboxCounts();
  const status = useSession((s) => s.agent?.agent.desiredStatus ?? 'online');
  const conn = useConnectionState();
  const connected = conn === 'live';
  return (
    <section aria-labelledby="my-work" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="my-work" className="text-base font-semibold">
            {t('analytics.overview.yourWork')}
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
            {t('analytics.overview.yourStatus')} <StatusLabel status={status} className="font-medium text-fg" />
            <span>· {t('analytics.overview.connection', { state: connected ? 'live' : conn })}</span>
          </p>
        </div>
        <p className="text-xs text-fg-2">{t('analytics.overview.statusHint')}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={t('analytics.overview.myActive')} value={counts ? counts.mine : null} definition={t('analytics.overview.myActiveDef')} href="/inbox?view=mine" linkLabel={t('analytics.overview.openMyChats')} />
        <StatTile label={t('analytics.overview.unread')} value={counts ? counts.unreadMine : null} definition={t('analytics.overview.unreadDef')} href="/inbox" linkLabel={t('analytics.overview.openInbox')} />
        <StatTile
          label={t('analytics.overview.waiting')}
          value={counts ? counts.queue : null}
          definition={t('analytics.overview.waitingDef')}
          href="/inbox?view=queue"
          linkLabel={t('analytics.overview.openQueue')}
        />
        <StatTile label={t('analytics.overview.offers')} value={counts ? counts.pendingOffers : null} definition={t('analytics.overview.offersDef')} />
      </div>
    </section>
  );
}

function LiveQueues() {
  const t = useT();
  const m = useMonitor(null);
  return (
    <section aria-labelledby="live-queues" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="live-queues" className="text-base font-semibold">
            {t('analytics.overview.liveQueues')}
          </h2>
          <p className="text-sm text-fg-2">{m.stale ? t('analytics.overview.stale') : t('analytics.overview.fresh')}</p>
        </div>
        <Link href="/monitor" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-primary hover:underline">
          {t('analytics.overview.openMonitor')}
          <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
      </div>
      {m.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-[var(--radius-card)]" />
          ))}
        </div>
      ) : m.snapshot ? (
        <MonitorCounters snapshot={m.snapshot} stale={m.stale} receivedAt={m.receivedAt} now={m.now} compact />
      ) : (
        <Card>
          <PanelError message={t('analytics.overview.countersUnavailable', { error: errorMessage(m.error) })} onRetry={() => void m.refetch()} />
        </Card>
      )}
    </section>
  );
}

function TodayMeasures() {
  const t = useT();
  const tz = useSession((s) => s.tenant?.timezone ?? 'UTC');
  const today = todayIn(tz);
  const query = { from: today, to: addDays(today, 1), timezone: tz, groupBy: 'hour', compare: 'previous' };
  const q = useQuery({
    queryKey: ['analytics', 'chats', 'overview', query],
    queryFn: () => api.get<ChatsReport>('/analytics/chats', query),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const r = q.data;
  return (
    <section aria-labelledby="today" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="today" className="text-base font-semibold">
            {t('common.today')}
          </h2>
          <p className="text-sm text-fg-2">{r ? t('analytics.overview.comparedYesterday', { timezone: r.range.timezoneLabel }) : t('analytics.overview.sinceMidnight', { timezone: tz })}</p>
        </div>
        <Link href="/analytics" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-primary hover:underline">
          {t('analytics.overview.openAnalytics')}
          <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Link>
      </div>
      {q.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {TODAY_KEYS.map((k) => (
            <MeasureCardSkeleton key={k} />
          ))}
        </div>
      ) : !r ? (
        <Card>
          <PanelError message={t('analytics.overview.todayUnavailable', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
        </Card>
      ) : (
        <>
          <FreshnessBanner freshness={r.freshness} timezone={r.range.timezone} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {TODAY_KEYS.map((k) => {
              const m = measureOf(r, k);
              return m ? <MeasureCard key={k} measure={m} compact /> : null;
            })}
          </div>
          <FreshnessLine freshness={r.freshness} timezone={r.range.timezone} />
        </>
      )}
    </section>
  );
}

const QUICK_LINKS: Array<{ href: string; label: MessageKey; description: MessageKey; Icon: typeof Inbox; perm: string }> = [
  { href: '/inbox', label: 'analytics.overview.link.inbox', description: 'analytics.overview.link.inboxHint', Icon: Inbox, perm: 'chats.serve' },
  { href: '/offline-messages', label: 'analytics.overview.link.offline', description: 'analytics.overview.link.offlineHint', Icon: Mail, perm: 'offline.view' },
  { href: '/monitor', label: 'analytics.overview.link.monitor', description: 'analytics.overview.link.monitorHint', Icon: Gauge, perm: 'monitor.view' },
  { href: '/analytics', label: 'analytics.overview.link.analytics', description: 'analytics.overview.link.analyticsHint', Icon: BarChart3, perm: 'analytics.view' },
  { href: '/history', label: 'analytics.overview.link.history', description: 'analytics.overview.link.historyHint', Icon: History, perm: 'history.view' },
  { href: '/visitors', label: 'analytics.overview.link.visitors', description: 'analytics.overview.link.visitorsHint', Icon: UsersRound, perm: 'visitors.view' },
  { href: '/settings', label: 'analytics.overview.link.settings', description: 'analytics.overview.link.settingsHint', Icon: Settings, perm: 'tenant.manage' },
];

function QuickLinks() {
  const t = useT();
  const perms = useSession((s) => s.permissions);
  const links = QUICK_LINKS.filter((l) => perms.has(l.perm));
  if (!links.length) return null;
  return (
    <Card>
      <CardHeader title={t('analytics.overview.quickLinks')} />
      <CardBody>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex min-h-14 items-center gap-3 rounded-[var(--radius-control)] border border-line-subtle px-3 py-2 hover:bg-surface-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary-hover dark:text-primary">
                  <l.Icon className="size-4" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-fg">{t(l.label)}</span>
                  <span className="truncate text-xs text-fg-2">{t(l.description)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
