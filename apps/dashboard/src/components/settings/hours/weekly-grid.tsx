'use client';
/**
 * Weekly hours editor (ch. 22): one row per weekday with a Closed checkbox and any
 * number of half-open [start, end) intervals. An end earlier than the start runs
 * overnight into the next day. Errors use the same keys as the API
 * (`mon.0.start`, `mon.0`, `mon`) so client and server validation render alike.
 */
import { MoonStar, Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { Button, Checkbox, controlClass } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { isOvernight, normalizeTime, orderedWeekdays, WEEKDAY_LABEL, type TimeRange, type Weekday, type WeeklyIntervals } from './hours-api';

const MAX_PER_DAY = 12;
const DEFAULT_RANGE: TimeRange = { start: '09:00', end: '17:00' };

export function WeeklyGrid({ value, onChange, errors, disabled, weekStartsOn }: { value: WeeklyIntervals; onChange: (v: WeeklyIntervals) => void; errors: Record<string, string[]>; disabled?: boolean; weekStartsOn: 0 | 1 }) {
  const t = useT();
  const setDay = (d: Weekday, ranges: TimeRange[]) => onChange({ ...value, [d]: ranges });
  return (
    <div role="group" aria-label={t('settings.hours.weeklyHours')} className="flex flex-col divide-y divide-line-subtle rounded-[var(--radius-control)] border border-line">
      {orderedWeekdays(weekStartsOn).map((d) => (
        <DayRow key={d} day={d} ranges={value[d] ?? []} onChange={(r) => setDay(d, r)} errors={errors} disabled={disabled} />
      ))}
    </div>
  );
}

function DayRow({ day, ranges, onChange, errors, disabled }: { day: Weekday; ranges: TimeRange[]; onChange: (r: TimeRange[]) => void; errors: Record<string, string[]>; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const closed = ranges.length === 0;
  const dayName = t(WEEKDAY_LABEL[day]);
  const dayError = errors[day]?.[0];
  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4 sm:px-4">
      <div className="flex min-h-10 items-center justify-between gap-3 sm:w-44 sm:shrink-0">
        <span id={`${id}-day`} className="text-sm font-semibold">
          {dayName}
        </span>
        <label className="inline-flex min-h-10 items-center gap-2 text-sm text-fg-2">
          <Checkbox checked={closed} disabled={disabled} onCheckedChange={(c) => onChange(c === true ? [] : [DEFAULT_RANGE])} aria-describedby={`${id}-day`} />
          {t('settings.hours.closed')}
        </label>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {closed ? (
          <p className="flex min-h-10 items-center text-sm text-fg-2">{t('settings.hours.closedAllDay')}</p>
        ) : (
          ranges.map((r, i) => (
            <IntervalRow
              key={i}
              label={t('settings.hours.intervalLabel', { day: dayName, n: i + 1 })}
              range={r}
              onChange={(next) => onChange(ranges.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(ranges.filter((_, j) => j !== i))}
              error={errors[`${day}.${i}`]?.[0]}
              startError={errors[`${day}.${i}.start`]?.[0]}
              endError={errors[`${day}.${i}.end`]?.[0]}
              disabled={disabled}
            />
          ))
        )}
        {dayError && (
          <p className="text-xs font-medium text-danger" role="alert">
            {dayError}
          </p>
        )}
        {!closed && !disabled && ranges.length < MAX_PER_DAY && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => onChange([...ranges, nextRange(ranges)])} aria-label={t('settings.hours.addIntervalOn', { day: dayName })}>
              <Plus className="size-3.5" aria-hidden />
              {t('settings.hours.addInterval')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A sensible following interval: one hour after the last end, two hours long. */
function nextRange(ranges: TimeRange[]): TimeRange {
  const last = ranges[ranges.length - 1];
  if (!last) return DEFAULT_RANGE;
  const [h, m] = last.end.split(':').map(Number);
  if (!Number.isFinite(h) || h >= 21) return { start: '18:00', end: '20:00' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return { start: `${pad(h + 1)}:${pad(m || 0)}`, end: `${pad(Math.min(h + 3, 24))}:${pad(h + 3 >= 24 ? 0 : m || 0)}` };
}

export function IntervalRow({ label, range, onChange, onRemove, error, startError, endError, disabled }: { label: string; range: TimeRange; onChange: (r: TimeRange) => void; onRemove: () => void; error?: string; startError?: string; endError?: string; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const messages = [startError, endError, error].filter(Boolean) as string[];
  const overnight = isOvernight(range);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <TimeBox id={`${id}-s`} label={t('settings.hours.opensLabel', { label })} value={range.start} invalid={!!startError || !!error} describedBy={messages.length ? `${id}-err` : undefined} disabled={disabled} onChange={(v) => onChange({ ...range, start: v })} />
        <span className="text-sm text-fg-2" aria-hidden>
          {t('settings.hours.to')}
        </span>
        <TimeBox id={`${id}-e`} label={t('settings.hours.closesLabel', { label })} value={range.end} invalid={!!endError || !!error} describedBy={[messages.length ? `${id}-err` : null, overnight ? `${id}-ovn` : null].filter(Boolean).join(' ') || undefined} disabled={disabled} onChange={(v) => onChange({ ...range, end: v })} />
        {overnight && (
          <span id={`${id}-ovn`} className="inline-flex items-center gap-1 rounded-full bg-info-tint px-2 py-0.5 text-xs font-medium text-info">
            <MoonStar className="size-3" aria-hidden />
            {t('settings.hours.overnight')}
          </span>
        )}
        {!disabled && (
          <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={t('settings.hours.removeInterval', { label })} className="size-11 sm:size-8">
            <Trash2 className="size-4" aria-hidden />
          </Button>
        )}
      </div>
      {messages.length > 0 && (
        <p id={`${id}-err`} className="text-xs font-medium text-danger" role="alert">
          {[...new Set(messages)].join(' ')}
        </p>
      )}
    </div>
  );
}

function TimeBox({ id, label, value, onChange, invalid, describedBy, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; invalid: boolean; describedBy?: string; disabled?: boolean }) {
  const t = useT();
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {t('settings.hours.timeFormatLabel', { label })}
      </label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        placeholder={t('settings.hours.timePlaceholder')}
        dir="ltr"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value.replace(/[^\d:]/g, ''))}
        onBlur={(e) => {
          const n = normalizeTime(e.target.value);
          if (n !== e.target.value) onChange(n);
        }}
        className={cn(controlClass, 'h-10 w-[5.5rem] py-2 text-center font-mono tabular')}
      />
    </>
  );
}
