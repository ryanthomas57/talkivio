'use client';
/**
 * Dated exceptions (holidays and special hours): closed all day, or custom
 * intervals with a reason. Each change is a versioned PUT/DELETE on
 * /schedules/{id}/exceptions/{date}; changes that would close service right now
 * are confirmed first (dry run).
 */
import { useQueryClient } from '@tanstack/react-query';
import { CalendarOff, CalendarPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { validateDayIntervals } from '@talkivio/contracts';
import { Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, Input, RadioGroup } from '@/components/ui';
import { intlLocale, isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatLocalDate, hk, localizeHoursErrors, todayIn, type ScheduleDetail, type ScheduleException, type ScheduleImpact, type TimeRange } from './hours-api';
import { IntervalRow } from './weekly-grid';

export function ScheduleExceptions({ schedule, canManage }: { schedule: ScheduleDetail; canManage: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ScheduleException | 'new' | null>(null);
  const [removing, setRemoving] = useState<ScheduleException | null>(null);
  const today = todayIn(schedule.timezone);
  const archived = !!schedule.archivedAt;
  const { upcoming, past } = useMemo(() => {
    const sorted = [...schedule.exceptions].sort((a, b) => a.date.localeCompare(b.date));
    return { upcoming: sorted.filter((e) => e.date >= today), past: sorted.filter((e) => e.date < today).reverse() };
  }, [schedule.exceptions, today]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: hk.schedule(schedule.id) }), qc.invalidateQueries({ queryKey: hk.schedulesRoot }), qc.invalidateQueries({ queryKey: ['schedule-preview', schedule.id] })]);

  return (
    <Card>
      <CardHeader
        title={t('settings.hours.exceptions.title')}
        description={t('settings.hours.exceptions.description', { zone: isolate(schedule.timezone.replace(/_/g, ' ')) })}
        action={
          canManage &&
          !archived && (
            <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
              <CalendarPlus className="size-3.5" aria-hidden />
              {t('settings.hours.exceptions.addDate')}
            </Button>
          )
        }
      />
      {upcoming.length === 0 && past.length === 0 ? (
        <EmptyState icon={<CalendarOff />} title={t('settings.hours.exceptions.emptyTitle')} description={t('settings.hours.exceptions.emptyBody')} />
      ) : (
        <div className="flex flex-col">
          <ExceptionList title={t('settings.hours.exceptions.upcoming')} items={upcoming} empty={t('settings.hours.exceptions.noUpcoming')} canManage={canManage && !archived} onEdit={setEditing} onRemove={setRemoving} />
          {past.length > 0 && <ExceptionList title={t('settings.hours.exceptions.past', { count: 31 })} items={past} muted canManage={false} onEdit={setEditing} onRemove={setRemoving} />}
        </div>
      )}
      {editing && (
        <ExceptionDialog
          schedule={schedule}
          initial={editing === 'new' ? null : editing}
          existingDates={schedule.exceptions.map((e) => e.date)}
          minDate={today}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? t('settings.hours.exceptions.removeTitle', { date: formatLocalDate(removing.date) }) : t('settings.hours.exceptions.removeThisTitle')}
        description={t('settings.hours.exceptions.removeBody')}
        confirmLabel={t('settings.hours.exceptions.removeConfirm')}
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api.delete(`/schedules/${schedule.id}/exceptions/${removing.date}`, { ifMatch: schedule.version });
          } catch (e) {
            if (isApiError(e, 'VERSION_CONFLICT')) {
              await refresh();
              throw new ApiError({ status: 409, code: 'VERSION_CONFLICT', message: t('settings.hours.exceptions.removeConflict') });
            }
            throw e;
          }
          toast.success(t('settings.hours.exceptions.removed'));
          await refresh();
        }}
      />
    </Card>
  );
}

