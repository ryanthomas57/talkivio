'use client';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { changeInfo, formatSeconds, formatValue, measureLabel, nullPolicyText, ratioText, spokenSeconds, unitLabel } from './measures';
import type { ReportedMeasure } from './types';

/**
 * One measure: value, unit, sample size or numerator ÷ denominator, change vs the
 * previous period (only when meaningful) and its definition on demand (ch. 51).
 * Empty values explain the null policy in visible text, never only in a tooltip.
 */
export function MeasureCard({ measure: m, compact = false, className }: { measure: ReportedMeasure; compact?: boolean; className?: string }) {
  const empty = m.value === null;
  const change = changeInfo(m);
  const unit = unitLabel(m.unit, m.value, m.kind);
  const spoken = m.kind === 'duration' ? spokenSeconds(m.value) : undefined;

  return (
    <article className={cn('flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-4', className)}>
      <h3 className="text-sm font-medium leading-5 text-fg-2">{measureLabel(m)}</h3>
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span className={cn('font-semibold tabular text-fg', compact ? 'text-2xl leading-8' : 'text-[28px] leading-9')} aria-hidden={spoken && !empty ? true : undefined}>
          {formatValue(m.kind, m.value)}
        </span>
        {spoken && !empty && <span className="sr-only">{spoken}</span>}
        {unit && !empty && <span className="text-sm text-fg-2">{unit}</span>}
      </p>
      {empty ? (
        <p className="text-xs text-fg-2">{nullPolicyText(m.nullPolicy)}</p>
      ) : (
        <SampleLine m={m} />
      )}
      {change && <ChangeLine change={change} />}
      <Definition m={m} />
    </article>
  );
}

function SampleLine({ m }: { m: ReportedMeasure }) {
  const t = useT();
  if (m.kind === 'rate') return <p className="text-xs text-fg-2 tabular">{ratioText(m)}</p>;
  if (m.kind === 'duration') return <p className="text-xs text-fg-2 tabular">{t('analytics.card.samples', { p90: formatSeconds(m.p90), p95: formatSeconds(m.p95), n: formatNumber(m.n) })}</p>;
  return null;
}

function ChangeLine({ change }: { change: NonNullable<ReturnType<typeof changeInfo>> }) {
  const Icon = change.direction === 'up' ? ArrowUpRight : change.direction === 'down' ? ArrowDownRight : ArrowRight;
  return (
    <p className="flex items-start gap-1 text-xs text-fg-2">
      <Icon className="mt-px size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden />
      <span>
        <span className="font-medium text-fg">{change.text}</span>
        <span className="block">{change.detail}</span>
      </span>
    </p>
  );
}

/**
 * Native disclosure: keyboard and screen-reader friendly without extra state.
 * The definition and population sentences come verbatim from the API (English), so they get dir="auto".
 */
export function Definition({ m, extra }: { m: Pick<ReportedMeasure, 'definition' | 'population' | 'nullPolicy' | 'kind' | 'percentileMethod' | 'label' | 'key'>; extra?: ReactNode }) {
  const t = useT();
  return (
    <details className="group mt-auto text-xs">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" aria-hidden />
        <span aria-hidden>{t('analytics.card.definition')}</span>
        <span className="sr-only">{t('analytics.card.definitionOf', { label: measureLabel(m) })}</span>
      </summary>
      <div className="mt-1 flex flex-col gap-1.5 rounded-md bg-surface-2 p-2.5 text-fg-2">
        <p className="text-fg" dir="auto">
          {m.definition}
        </p>
        <p>
          <span className="font-medium text-fg">{t('analytics.card.population')}</span> <span dir="auto">{m.population}</span>
        </p>
        <p>
          <span className="font-medium text-fg">{t('analytics.card.whenEmpty')}</span> {nullPolicyText(m.nullPolicy)}
        </p>
        {m.kind === 'duration' && (
          <p>
            <span className="font-medium text-fg">{t('analytics.card.percentiles')}</span>{' '}
            {m.percentileMethod === 'nearest_rank' ? t('analytics.card.nearestRank') : m.percentileMethod ? <span dir="auto">{m.percentileMethod}</span> : t('analytics.card.orderedDurations')}
          </p>
        )}
        {extra}
      </div>
    </details>
  );
}

/** Skeleton shaped like a measure card. */
export function MeasureCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4', className)} aria-hidden>
      <div className="skeleton h-4 w-28 rounded-md" />
      <div className="skeleton h-8 w-20 rounded-md" />
      <div className="skeleton h-3 w-36 rounded-md" />
    </div>
  );
}
