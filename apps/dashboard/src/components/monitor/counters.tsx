'use client';
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { formatSeconds, spokenSeconds } from '@/components/analytics/measures';
import { timeIn } from '@/components/analytics/use-theme';
import { useT, type MessageKey, type Translate } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { MonitorSnapshot, WaitLevel } from './types';
import { levelFor, tickingSeconds } from './use-monitor';

export const WAIT_META: Record<
  WaitLevel,
  {
    label: (t: Translate, th: { warning: number; critical: number }) => string;
    Icon: typeof Clock;
    text: string;
    card: string;
  }
> = {
  none: { label: (t) => t('monitor.wait.none'), Icon: Clock, text: 'text-fg-2', card: '' },
  ok: {
    label: (t, th) => t('monitor.wait.ok', { seconds: th.warning }),
    Icon: CheckCircle2,
    text: 'text-success',
    card: '',
  },
  warning: {
    label: (t, th) => t('monitor.wait.warning', { seconds: th.warning }),
    Icon: AlertTriangle,
    text: 'text-warning',
    card: 'border-warning/50 bg-warning-tint',
  },
  critical: {
    label: (t, th) => t('monitor.wait.critical', { seconds: th.critical }),
    Icon: AlertOctagon,
    text: 'text-danger',
    card: 'border-danger/50 bg-danger-tint',
  },
};

/** Severity uses icon + text + color (ch. 05/49). */
export function WaitLevelLabel({
  level,
  thresholds,
  className,
}: {
  level: WaitLevel;
  thresholds: { warning: number; critical: number };
  className?: string;
}) {
  const t = useT();
  const m = WAIT_META[level];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', m.text, className)}>
      <m.Icon className="size-3.5 shrink-0" aria-hidden />
      {m.label(t, thresholds)}
    </span>
  );
}

/** Message keys: render with t(). */
export const COUNTER_DEFINITIONS = {
  queued: 'monitor.def.queued',
  oldestWait: 'monitor.def.oldestWait',
  active: 'monitor.def.active',
  agents: 'monitor.def.agents',
  offered: 'monitor.def.offered',
  backlog: 'monitor.def.backlog',
  csat: 'monitor.def.csat',
} as const satisfies Record<string, MessageKey>;

function CounterCard({
  label,
  value,
  unit,
  srValue,
  sub,
  definition,
  asOf,
  stale,
  className,
  tz,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  srValue?: string;
  sub?: ReactNode;
  definition: string;
  asOf: string;
  stale: boolean;
  className?: string;
  tz?: string;
}) {
  const t = useT();
  // The time is marked <time>…</time> in the message so the translation decides where it sits.
  const [asOfBefore, asOfTime, asOfAfter] = t('monitor.card.asOf', { time: timeIn(asOf, tz) }).split(
    /<time>|<\/time>/,
  );
  return (
    <article
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-card)] border border-line bg-surface p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-fg-2">{label}</h3>
        {stale && (
          <Badge tone="warning" icon={<AlertTriangle className="size-3" aria-hidden />}>
            {t('monitor.card.stale')}
          </Badge>
        )}
      </div>
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span
          className="text-[28px] font-semibold leading-9 tabular text-fg"
          aria-hidden={srValue ? true : undefined}
        >
          {value}
        </span>
        {srValue && <span className="sr-only">{srValue}</span>}
        {unit && <span className="text-sm text-fg-2">{unit}</span>}
      </p>
      {sub}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
        <details className="group text-xs">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100"
              aria-hidden
            />
            <span aria-hidden>{t('monitor.card.definition')}</span>
            <span className="sr-only">{t('monitor.card.definitionOf', { label })}</span>
          </summary>
          <p className="mt-1 rounded-md bg-surface-2 p-2.5 text-fg-2">{definition}</p>
        </details>
        <span className="text-xs text-fg-2">
          {asOfBefore}
          <time dateTime={asOf} title={formatDateTime(asOf, tz)}>
            {asOfTime}
          </time>
          {asOfAfter}
        </span>
      </div>
    </article>
  );
}