function ExceptionList({ title, items, empty, muted, canManage, onEdit, onRemove }: { title: string; items: ScheduleException[]; empty?: string; muted?: boolean; canManage: boolean; onEdit: (e: ScheduleException) => void; onRemove: (e: ScheduleException) => void }) {
  const t = useT();
  const list = new Intl.ListFormat(intlLocale(), { style: 'short', type: 'unit' });
  return (
    <section aria-label={title} className="border-t border-line-subtle first:border-t-0">
      <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-2 sm:px-6">{title}</h3>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-2 sm:px-6">{empty}</p>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {items.map((e) => (
            <li key={e.date} className={cn('flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6', muted && 'text-fg-2')}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{formatLocalDate(e.date)}</p>
                <p className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
                  {e.closed ? <Badge tone="warning">{t('settings.hours.closedAllDay')}</Badge> : <span className="font-mono tabular">{list.format(e.intervals.map((r) => `${r.start}–${r.end}`))}</span>}
                  {e.reason && (
                    <span className="min-w-0 break-words" dir="auto">
                      {e.reason}
                    </span>
                  )}
                </p>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" className="size-11 sm:size-10" onClick={() => onEdit(e)} aria-label={t('settings.hours.exceptions.editLabel', { date: formatLocalDate(e.date) })}>
                    <Pencil className="size-4" aria-hidden />
                  </Button>
                  <Button size="icon" variant="ghost" className="size-11 sm:size-10" onClick={() => onRemove(e)} aria-label={t('settings.hours.exceptions.removeLabel', { date: formatLocalDate(e.date) })}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExceptionDialog({ schedule, initial, existingDates, minDate, onClose, onSaved }: { schedule: ScheduleDetail; initial: ScheduleException | null; existingDates: string[]; minDate: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT();
  const [date, setDate] = useState(initial?.date ?? '');
  const [mode, setMode] = useState<'closed' | 'hours'>(initial && !initial.closed ? 'hours' : 'closed');
  const [ranges, setRanges] = useState<TimeRange[]>(initial && !initial.closed ? initial.intervals : [{ start: '10:00', end: '14:00' }]);
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [dateError, setDateError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ScheduleImpact | null>(null);
  const [version] = useState(schedule.version);

  useEffect(() => setErrors({}), [mode]);

  const payload = () => ({ intervals: mode === 'closed' ? [] : ranges, reason: reason.trim() || null, expectedVersion: version });

  const put = async (dryRun: boolean) => api.put<{ impact: ScheduleImpact; applied: boolean }>(`/schedules/${schedule.id}/exceptions/${date}`, { ...payload(), dryRun });

  const fail = (e: unknown) => {
    if (isApiError(e, 'VERSION_CONFLICT')) setConflict(true);
    else if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
      setErrors(localizeHoursErrors(Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [k.replace(/^intervals\.?/, ''), v]))));
      if (e.field('date')) setDateError(e.field('date')!);
      setMessage(e.message);
    } else setMessage(errorMessage(e));
  };

  const commit = async () => {
    setBusy(true);
    try {
      await put(false);
      toast.success(initial ? t('settings.hours.exceptions.updated') : t('settings.hours.exceptions.added'));
      await onSaved();
    } catch (e) {
      setImpact(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setConflict(false);
    let bad = false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setDateError(t('settings.hours.exceptions.dateRequired'));
      bad = true;
    } else if (!initial && existingDates.includes(date)) {
      setDateError(t('settings.hours.exceptions.dateExists'));
      bad = true;
    } else setDateError(null);
    if (mode === 'hours') {
      if (!ranges.length) {
        setErrors({ '': [t('settings.hours.exceptions.needInterval')] });
        bad = true;
      } else {
        const v = validateDayIntervals(ranges);
        setErrors(localizeHoursErrors(v));
        if (Object.keys(v).length) bad = true;
      }
    }
    if (reason.trim().length > 200) bad = true;
    if (bad) return;
    setBusy(true);
    try {
      const dry = await put(true);
      if (dry.impact.closesServiceNow) {
        setImpact(dry.impact);
        setBusy(false);
        return;
      }
    } catch (err) {
      fail(err);
      setBusy(false);
      return;
    }
    await commit();
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent
          size="md"
          title={initial ? t('settings.hours.exceptions.editTitle', { date: formatLocalDate(initial.date) }) : t('settings.hours.exceptions.addTitle')}
          description={t('settings.hours.exceptions.localDate', { zone: isolate(schedule.timezone.replace(/_/g, ' ')) })}
          footer={
            <>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" form="exception-form" variant="primary" loading={busy}>
                {initial ? t('settings.hours.exceptions.saveDate') : t('settings.hours.exceptions.addDate')}
              </Button>
            </>
          }
        >
          <form id="exception-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
            {conflict && <Banner tone="warning">{t('settings.hours.exceptions.conflict')}</Banner>}
            {message && !conflict && <Banner tone="danger">{message}</Banner>}
            <Field label={t('common.date')} required error={dateError}>
              <Input type="date" value={date} min={initial ? undefined : minDate} max="2100-12-31" disabled={!!initial} onChange={(e) => setDate(e.target.value)} className="w-48" />
            </Field>
            <RadioGroup
              legend={t('settings.hours.exceptions.modeLegend')}
              name="exception-mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'closed', label: t('settings.hours.closedAllDay'), description: t('settings.hours.exceptions.closedHint') },
                { value: 'hours', label: t('settings.hours.exceptions.special'), description: t('settings.hours.exceptions.specialHint') },
              ]}
            />
            {mode === 'hours' && (
              <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-3">
                {ranges.map((r, i) => (
                  <IntervalRow
                    key={i}
                    label={t('settings.hours.exceptions.interval', { n: i + 1 })}
                    range={r}
                    onChange={(next) => setRanges(ranges.map((x, j) => (j === i ? next : x)))}
                    onRemove={() => setRanges(ranges.filter((_, j) => j !== i))}
                    error={errors[String(i)]?.[0]}
                    startError={errors[`${i}.start`]?.[0]}
                    endError={errors[`${i}.end`]?.[0]}
                  />
                ))}
                {(errors['']?.[0] || errors['_']?.[0]) && (
                  <p className="text-xs font-medium text-danger" role="alert">
                    {errors['']?.[0] ?? errors['_']?.[0]}
                  </p>
                )}
                {ranges.length < 12 && (
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setRanges([...ranges, { start: '15:00', end: '17:00' }])}>
                      <Plus className="size-3.5" aria-hidden />
                      {t('settings.hours.addInterval')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            <Field label={t('settings.hours.exceptions.reason')} description={t('settings.hours.exceptions.reasonHint', { max: 200 })} error={reason.trim().length > 200 ? t('settings.profile.maxChars', { max: 200 }) : undefined}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={t('settings.hours.exceptions.reasonPlaceholder')} dir="auto" />
            </Field>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!impact}
        onOpenChange={(o) => !o && setImpact(null)}
        title={t('settings.hours.impactTitle')}
        description={t('settings.hours.exceptions.impactBody', { name: isolate(schedule.name) })}
        confirmLabel={t('settings.hours.impactConfirm')}
        danger
        onConfirm={commit}
      />
    </>
  );
}
