'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Users } from 'lucide-react';
import { Banner, Card, CardBody, CardHeader, EmptyState, PanelError, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { tStatic, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { spanLabel } from './chats-report';
import { ExportControl } from './export-control';
import { FreshnessLine } from './freshness';
import { formatPct, formatSeconds } from './measures';
import { AGENT_MAX_DAYS } from './range';
import type { AgentReportRow, AgentsReport, Distribution } from './types';
import { agentsQuery, type AnalyticsParams } from './use-analytics-params';

const DEF_LABELS: Record<string, MessageKey> = {
  handledChats: 'analytics.agents.def.handledChats',
  ownedSeconds: 'analytics.agents.def.ownedSeconds',
  replies: 'analytics.agents.def.replies',
  firstResponseTime: 'analytics.agents.def.firstResponseTime',
  responseTime: 'analytics.agents.def.responseTime',
  utilization: 'analytics.agents.def.utilization',
  percentileMethod: 'analytics.agents.def.percentileMethod',
  capacity: 'analytics.agents.def.capacity',
};

const ROLE_LABEL: Record<string, MessageKey> = {
  owner: 'analytics.role.owner',
  admin: 'analytics.role.admin',
  supervisor: 'analytics.role.supervisor',
  agent: 'analytics.role.agent',
  analyst: 'analytics.role.analyst',
};

function hours(seconds: number): string {
  if (!seconds) return tStatic('analytics.agents.hours', { n: 0 });
  const h = seconds / 3600;
  return h < 1 ? tStatic('analytics.agents.minutes', { n: Math.round(seconds / 60) }) : tStatic('analytics.agents.hours', { n: formatNumber(h, { maximumFractionDigits: 1 }) });
}

function Dist({ d }: { d: Distribution }) {
  const t = useT();
  if (!d.n) return <span className="text-fg-2">{t('analytics.agents.noSamples')}</span>;
  return (
    <span className="flex flex-col items-end">
      <span>{formatSeconds(d.median)}</span>
      <span className="text-xs text-fg-2">{t('analytics.agents.p90n', { p90: formatSeconds(d.p90), n: formatNumber(d.n) })}</span>
    </span>
  );
}

function Utilization({ u }: { u: AgentReportRow['utilization'] }) {
  const t = useT();
  if (u.value === null) return <span className="text-fg-2">{t('analytics.agents.notOnline')}</span>;
  return (
    <span className="flex flex-col items-end">
      <span className="inline-flex items-center gap-1">
        {u.invariantViolation && <AlertTriangle className="size-3.5 text-warning" aria-hidden />}
        {formatPct(u.value)}
      </span>
      <span className="text-xs text-fg-2">{t('analytics.agents.slotTime', { used: hours(u.numerator), available: hours(u.denominator) })}</span>
      {u.invariantViolation && <span className="text-xs font-medium text-warning">{t('analytics.agents.capped', { raw: formatPct(u.raw) })}</span>}
    </span>
  );
}

export function AgentsReportView({ params: p }: { params: AnalyticsParams }) {
  const t = useT();
  const query = agentsQuery(p);
  const tooLong = p.range.days > AGENT_MAX_DAYS;
  const q = useQuery({
    queryKey: ['analytics', 'agents', query],
    queryFn: () => api.get<AgentsReport>('/analytics/agents', query),
    enabled: !p.range.error && !tooLong,
    placeholderData: keepPreviousData,
  });

  if (p.range.error) return <EmptyState title={t('analytics.report.invalidRange')} description={p.range.error} />;
  if (tooLong) return <EmptyState icon={<Users />} title={t('analytics.agents.tooLongTitle')} description={t('analytics.agents.tooLongBody', { days: AGENT_MAX_DAYS })} />;
  if (q.isPending) return <Skeleton className="h-80 rounded-[var(--radius-card)]" />;
  if (q.error && !q.data) return <Card><PanelError message={t('analytics.agents.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} /></Card>;
  const r = q.data;
  if (!r) return null;
  const tz = r.range.timezone;
  const totals = r.totals;

  return (
    <div className="flex flex-col gap-4" aria-busy={q.isFetching || undefined}>
      {q.error && <Banner tone="danger">{t('analytics.report.refreshFailed', { error: errorMessage(q.error) })}</Banner>}
      <Card>
        <CardHeader
          title={t('analytics.agents.title')}
          description={t('analytics.agents.description', {
            span: spanLabel(r.range, tz),
            timezone: r.range.timezoneLabel,
            sum: formatNumber(totals.handledChatsSum),
            distinct: formatNumber(totals.distinctChatsHandled),
          })}
          action={<ExportControl report="agents" filters={query} label={t('analytics.agents.export')} />}
        />
        {r.agents.length === 0 ? (
          <EmptyState icon={<Users />} title={t('analytics.agents.emptyTitle')} description={t('analytics.agents.emptyBody')} />
        ) : (
          <TableScroll>
            <Table className="min-w-[960px]">
              <caption className="sr-only">{t('analytics.agents.caption')}</caption>
              <THead>
                <tr>
                  <TH>{t('common.agent')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.handled')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.replies')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.firstResponse')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.betweenTurns')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.utilization')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.csat')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.online')}</TH>
                  <TH className="text-end">{t('analytics.agents.col.transfers')}</TH>
                </tr>
              </THead>
              <tbody>
                {r.agents.map((a) => {
                  const role = ROLE_LABEL[a.role] ? t(ROLE_LABEL[a.role]!) : a.role;
                  return (
                    <TR key={a.membershipId}>
                      <TD>
                        <span className="flex flex-col">
                          <span className="font-medium" dir="auto">
                            {a.displayName}
                          </span>
                          <span className="text-xs capitalize text-fg-2">
                            {a.enabled ? t('analytics.agents.rowMeta', { role, capacity: a.capacity }) : t('analytics.agents.rowMetaDisabled', { role, capacity: a.capacity })}
                          </span>
                        </span>
                      </TD>
                      <TD className="text-end tabular">
                        <span className="flex flex-col items-end">
                          <span>{formatNumber(a.handledChats)}</span>
                          <span className="text-xs text-fg-2">{t('analytics.agents.owned', { time: hours(a.ownedSeconds) })}</span>
                        </span>
                      </TD>
                      <TD className="text-end tabular">
                        <span className="flex flex-col items-end">
                          <span>{formatNumber(a.replies)}</span>
                          <span className="text-xs text-fg-2">{t('analytics.agents.inChats', { count: a.repliedChats })}</span>
                        </span>
                      </TD>
                      <TD className="text-end tabular">
                        <Dist d={a.firstResponseTime} />
                      </TD>
                      <TD className="text-end tabular">
                        <Dist d={a.responseTime} />
                      </TD>
                      <TD className="text-end tabular">
                        <Utilization u={a.utilization} />
                      </TD>
                      <TD className="text-end tabular">
                        {a.ratings.csat.value === null ? (
                          <span className="text-fg-2">{t('analytics.agents.noRatings')}</span>
                        ) : (
                          <span className="flex flex-col items-end">
                            <span>{formatPct(a.ratings.csat.value)}</span>
                            <span className="text-xs text-fg-2">{t('analytics.agents.goodRated', { good: a.ratings.good, rated: a.ratings.csat.n })}</span>
                          </span>
                        )}
                      </TD>
                      <TD className="text-end tabular">{hours(a.onlineSeconds)}</TD>
                      <TD className="text-end tabular">
                        {formatNumber(a.transfersIn)} / {formatNumber(a.transfersOut)}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-line bg-surface-2">
                <TR>
                  <TH scope="row" className="normal-case">
                    {t('analytics.agents.totals', { count: totals.agents })}
                  </TH>
                  <TD className="text-end tabular">
                    <span className="flex flex-col items-end">
                      <span>{t('analytics.agents.distinct', { count: totals.distinctChatsHandled })}</span>
                      <span className="text-xs text-fg-2">{t('analytics.agents.sum', { count: totals.handledChatsSum })}</span>
                    </span>
                  </TD>
                  <TD className="text-end tabular">{formatNumber(totals.replies)}</TD>
                  <TD className="text-end tabular text-fg-2">{t('analytics.agents.firstReplies', { count: totals.firstResponses })}</TD>
                  <TD />
                  <TD className="text-end tabular">
                    <span className="flex flex-col items-end">
                      <span>{formatPct(totals.utilization)}</span>
                      <span className="text-xs text-fg-2">{t('analytics.agents.slotRatio', { used: hours(totals.occupiedSlotSeconds), available: hours(totals.availableSlotSeconds) })}</span>
                    </span>
                  </TD>
                  <TD />
                  <TD className="text-end tabular">{hours(totals.onlineSeconds)}</TD>
                  <TD />
                </TR>
              </tfoot>
            </Table>
          </TableScroll>
        )}
        <CardBody className="border-t border-line-subtle">
          <FreshnessLine freshness={r.freshness} timezone={tz} />
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-primary">{t('analytics.agents.definitions')}</summary>
            <dl className="mt-2 grid gap-2 text-fg-2 sm:grid-cols-[180px_1fr]">
              {Object.entries(r.definitions).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-medium text-fg">{DEF_LABELS[k] ? t(DEF_LABELS[k]!) : k}</dt>
                  {/* Definition sentences come verbatim from the API (English). */}
                  {v === 'nearest_rank' ? <dd>{t('analytics.agents.nearestRank')}</dd> : <dd dir="auto">{v}</dd>}
                </div>
              ))}
            </dl>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}