/**
 * Top counters: 4 columns ≥ 1200 px, 2 from 640 px, 1 below (ch. 49). The
 * oldest wait keeps ticking between pushes from the server-computed age.
 */
export function MonitorCounters({
  snapshot: s,
  stale,
  receivedAt,
  now,
  compact = false,
}: {
  snapshot: MonitorSnapshot;
  stale: boolean;
  receivedAt: number;
  now: number;
  compact?: boolean;
}) {
  const t = useT();
  const c = s.counters;
  const th = { warning: s.thresholds.queueWarningSeconds, critical: s.thresholds.queueCriticalSeconds };
  const wait = c.queued > 0 ? tickingSeconds(c.oldestWaitSeconds, receivedAt, now) : null;
  const level = levelFor(wait, th.warning, th.critical);
  const tz = c.csat.timezone;
  const common = { asOf: s.asOf, stale, tz };

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4 sm:grid-cols-2',
        compact ? 'xl:grid-cols-4' : 'min-[1200px]:grid-cols-4',
      )}
    >
      <CounterCard
        label={t('monitor.counters.queued')}
        value={formatNumber(c.queued)}
        unit={t('monitor.counters.unitChats', { count: c.queued })}
        definition={t(COUNTER_DEFINITIONS.queued)}
        {...common}
      />
      <CounterCard
        label={t('monitor.counters.oldestWait')}
        value={wait === null ? t('common.notAvailable') : formatSeconds(wait)}
        srValue={wait === null ? t('common.none') : spokenSeconds(wait)}
        sub={<WaitLevelLabel level={level} thresholds={th} />}
        definition={t(COUNTER_DEFINITIONS.oldestWait)}
        className={WAIT_META[level].card}
        {...common}
      />
      <CounterCard
        label={t('monitor.counters.active')}
        value={formatNumber(c.active)}
        unit={t('monitor.counters.unitChats', { count: c.active })}
        definition={t(COUNTER_DEFINITIONS.active)}
        {...common}
      />
      <CounterCard
        label={t('monitor.counters.available')}
        value={formatNumber(c.availableAgents)}
        unit={t('monitor.counters.ofOnline', { count: c.onlineAgents })}
        sub={
          c.onlineAgents === 0 ? (
            <span className="text-xs font-medium text-warning">{t('monitor.counters.noneOnline')}</span>
          ) : undefined
        }
        definition={t(COUNTER_DEFINITIONS.agents)}
        {...common}
      />
      {!compact && (
        <>
          <CounterCard
            label={t('monitor.counters.offered')}
            value={formatNumber(c.offeredReservations)}
            unit={t('monitor.counters.unitOffers', { count: c.offeredReservations })}
            definition={t(COUNTER_DEFINITIONS.offered)}
            {...common}
          />
          <CounterCard
            label={t('monitor.counters.backlog')}
            value={formatNumber(c.responseBacklog)}
            unit={t('monitor.counters.unitAwaiting', { count: c.responseBacklog })}
            definition={t(COUNTER_DEFINITIONS.backlog)}
            {...common}
          />
          <CounterCard
            label={t('monitor.counters.csat')}
            value={
              c.csat.value === null
                ? t('common.notAvailable')
                : formatNumber(c.csat.value / 100, { style: 'percent', maximumFractionDigits: 1 })
            }
            sub={
              <span className="text-xs tabular text-fg-2">
                {c.csat.n === 0
                  ? t('monitor.counters.noRatings')
                  : t('monitor.counters.csatSample', {
                      good: c.csat.numerator,
                      rated: c.csat.denominator,
                      n: c.csat.n,
                    })}
              </span>
            }
            definition={t(COUNTER_DEFINITIONS.csat)}
            {...common}
          />
        </>
      )}
    </div>
  );
}
