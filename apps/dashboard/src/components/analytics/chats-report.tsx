'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BarChart3, Table2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { Banner, Card, CardBody, EmptyState, PanelError, Skeleton } from '@/components/ui';
import { intlLocale, tStatic, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { toCamelKey } from '@/lib/wire';
import { FreshnessBanner, FreshnessLine } from './freshness';
import { MeasureCard, MeasureCardSkeleton } from './measure-card';
import { formatSeconds, GROUP_LABELS, GROUP_ORDER, groupOf, seriesValue, type MeasureGroup } from './measures';
import { todayIn } from './range';
import type { ChartRow, SeriesDef } from './series-chart';

/** The chart (recharts) loads after the numbers: keeps /analytics within the initial-route budget (ch. 60). */
const SeriesChart = dynamic(() => import('./series-chart').then((m) => m.SeriesChart), { ssr: false, loading: () => <Skeleton className="h-72 w-full" /> });
import type { ChatsReport } from './types';
import { chatsQuery, type AnalyticsParams } from './use-analytics-params';

/** Series labels are message keys, translated when the chart renders. */
const VOLUME: Array<Omit<SeriesDef, 'label'> & { label: MessageKey }> = [
  { id: 'requested', label: 'analytics.chats.series.requested', slot: 0, marker: 'circle' },
  { id: 'served', label: 'analytics.chats.series.served', slot: 1, dash: 'dashed', marker: 'square' },
  { id: 'missed', label: 'analytics.chats.series.missed', slot: 2, dash: 'dotted', marker: 'triangle' },
];

const RESPONSE: Array<Omit<SeriesDef, 'label'> & { label: MessageKey }> = [
  { id: 'median', label: 'analytics.chats.series.median', slot: 0, marker: 'circle' },
  { id: 'p90', label: 'analytics.chats.series.p90', slot: 1, dash: 'dashed', marker: 'square' },
];

export function useChatsReport(p: AnalyticsParams, enabled = true) {
  const query = chatsQuery(p);
  return useQuery({
    queryKey: ['analytics', 'chats', query],
    queryFn: () => api.get<ChatsReport>('/analytics/chats', query),
    enabled: enabled && !p.range.error,
    placeholderData: keepPreviousData,
    // Ranges that include "now" keep refreshing; the API caches by source watermark.
    refetchInterval: p.range.last >= todayIn(p.timezone) ? 60_000 : false,
  });
}

/** Local calendar date of a UTC instant in the report timezone. */
function dayIn(iso: string, tz: string, endExclusive = false): string {
  const t = new Date(iso).getTime() - (endExclusive ? 1 : 0);
  try {
    return new Date(t).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
  } catch {
    return new Date(t).toLocaleDateString(intlLocale());
  }
}

export function spanLabel(r: { from: string; to: string }, tz: string): string {
  const a = dayIn(r.from, tz);
  const b = dayIn(r.to, tz, true);
  return a === b ? a : tStatic('analytics.range.span', { from: a, to: b });
}

export function ChatsReportView({ params: p, update }: { params: AnalyticsParams; update: (patch: Record<string, string | null>) => void }) {
  const t = useT();
  const q = useChatsReport(p);
  const report = q.data;

  const rows = useMemo<{ volume: ChartRow[]; response: ChartRow[] }>(() => {
    if (!report) return { volume: [], response: [] };
    return {
      volume: report.series.map((b) => ({
        key: b.key,
        start: b.start,
        requested: seriesValue(b.measures, 'requested')?.value ?? 0,
        served: seriesValue(b.measures, 'served')?.value ?? 0,
        missed: seriesValue(b.measures, 'missed')?.value ?? 0,
      })),
      response: report.series.map((b) => {
        const m = seriesValue(b.measures, 'first_response_time');
        return { key: b.key, start: b.start, median: m?.median ?? null, p90: m?.p90 ?? null, n: m?.n ?? 0 };
      }),
    };
  }, [report]);

  const groups = useMemo(() => {
    const out = new Map<MeasureGroup, string[]>();
    for (const key of report?.measureKeys ?? []) {
      if (!report?.measures[toCamelKey(key)]) continue;
      const g = groupOf(key);
      out.set(g, [...(out.get(g) ?? []), key]);
    }
    return GROUP_ORDER.filter((g) => out.has(g)).map((g) => ({ group: g, keys: out.get(g)! }));
  }, [report]);

  if (p.range.error) {
    return <EmptyState title={t('analytics.report.invalidRange')} description={p.range.error} />;
  }
  if (q.isPending) return <ChatsSkeleton />;
  if (q.error && !report) {
    const field = isApiError(q.error) ? (q.error.field('from') ?? q.error.field('to')) : undefined;
    return (
      <Card>
        <PanelError
          message={field && field !== errorMessage(q.error) ? t('analytics.chats.loadErrorField', { error: errorMessage(q.error), field }) : t('analytics.chats.loadError', { error: errorMessage(q.error) })}
          onRetry={() => void q.refetch()}
        />
      </Card>
    );
  }
  if (!report) return null;

  const multiDay = report.series.length > 0 && report.series[0]!.key.slice(0, 10) !== report.series[report.series.length - 1]!.key.slice(0, 10);
  const tz = report.range.timezone;
  const requested = report.measures.requested?.value ?? 0;
  const [reconcileBefore, reconcileCode, reconcileAfter] = t('analytics.chats.reconcileBody').split(/<code>|<\/code>/);
  const volumeSeries: SeriesDef[] = VOLUME.map((s) => ({ ...s, label: t(s.label) }));
  const responseSeries: SeriesDef[] = RESPONSE.map((s) => ({ ...s, label: t(s.label) }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <FreshnessBanner freshness={report.freshness} timezone={tz} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />
        {p.reconcile && (
          <Banner tone="info" title={t('analytics.chats.reconcileTitle')}>
            {reconcileBefore}
            <code className="font-mono" dir="ltr">
              {reconcileCode}
            </code>
            {reconcileAfter}
          </Banner>
        )}
        {q.error && <Banner tone="danger">{t('analytics.report.refreshFailed', { error: errorMessage(q.error) })}</Banner>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm font-medium text-fg">
              {spanLabel(report.range, tz)} ·{' '}
              <span className="text-fg-2" dir="auto">
                {report.range.timezoneLabel}
              </span>
            </p>
            <p className="text-xs text-fg-2">
              {report.comparisonRange ? `${t('analytics.chats.comparedWith', { span: spanLabel(report.comparisonRange, tz) })} ` : ''}
              {t('analytics.chats.halfOpen')}
              {report.scope.departmentIds !== 'all' ? ` ${t('analytics.chats.limited')}` : ''}
            </p>
            <FreshnessLine freshness={report.freshness} timezone={tz} />
          </div>
          <ViewToggle value={p.view} onChange={(v) => update({ view: v === 'chart' ? null : v })} />
        </div>
      </div>

      {requested === 0 && (report.measures.offlineSubmissions?.value ?? 0) === 0 && (
        <Banner tone="info">{p.siteId || p.departmentId || p.currentDepartmentId || p.agentId || p.tagId ? t('analytics.chats.noChatsFiltered') : t('analytics.chats.noChats')}</Banner>
      )}

      <div className={cn('grid grid-cols-1 gap-4', p.view === 'chart' && 'xl:grid-cols-2')} aria-busy={q.isFetching || undefined}>
        <Card>
          <CardBody>
            <SeriesChart
              title={t('analytics.chats.volumeTitle')}
              description={t('analytics.chats.volumeHint')}
              rows={rows.volume}
              series={volumeSeries}
              group={report.range.groupBy ?? p.group}
              multiDay={multiDay}
              view={p.view}
              format={(v) => formatNumber(v ?? 0)}
              emptyText={t('analytics.chats.volumeEmpty')}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <SeriesChart
              title={t('analytics.chats.responseTitle')}
              description={t('analytics.chats.responseHint')}
              rows={rows.response}
              series={responseSeries}
              group={report.range.groupBy ?? p.group}
              multiDay={multiDay}
              view={p.view}
              format={(v) => (v === null ? '—' : formatSeconds(v))}
              axisFormat={(v) => formatSeconds(v)}
              extraColumns={[{ id: 'n', label: t('analytics.chats.sampleColumn'), render: (r) => formatNumber(r.n as number) }]}
              emptyText={t('analytics.chats.responseEmpty')}
            />
          </CardBody>
        </Card>
      </div>

      {groups.map(({ group, keys }) => (
        <section key={group} className="flex flex-col gap-3" aria-labelledby={`grp-${group}`}>
          <div>
            <h2 id={`grp-${group}`} className="text-base font-semibold">
              {t(GROUP_LABELS[group].title)}
            </h2>
            {GROUP_LABELS[group].description && <p className="text-sm text-fg-2">{t(GROUP_LABELS[group].description)}</p>}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {keys.map((k) => (
              <MeasureCard key={k} measure={report.measures[toCamelKey(k)]!} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ViewToggle({ value, onChange }: { value: 'chart' | 'table'; onChange: (v: 'chart' | 'table') => void }) {
  const t = useT();
  return (
    <div role="group" aria-label={t('analytics.chats.chartDisplay')} className="inline-flex rounded-[var(--radius-control)] border border-line bg-surface p-0.5">
      {(
        [
          { v: 'chart', label: t('analytics.chats.chart'), Icon: BarChart3 },
          { v: 'table', label: t('analytics.chats.table'), Icon: Table2 },
        ] as const
      ).map(({ v, label, Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn('inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors', value === v ? 'bg-primary-tint text-primary-hover dark:text-primary' : 'text-fg-2 hover:bg-surface-3 hover:text-fg')}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

function ChatsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <Skeleton className="h-10 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Skeleton className="h-[340px] rounded-[var(--radius-card)]" />
        <Skeleton className="h-[340px] rounded-[var(--radius-card)]" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <MeasureCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
