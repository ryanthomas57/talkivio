'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { Banner, Card, CardBody, CardHeader, EmptyState, PanelError, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { spanLabel } from './chats-report';
import { ExportControl } from './export-control';
import { FreshnessLine } from './freshness';
import { formatPct } from './measures';
import type { Funnel, InvitationsReport } from './types';
import { invitationsQuery, type AnalyticsParams } from './use-analytics-params';
import { SERIES_COLORS, useIsDark } from './use-theme';

/** Labels are message keys; `rateLabel` is a whole phrase with a {pct} variable. */
const STAGES: Array<{ key: keyof Funnel; label: MessageKey; rate?: keyof Funnel; rateLabel?: MessageKey }> = [
  { key: 'eligible', label: 'analytics.invitations.stage.eligible' },
  { key: 'displayed', label: 'analytics.invitations.stage.displayed', rate: 'displayRate', rateLabel: 'analytics.invitations.rate.displayed' },
  { key: 'accepted', label: 'analytics.invitations.stage.accepted', rate: 'acceptanceRate', rateLabel: 'analytics.invitations.rate.accepted' },
  { key: 'served', label: 'analytics.invitations.stage.served', rate: 'serveRate', rateLabel: 'analytics.invitations.rate.served' },
];

/** Labels for the API's definition keys (the definition sentences themselves stay as sent). */
const DEF_LABELS: Record<string, MessageKey> = {
  population: 'analytics.invitations.def.population',
  displayed: 'analytics.invitations.stage.displayed',
  accepted: 'analytics.invitations.stage.accepted',
  served: 'analytics.invitations.stage.served',
  rates: 'analytics.invitations.def.rates',
};

export function InvitationsReportView({ params: p }: { params: AnalyticsParams }) {
  const t = useT();
  const query = invitationsQuery(p);
  const dark = useIsDark();
  const q = useQuery({
    queryKey: ['analytics', 'invitations', query],
    queryFn: () => api.get<InvitationsReport>('/analytics/invitations', query),
    enabled: !p.range.error,
    placeholderData: keepPreviousData,
  });

  if (p.range.error) return <EmptyState title={t('analytics.report.invalidRange')} description={p.range.error} />;
  if (q.isPending) return <Skeleton className="h-80 rounded-[var(--radius-card)]" />;
  if (q.error && !q.data) return <Card><PanelError message={t('analytics.invitations.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} /></Card>;
  const r = q.data;
  if (!r) return null;
  const tz = r.range.timezone;
  const max = Math.max(1, r.totals.eligible);
  const bar = (dark ? SERIES_COLORS.dark : SERIES_COLORS.light)[0];

  return (
    <div className="flex flex-col gap-4" aria-busy={q.isFetching || undefined}>
      {q.error && <Banner tone="danger">{t('analytics.report.refreshFailed', { error: errorMessage(q.error) })}</Banner>}
      <Card>
        <CardHeader
          title={t('analytics.invitations.title')}
          description={t('analytics.invitations.description', { span: spanLabel(r.range, tz), timezone: r.range.timezoneLabel })}
          action={<ExportControl report="invitations" filters={query} label={t('analytics.invitations.export')} />}
        />
        <CardBody>
          {r.totals.eligible === 0 ? (
            <EmptyState
              icon={<Megaphone />}
              title={t('analytics.invitations.emptyTitle')}
              description={p.siteId || p.departmentId ? t('analytics.invitations.emptyFiltered') : t('analytics.invitations.emptyBody')}
            />
          ) : (
            <ol className="flex flex-col gap-3" aria-label={t('analytics.invitations.stages')}>
              {STAGES.map((s) => {
                const v = r.totals[s.key] as number;
                const rate = s.rate ? (r.totals[s.rate] as number | null) : null;
                return (
                  <li key={s.key} className="grid grid-cols-1 gap-1 sm:grid-cols-[180px_1fr_auto] sm:items-center sm:gap-4">
                    <span className="text-sm font-medium text-fg">{t(s.label)}</span>
                    <span className="h-3 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                      <span className="block h-full rounded-full" style={{ width: `${(v / max) * 100}%`, background: bar }} />
                    </span>
                    <span className="text-sm tabular text-fg">
                      {formatNumber(v)}
                      {s.rate && s.rateLabel && (
                        <span className="text-fg-2"> · {rate === null ? t('analytics.invitations.denominatorZero') : t(s.rateLabel, { pct: formatPct(rate) })}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </CardBody>
        {r.campaigns.length > 0 && (
          <TableScroll className="border-t border-line-subtle">
            <Table className="min-w-[720px]">
              <caption className="sr-only">{t('analytics.invitations.caption')}</caption>
              <THead>
                <tr>
                  <TH>{t('analytics.invitations.col.campaign')}</TH>
                  <TH className="text-end">{t('analytics.invitations.col.eligible')}</TH>
                  <TH className="text-end">{t('analytics.invitations.stage.displayed')}</TH>
                  <TH className="text-end">{t('analytics.invitations.stage.accepted')}</TH>
                  <TH className="text-end">{t('analytics.invitations.stage.served')}</TH>
                  <TH className="text-end">{t('analytics.invitations.col.acceptanceRate')}</TH>
                </tr>
              </THead>
              <tbody>
                {r.campaigns.map((c) => (
                  <TR key={c.campaignId}>
                    <TD className="font-medium" dir={c.name ? 'auto' : undefined}>
                      {c.name ?? t('analytics.invitations.deletedCampaign')}
                    </TD>
                    <TD className="text-end tabular">{formatNumber(c.eligible)}</TD>
                    <TD className="text-end tabular">{formatNumber(c.displayed)}</TD>
                    <TD className="text-end tabular">{formatNumber(c.accepted)}</TD>
                    <TD className="text-end tabular">{formatNumber(c.served)}</TD>
                    <TD className="text-end tabular">
                      {c.acceptanceRate === null ? '—' : formatPct(c.acceptanceRate)}
                      <span className="block text-xs text-fg-2">
                        {formatNumber(c.accepted)} ÷ {formatNumber(c.displayed)}
                      </span>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
        <CardBody className="border-t border-line-subtle">
          <FreshnessLine freshness={r.freshness} timezone={tz} />
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-primary">{t('analytics.agents.definitions')}</summary>
            <dl className="mt-2 grid gap-2 text-fg-2 sm:grid-cols-[140px_1fr]">
              {Object.entries(r.definitions).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-medium capitalize text-fg">{DEF_LABELS[k] ? t(DEF_LABELS[k]!) : k}</dt>
                  {/* Definition sentences come verbatim from the API (English). */}
                  <dd dir="auto">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}
