'use client';
import { Clock } from 'lucide-react';
import { Banner, Button } from '@/components/ui';
import { useT } from '@/i18n';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { ReportFreshness } from './types';
import { timeIn } from './use-theme';

/**
 * Report freshness (ch. 50/51): `as_of` is always visible; a warning banner
 * appears when aggregation lags more than 60 s (the API sets `stale`).
 */
export function FreshnessBanner({ freshness, timezone, onRefresh, refreshing }: { freshness: ReportFreshness; timezone?: string; onRefresh?: () => void; refreshing?: boolean }) {
  const t = useT();
  if (!freshness.stale) return null;
  const pending = freshness.pendingFacts ?? 0;
  const lag = formatDuration(freshness.lagMs);
  const time = freshness.sourceWatermark ? formatDateTime(freshness.sourceWatermark, timezone) : null;
  return (
    <Banner
      tone="warning"
      title={t('analytics.freshness.behindTitle')}
      action={
        onRefresh && (
          <Button size="sm" variant="secondary" onClick={onRefresh} loading={refreshing}>
            {t('common.refresh')}
          </Button>
        )
      }
    >
      {pending > 0
        ? time
          ? t('analytics.freshness.behindBodyPending', { lag, count: pending, time })
          : t('analytics.freshness.behindBodyPendingUnknown', { lag, count: pending })
        : time
          ? t('analytics.freshness.behindBody', { lag, time })
          : t('analytics.freshness.behindBodyUnknown', { lag })}
    </Banner>
  );
}

export function FreshnessLine({ freshness, timezone, className }: { freshness: ReportFreshness; timezone?: string; className?: string }) {
  const t = useT();
  const source = freshness.source === 'raw' ? 'raw' : freshness.cached ? 'cached' : 'facts';
  // The time is marked <time>…</time> in the message so the translation decides where it sits.
  const [before, time, after] = t('analytics.freshness.line', { time: timeIn(freshness.asOf, timezone), source, stale: freshness.stale ? 'yes' : 'no' }).split(/<time>|<\/time>/);
  return (
    <p className={className ?? 'flex items-center gap-1.5 text-xs text-fg-2'}>
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span>
        {before}
        <time dateTime={freshness.asOf} title={formatDateTime(freshness.asOf, timezone)}>
          {time}
        </time>
        {after}
      </span>
    </p>
  );
}
