'use client';
/**
 * 14-day preview from GET /schedules/{id}/preview: open/close boundaries in the
 * schedule's local time and in the viewer's time, with daylight-saving transitions
 * and boundary resolutions (gap / fold) highlighted (ch. 22).
 */
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, DoorClosed, DoorOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, PanelError, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatIn, formatLocalDate, hk, viewerTimezone, type PreviewResponse } from './hours-api';

const DAYS = 14;

/** Offset label shown next to a schedule time, e.g. "UTC+03:00" (a standard abbreviation, not translated). */
const utc = (offset: string) => `UTC${offset}`;

/** Midnight of a local calendar date in the viewer's zone, as RFC3339. */
function fromDate(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function SchedulePreview({ scheduleId, version, dirty }: { scheduleId: string; version: number; dirty: boolean }) {
  const t = useT();
  const [start, setStart] = useState<string>('');
  const from = fromDate(start);
  const viewerTz = useMemo(viewerTimezone, []);
  const q = useQuery({
    queryKey: [...hk.preview(scheduleId, from ?? 'now'), version],
    queryFn: () => api.get<PreviewResponse>(`/schedules/${scheduleId}/preview`, { days: DAYS, from: from ?? undefined }),
    staleTime: 60_000,
  });

  const groups = useMemo(() => {
    const out = new Map<string, PreviewResponse['boundaries']>();
    for (const b of q.data?.boundaries ?? []) {
      const date = b.local.slice(0, 10);
      out.set(date, [...(out.get(date) ?? []), b]);
    }
    return [...out.entries()];
  }, [q.data]);

  const tz = q.data?.timezone;
  const sameZone = tz === viewerTz;

  return (
    <Card>
      <CardHeader
        title={t('common.preview')}
        description={
          tz
            ? t('settings.hours.preview.descriptionZone', { count: DAYS, zone: isolate(tz.replace(/_/g, ' ')), viewerZone: isolate(viewerTz.replace(/_/g, ' ')) })
            : t('settings.hours.preview.description', { count: DAYS, viewerZone: isolate(viewerTz.replace(/_/g, ' ')) })
        }
        action={
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('settings.hours.preview.startDate')} className="w-44">
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            {start && (
              <Button variant="ghost" onClick={() => setStart('')}>
                {t('settings.hours.preview.fromNow')}
              </Button>
            )}
          </div>
        }
      />
      {dirty && <p className="border-b border-line-subtle bg-surface-2 px-4 py-2 text-xs text-fg-2 sm:px-6">{t('settings.hours.preview.dirty')}</p>}
      {q.isPending ? (
        <CardBody className="flex flex-col gap-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </CardBody>
      ) : q.isError ? (
        <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {q.data.openAtFrom ? <Badge tone="success" icon={<DoorOpen className="size-3.5" aria-hidden />}>{t('settings.hours.preview.openAtStart')}</Badge> : <Badge tone="neutral" icon={<DoorClosed className="size-3.5" aria-hidden />}>{t('settings.hours.preview.closedAtStart')}</Badge>}
              <span className="text-fg-2">
                {t('settings.hours.preview.range', { from: formatIn(q.data.from, q.data.timezone), to: formatIn(q.data.to, q.data.timezone) })}
              </span>
              {!q.data.openAtFrom && q.data.nextOpenAt && <span className="text-fg-2">· {t('settings.hours.preview.nextOpening', { time: formatIn(q.data.nextOpenAt, q.data.timezone) })}</span>}
            </div>
            {q.data.transitions.length > 0 && (
              <ul className="flex flex-col gap-2" aria-label={t('settings.hours.preview.dstList')}>
                {q.data.transitions.map((tr) => (
                  <li key={tr.at} className="flex items-start gap-2 rounded-[var(--radius-control)] border border-warning/30 bg-warning-tint px-3 py-2 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                    <span>
                      <span className="font-semibold text-warning">{tr.kind === 'forward' ? t('settings.hours.preview.dstStarts') : t('settings.hours.preview.dstEnds')} </span>
                      {tr.note}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
          {groups.length === 0 ? (
            <EmptyState icon={<CalendarRange />} title={t('settings.hours.preview.emptyTitle')} description={t('settings.hours.preview.emptyBody', { count: DAYS })} />
          ) : (
            <TableScroll>
              <Table className="min-w-[640px]">
                <THead>
                  <tr>
                    <TH>{t('settings.hours.preview.colDate')}</TH>
                    <TH>{t('settings.hours.preview.colChange')}</TH>
                    <TH>{t('settings.hours.preview.colTime')}</TH>
                    <TH>{sameZone ? t('settings.hours.preview.colYourTimeSame') : t('settings.hours.preview.colYourTime')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {groups.map(([date, rows]) =>
                    rows.map((b, i) => (
                      <TR key={b.at + b.kind} className={b.dst ? 'bg-warning-tint/60' : undefined}>
                        <TD className="whitespace-nowrap align-top">{i === 0 ? formatLocalDate(date, 'short') : <span className="sr-only">{formatLocalDate(date, 'short')}</span>}</TD>
                        <TD className="align-top">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            {b.kind === 'open' ? <DoorOpen className="size-4 text-success" aria-hidden /> : <DoorClosed className="size-4 text-fg-2" aria-hidden />}
                            {b.kind === 'open' ? t('settings.hours.opens') : t('settings.hours.closes')}
                          </span>
                          {b.source === 'exception' && (
                            <Badge tone="info" className="ms-2">
                              {t('settings.hours.specialDate')}
                            </Badge>
                          )}
                        </TD>
                        <TD className="align-top">
                          <span className="font-mono tabular" dir="ltr">{b.local.slice(11, 16)}</span>
                          <span className="ms-1.5 text-xs text-fg-2" dir="ltr">
                            {utc(b.utcOffset)}
                          </span>
                          {b.note && (
                            <p className="mt-1 flex max-w-md items-start gap-1.5 text-xs font-medium text-warning">
                              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                              <span>{b.note}</span>
                            </p>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap align-top">
                          <time dateTime={b.at}>{formatIn(b.at, viewerTz)}</time>
                        </TD>
                      </TR>
                    )),
                  )}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </>
      )}
    </Card>
  );
}
