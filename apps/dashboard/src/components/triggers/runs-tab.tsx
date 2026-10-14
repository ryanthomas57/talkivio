'use client';
/**
 * Run history (GET /triggers/{id}/runs): time, match result and each effect's
 * outcome with its reason. Cursor pagination with a half-open date range.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, Clock3, History, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PanelError,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { actionLabel, eventLabel, reasonLabel } from './dsl-ui';
import { tk, type TriggerRun, type TriggerRunEffect } from './triggers-api';

/** yyyy-mm-dd (local) → RFC 3339 with the viewer's offset at local midnight. */
function localDayStart(day: string): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).toISOString();
}

function dayAfter(day: string): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d + 1).toISOString();
}

export function RunsTab({ triggerId }: { triggerId: string }) {
  const t = useT();
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const invalidRange = !!fromDay && !!toDay && fromDay > toDay;
  const from = localDayStart(fromDay) ?? '';
  const to = dayAfter(toDay) ?? '';
  const q = useInfiniteQuery({
    queryKey: tk.runs(triggerId, from, to),
    enabled: !invalidRange,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.page<TriggerRun>(
        `/triggers/${triggerId}/runs`,
        { from: from || undefined, to: to || undefined, cursor: pageParam ?? undefined, limit: 25 },
        signal,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
  });
  const runs = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader title={t('triggers.runs.title')} description={t('triggers.runs.description')} />
      <div className="flex flex-wrap items-end gap-3 border-b border-line-subtle px-4 py-3 sm:px-6">
        <Field label={t('common.from')} className="w-full sm:w-44">
          <Input
            type="date"
            value={fromDay}
            max={toDay || undefined}
            onChange={(e) => setFromDay(e.target.value)}
          />
        </Field>
        <Field
          label={t('triggers.runs.toInclusive')}
          className="w-full sm:w-44"
          error={invalidRange ? t('triggers.runs.rangeError') : undefined}
        >
          <Input
            type="date"
            value={toDay}
            min={fromDay || undefined}
            onChange={(e) => setToDay(e.target.value)}
          />
        </Field>
        {(fromDay || toDay) && (
          <Button
            variant="ghost"
            onClick={() => {
              setFromDay('');
              setToDay('');
            }}
          >
            {t('triggers.runs.clearDates')}
          </Button>
        )}
      </div>
      {q.isPending && !invalidRange ? (
        <div className="flex flex-col gap-2 p-4 sm:px-6" aria-busy>
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : q.isError ? (
        <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={fromDay || toDay ? t('triggers.runs.emptyRangeTitle') : t('triggers.runs.emptyTitle')}
          description={fromDay || toDay ? t('triggers.runs.emptyRangeBody') : t('triggers.runs.emptyBody')}
        />
      ) : (
        <>
          <TableScroll>
            <Table className="min-w-[760px]">
              <THead>
                <tr>
                  <TH>{t('common.time')}</TH>
                  <TH>{t('triggers.label.event')}</TH>
                  <TH>{t('triggers.runs.colResult')}</TH>
                  <TH>{t('triggers.runs.colEffects')}</TH>
                  <TH>{t('triggers.runs.colContext')}</TH>
                </tr>
              </THead>
              <tbody>
                {runs.map((r) => (
                  <TR key={r.id} className="align-top">
                    <TD className="whitespace-nowrap py-3 align-top">
                      <time dateTime={r.executedAt} title={formatDateTime(r.executedAt)} className="text-sm">
                        {formatDateTime(r.executedAt)}
                      </time>
                      <p className="text-xs text-fg-2">
                        {t('triggers.runs.timeMeta', {
                          relative: formatRelative(r.executedAt),
                          revision: r.triggerRevision,
                        })}
                      </p>
                    </TD>
                    <TD className="py-3 align-top text-sm">
                      {eventLabel(t, r.eventType)}
                      {r.depth > 0 && (
                        <p className="text-xs text-fg-2">{t('triggers.runs.causedBy', { depth: r.depth })}</p>
                      )}
                    </TD>
                    <TD className="py-3 align-top">
                      {r.matched ? (
                        <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
                          {t('triggers.runs.matched')}
                        </Badge>
                      ) : (
                        <Badge tone="neutral" icon={<XCircle className="size-3.5" aria-hidden />}>
                          {t('triggers.runs.notMatched')}
                        </Badge>
                      )}
                      {r.result?.reason && r.result.reason !== 'fired' && (
                        <p className="mt-1 text-xs text-fg-2">{reasonLabel(t, r.result.reason)}</p>
                      )}
                    </TD>
                    <TD className="py-3 align-top">
                      {r.effects.length === 0 ? null : (
                        <ul className="flex flex-col gap-1.5">
                          {r.effects.map((e) => (
                            <EffectLine key={e.id} e={e} />
                          ))}
                        </ul>
                      )}
                    </TD>
                    <TD className="py-3 align-top text-sm">
                      {r.chatId ? (
                        <Link
                          href={`/inbox/${r.chatId}`}
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {t('triggers.runs.openChat')}
                        </Link>
                      ) : r.visitorSessionId ? (
                        <span className="text-fg-2">{t('triggers.runs.visitorSession')}</span>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
          {q.hasNextPage && (
            <div className="flex justify-center border-t border-line-subtle p-3">
              <Button
                variant="secondary"
                onClick={() => void q.fetchNextPage()}
                loading={q.isFetchingNextPage}
              >
                {t('triggers.runs.loadOlder')}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Effect statuses recorded by the engine; an unknown status is shown as its code. */
const EFFECT_STATUS: Record<string, MessageKey> = {
  applied: 'triggers.runs.status.applied',
  pending: 'triggers.runs.status.pending',
  failed: 'triggers.runs.status.failed',
  skipped: 'triggers.runs.status.skipped',
  suppressed: 'triggers.runs.status.suppressed',
};

function EffectLine({ e }: { e: TriggerRunEffect }) {
  const t = useT();
  const tone =
    e.status === 'applied'
      ? 'success'
      : e.status === 'pending'
        ? 'info'
        : e.status === 'failed'
          ? 'danger'
          : 'warning';
  const Icon =
    e.status === 'applied'
      ? CheckCircle2
      : e.status === 'pending'
        ? Clock3
        : e.status === 'failed'
          ? XCircle
          : CircleSlash;
  const reason = reasonLabel(t, e.reason);
  const statusKey = EFFECT_STATUS[e.status];
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-fg">
        {e.actionIndex + 1}. {actionLabel(t, e.actionType)}
      </span>
      <Badge tone={tone} icon={<Icon className="size-3.5" aria-hidden />}>
        {statusKey ? t(statusKey) : e.status.charAt(0).toUpperCase() + e.status.slice(1)}
      </Badge>
      {reason && <span className="text-xs text-fg-2">{reason}</span>}
    </li>
  );
}
