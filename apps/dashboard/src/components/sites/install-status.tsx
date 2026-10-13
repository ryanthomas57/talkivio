'use client';
import { CheckCircle2, CircleDashed, History } from 'lucide-react';
import { isolate, useT, type MessageKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { Site } from '@/lib/types';

export type InstallState = 'verified' | 'seen_before' | 'not_detected';

/** Same rule the API's installation-status uses: a bootstrap from an allowed origin in the last 15 minutes. */
export function installStateOf(
  site: Pick<Site, 'lastVerifiedAt' | 'installedAt'>,
  now = Date.now(),
): InstallState {
  const at = site.lastVerifiedAt ? new Date(site.lastVerifiedAt).getTime() : null;
  if (at && now - at < 15 * 60_000) return 'verified';
  return site.installedAt ? 'seen_before' : 'not_detected';
}

const META: Record<InstallState, { label: MessageKey; Icon: typeof CheckCircle2; cls: string }> = {
  verified: { label: 'sites.install.state.verified', Icon: CheckCircle2, cls: 'text-success' },
  seen_before: { label: 'sites.install.state.seenBefore', Icon: History, cls: 'text-warning' },
  not_detected: { label: 'sites.install.state.notDetected', Icon: CircleDashed, cls: 'text-fg-2' },
};

export function InstallStatus({
  state,
  lastVerifiedAt,
  origin,
  className,
  compact,
}: {
  state: InstallState;
  lastVerifiedAt: string | null;
  origin?: string | null;
  className?: string;
  compact?: boolean;
}) {
  const t = useT();
  const m = META[state];
  return (
    <span className={cn('inline-flex flex-col gap-0.5', className)}>
      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', m.cls)}>
        <m.Icon className="size-4 shrink-0" aria-hidden />
        {t(m.label)}
      </span>
      {lastVerifiedAt ? (
        <span className="text-xs text-fg-2">
          <time dateTime={lastVerifiedAt} title={formatDateTime(lastVerifiedAt)}>
            {!compact && origin ? t('sites.install.lastVerifiedOn', { time: formatRelative(lastVerifiedAt), origin: isolate(origin) }) : t('sites.install.lastVerified', { time: formatRelative(lastVerifiedAt) })}
          </time>
        </span>
      ) : (
        <span className="text-xs text-fg-2">{t('sites.install.neverVerified')}</span>
      )}
    </span>
  );
}
