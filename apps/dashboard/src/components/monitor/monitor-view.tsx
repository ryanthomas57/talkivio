'use client';
import { ArrowDown, ArrowUp, Gauge, Users } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Page,
  PageHeader,
  PanelError,
  Select,
  Skeleton,
  StatusLabel,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { formatSeconds } from '@/components/analytics/measures';
import { timeIn } from '@/components/analytics/use-theme';
import { useT, type MessageKey } from '@/i18n';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useDepartments } from '@/lib/queries';
import { useCan, useSession } from '@/stores/session';
import { MonitorCounters, WaitLevelLabel } from './counters';
import type { AgentGridRow, MonitorSnapshot } from './types';
import { levelFor, tickingSeconds, useMonitor } from './use-monitor';

type SortKey = 'load' | 'backlog' | 'unanswered' | 'name';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_LABEL: Record<string, MessageKey> = {
  owner: 'monitor.role.owner',
  admin: 'monitor.role.admin',
  supervisor: 'monitor.role.supervisor',
  agent: 'monitor.role.agent',
  analyst: 'monitor.role.analyst',
};

/** Supervisor wall (ch. 49): live counters, department load and the agent grid. */
export function MonitorView() {
  const t = useT();
  const canView = useCan('monitor.view');
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const deptParam = sp.get('department');
  const departmentId = deptParam && UUID_RE.test(deptParam) ? deptParam : null;
  const sort: SortKey =
    (['load', 'backlog', 'unanswered', 'name'] as const).find((k) => k === sp.get('sort')) ?? 'load';
  const setParam = (k: string, v: string | null) => {
    const q = new URLSearchParams(sp.toString());
    if (v) q.set(k, v);
    else q.delete(k);
    router.replace(q.toString() ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  const m = useMonitor(departmentId, canView);
  const scope = useSession((s) => s.agent?.departmentScope ?? 'all');
  const departments = useDepartments(canView);
  const deptOptions = useMemo(
    () =>
      (departments.data ?? [])
        .filter((d) => !d.archivedAt && (scope === 'all' || scope.includes(d.id)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [departments.data, scope],
  );

  if (!canView) {
    return (
      <Page>
        <EmptyState
          icon={<Gauge />}
          title={t('monitor.view.noAccessTitle')}
          description={t('monitor.view.noAccessBody')}
        />
      </Page>
    );
  }

  const s = m.snapshot;
  return (
    <Page>
      <PageHeader
        title={t('monitor.view.title')}
        description={t('monitor.view.description')}
        actions={
          <Field label={t('common.department')} className="w-full min-w-[220px] sm:w-auto">
            <Select
              value={departmentId ?? ''}
              onChange={(e) => setParam('department', e.target.value || null)}
            >
              <option value="">
                {scope === 'all' ? t('monitor.view.allDepartments') : t('monitor.view.allMyDepartments')}
              </option>
              {deptOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        }
      />

      {m.isPending ? (
        <MonitorSkeleton />
      ) : m.error && !s ? (
        <Card>
          <PanelError
            message={t('monitor.view.unavailable', { error: errorMessage(m.error) })}
            onRetry={() => void m.refetch()}
          />
        </Card>
      ) : s ? (
        <>
          <LiveStatus
            snapshot={s}
            stale={m.stale}
            silent={m.silent}
            conn={m.conn}
            refetching={m.isFetching}
            onRefresh={() => void m.refetch()}
            error={m.error ? errorMessage(m.error) : null}
          />
          <WaitAnnouncer snapshot={s} receivedAt={m.receivedAt} now={m.now} />
          <MonitorCounters snapshot={s} stale={m.stale} receivedAt={m.receivedAt} now={m.now} />
          <DepartmentsCard snapshot={s} receivedAt={m.receivedAt} now={m.now} />
          <AgentGrid
            snapshot={s}
            receivedAt={m.receivedAt}
            now={m.now}
            sort={sort}
            onSort={(k) => setParam('sort', k === 'load' ? null : k)}
          />
        </>
      ) : null}
    </Page>
  );
}

function LiveStatus({
  snapshot: s,
  stale,
  silent,
  conn,
  refetching,
  onRefresh,
  error,
}: {
  snapshot: MonitorSnapshot;
  stale: boolean;
  silent: boolean;
  conn: string;
  refetching: boolean;
  onRefresh: () => void;
  error: string | null;
}) {
  const t = useT();
  const tz = s.counters.csat.timezone;
  const seconds = Math.round(s.thresholds.staleAfterMs / 1000);
  const [asOfBefore, asOfTime, asOfAfter] = t('monitor.live.asOf', {
    time: timeIn(s.asOf, tz),
    timezone: tz,
  }).split(/<time>|<\/time>/);
  return (
    <div className="flex flex-col gap-2">
      {stale ? (
        <Banner
          tone="warning"
          title={t('monitor.live.staleTitle')}
          action={
            <Button size="sm" variant="secondary" onClick={onRefresh} loading={refetching}>
              {t('monitor.live.refreshNow')}
            </Button>
          }
        >
          {silent
            ? conn !== 'live'
              ? t('monitor.live.silentConn', { seconds, conn })
              : t('monitor.live.silent', { seconds })
            : conn !== 'live'
              ? t('monitor.live.serverStaleConn', { conn })
              : t('monitor.live.serverStale')}{' '}
          {t('monitor.live.figuresAsOf', { date: formatDateTime(s.asOf, tz) })}
          {error ? ` ${t('monitor.live.refreshFailed', { error })}` : ''}
        </Banner>
      ) : (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-success">
            <span className="size-2 rounded-full bg-success" aria-hidden />
            {t('monitor.live.live')}
          </span>
          <span>
            {asOfBefore}
            <time dateTime={s.asOf}>{asOfTime}</time>
            {asOfAfter}
          </span>
          {s.scope.departmentIds !== 'all' && <span>{t('monitor.live.limited')}</span>}
        </p>
      )}
    </div>
  );
}

/** Screen-reader announcement only when the oldest-wait severity changes (not every tick). */
function WaitAnnouncer({
  snapshot: s,
  receivedAt,
  now,
}: {
  snapshot: MonitorSnapshot;
  receivedAt: number;
  now: number;
}) {
  const t = useT();
  const wait = s.counters.queued > 0 ? tickingSeconds(s.counters.oldestWaitSeconds, receivedAt, now) : null;
  const level = levelFor(wait, s.thresholds.queueWarningSeconds, s.thresholds.queueCriticalSeconds);
  const prev = useRef(level);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (prev.current === level) return;
    const was = prev.current;
    prev.current = level;
    if (level === 'warning' || level === 'critical')
      setMsg(t('monitor.announce.level', { level, duration: formatSeconds(wait), count: s.counters.queued }));
    else if (was === 'warning' || was === 'critical') setMsg(t('monitor.announce.back'));
  }, [level, wait, s.counters.queued, t]);
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {msg}
    </p>
  );
}

function DepartmentsCard({
  snapshot: s,
  receivedAt,
  now,
}: {
  snapshot: MonitorSnapshot;
  receivedAt: number;
  now: number;
}) {
  const t = useT();
  const th = { warning: s.thresholds.queueWarningSeconds, critical: s.thresholds.queueCriticalSeconds };
  const busy = s.busyDepartments.length;
  return (
    <Card>
      <CardHeader
        title={t('common.departments')}
        description={
          busy ? t('monitor.departments.busy', { count: busy }) : t('monitor.departments.noneBusy')
        }
      />
      {s.departments.length === 0 ? (
        <EmptyState
          title={t('monitor.departments.emptyTitle')}
          description={t('monitor.departments.emptyBody')}
        />
      ) : (
        <TableScroll>
          <Table className="min-w-[760px]">
            <caption className="sr-only">{t('monitor.departments.caption')}</caption>
            <THead>
              <tr>
                <TH>{t('common.department')}</TH>
                <TH className="text-end">{t('monitor.col.queued')}</TH>
                <TH>{t('monitor.col.oldestWait')}</TH>
                <TH className="text-end">{t('monitor.col.active')}</TH>
                <TH className="text-end">{t('monitor.col.offers')}</TH>
                <TH className="text-end">{t('monitor.col.backlog')}</TH>
                <TH className="text-end">{t('monitor.col.availableOnline')}</TH>
              </tr>
            </THead>
            <tbody>
              {s.departments.map((d) => {
                const wait = d.queued > 0 ? tickingSeconds(d.oldestWaitSeconds, receivedAt, now) : null;
                const level = levelFor(wait, th.warning, th.critical);
                return (
                  <TR
                    key={d.departmentId ?? 'none'}
                    className={cn(
                      level === 'critical' && 'bg-danger-tint/60',
                      level === 'warning' && 'bg-warning-tint/60',
                    )}
                  >
                    <TD>
                      <span className="flex flex-wrap items-center gap-2">
                        {d.departmentId === null ? (
                          <span className="font-medium">{t('monitor.departments.noDepartment')}</span>
                        ) : (
                          <span className="font-medium" dir="auto">
                            {d.name}
                          </span>
                        )}
                        {d.busy && <Badge tone="warning">{t('monitor.departments.busyBadge')}</Badge>}
                      </span>
                    </TD>
                    <TD className="text-end tabular">{formatNumber(d.queued)}</TD>
                    <TD>
                      <span className="flex flex-col">
                        <span className="tabular">
                          {wait === null ? t('common.notAvailable') : formatSeconds(wait)}
                        </span>
                        <WaitLevelLabel level={level} thresholds={th} />
                      </span>
                    </TD>
                    <TD className="text-end tabular">{formatNumber(d.active)}</TD>
                    <TD className="text-end tabular">{formatNumber(d.offeredReservations)}</TD>
                    <TD className="text-end tabular">{formatNumber(d.responseBacklog)}</TD>
                    <TD
                      className={cn(
                        'text-end tabular',
                        d.queued > 0 && d.availableAgents === 0 && 'font-medium text-danger',
                      )}
                    >
                      {formatNumber(d.availableAgents)} / {formatNumber(d.onlineAgents)}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </Card>
  );
}

function sortAgents(rows: AgentGridRow[], sort: SortKey): AgentGridRow[] {
  const copy = [...rows];
  const name = (a: AgentGridRow, b: AgentGridRow) => a.displayName.localeCompare(b.displayName);
  switch (sort) {
    case 'backlog':
      return copy.sort(
        (a, b) =>
          b.responseBacklog - a.responseBacklog ||
          (b.oldestUnansweredSeconds ?? -1) - (a.oldestUnansweredSeconds ?? -1) ||
          name(a, b),
      );
    case 'unanswered':
      return copy.sort(
        (a, b) => (b.oldestUnansweredSeconds ?? -1) - (a.oldestUnansweredSeconds ?? -1) || name(a, b),
      );
    case 'name':
      return copy.sort(name);
    default:
      return copy.sort(
        (a, b) => (b.loadPct ?? 0) - (a.loadPct ?? 0) || b.responseBacklog - a.responseBacklog || name(a, b),
      );
  }
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
  desc = true,
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  className?: string;
  desc?: boolean;
}) {
  const t = useT();
  const active = sort === k;
  const Icon = desc ? ArrowDown : ArrowUp;
  return (
    <TH className={className} aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex min-h-8 items-center gap-1 uppercase tracking-wide hover:text-fg',
          active && 'text-fg',
        )}
      >
        {label}
        <Icon className={cn('size-3.5', !active && 'invisible')} aria-hidden />
        {!active && (
          <span className="sr-only">{t('monitor.agents.sortBy', { label: label.toLowerCase() })}</span>
        )}
      </button>
    </TH>
  );
}

function AgentGrid({
  snapshot: s,
  receivedAt,
  now,
  sort,
  onSort,
}: {
  snapshot: MonitorSnapshot;
  receivedAt: number;
  now: number;
  sort: SortKey;
  onSort: (k: SortKey) => void;
}) {
  const t = useT();
  const rows = useMemo(() => sortAgents(s.agents, sort), [s.agents, sort]);
  const th = { warning: s.thresholds.queueWarningSeconds, critical: s.thresholds.queueCriticalSeconds };
  return (
    <Card>
      <CardHeader title={t('monitor.agents.title')} description={t('monitor.agents.description')} />
      {rows.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={t('monitor.agents.emptyTitle')}
          description={t('monitor.agents.emptyBody')}
        />
      ) : (
        <TableScroll>
          <Table className="min-w-[860px]">
            <caption className="sr-only">{t('monitor.agents.caption', { sort })}</caption>
            <THead>
              <tr>
                <SortHeader label={t('common.agent')} k="name" sort={sort} onSort={onSort} desc={false} />
                <TH>{t('common.status')}</TH>
                <SortHeader label={t('monitor.col.load')} k="load" sort={sort} onSort={onSort} />
                <TH className="text-end">{t('monitor.col.active')}</TH>
                <TH className="text-end">{t('monitor.col.collab')}</TH>
                <TH className="text-end">{t('monitor.col.offers')}</TH>
                <SortHeader
                  label={t('monitor.col.backlog')}
                  k="backlog"
                  sort={sort}
                  onSort={onSort}
                  className="text-end"
                />
                <SortHeader
                  label={t('monitor.col.oldestUnanswered')}
                  k="unanswered"
                  sort={sort}
                  onSort={onSort}
                />
              </tr>
            </THead>
            <tbody>
              {rows.map((a) => {
                const age = tickingSeconds(a.oldestUnansweredSeconds, receivedAt, now);
                const level = levelFor(age, th.warning, th.critical);
                const used = a.activeChats + a.collaborations + a.reservedOffers;
                return (
                  <TR key={a.membershipId}>
                    <TD>
                      <span className="flex flex-col">
                        <span className="font-medium" dir="auto">
                          {a.displayName}
                        </span>
                        <span className="text-xs capitalize text-fg-2">
                          {ROLE_LABEL[a.role] ? t(ROLE_LABEL[a.role]!) : a.role}
                        </span>
                      </span>
                    </TD>
                    <TD>
                      <span className="flex flex-col gap-0.5">
                        <StatusLabel status={a.effectiveStatus} />
                        {a.effectiveStatus === 'online' && (
                          <span className={cn('text-xs', a.available ? 'text-success' : 'text-fg-2')}>
                            {a.available
                              ? t('monitor.agents.accepting')
                              : a.atCapacity
                                ? t('monitor.agents.atCapacity')
                                : t('monitor.agents.notAccepting')}
                          </span>
                        )}
                      </span>
                    </TD>
                    <TD>
                      <span className="flex min-w-[140px] flex-col gap-1">
                        <span className="text-sm tabular">
                          {t('monitor.agents.slots', { used, capacity: a.capacity })}
                          {a.atCapacity && (
                            <span className="ms-1.5 text-xs font-medium text-warning">
                              {t('monitor.agents.full')}
                            </span>
                          )}
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                          <span
                            className={cn(
                              'block h-full rounded-full',
                              a.atCapacity ? 'bg-warning' : 'bg-primary',
                            )}
                            style={{ width: `${Math.min(100, a.capacity ? (used / a.capacity) * 100 : 0)}%` }}
                          />
                        </span>
                      </span>
                    </TD>
                    <TD className="text-end tabular">{formatNumber(a.activeChats)}</TD>
                    <TD className="text-end tabular">{formatNumber(a.collaborations)}</TD>
                    <TD className="text-end tabular">{formatNumber(a.reservedOffers)}</TD>
                    <TD className="text-end tabular">{formatNumber(a.responseBacklog)}</TD>
                    <TD>
                      {age === null ? null : (
                        <span className="flex flex-col">
                          <span className="tabular">{formatSeconds(age)}</span>
                          <WaitLevelLabel level={level} thresholds={th} />
                        </span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </Card>
  );
}

function MonitorSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <Skeleton className="h-5 w-64" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 min-[1200px]:grid-cols-4">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-[var(--radius-card)]" />
        ))}
      </div>
      <Skeleton className="h-56 rounded-[var(--radius-card)]" />
      <Skeleton className="h-72 rounded-[var(--radius-card)]" />
    </div>
  );
}
