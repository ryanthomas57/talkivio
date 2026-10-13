'use client';
import { Ban, Unplug } from 'lucide-react';
import { StatusLabel, STATUS_META, Tooltip } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import type { Agent } from '@/lib/types';

/**
 * True when the agent declared Online/Away but has no live connection — the
 * transport is interrupted (closed laptop, network loss, or signed out without
 * changing status). Connected is a separate transport property (ch. 09).
 */
export function transportInterrupted(a: Agent): boolean {
  // Agents who have never connected are simply offline, not interrupted.
  return (
    a.enabled &&
    !a.connected &&
    !!a.lastSeenAt &&
    (a.desiredStatus === 'online' || a.desiredStatus === 'away')
  );
}

/** Status cell: icon + text + colour, a suspended marker, and a transport-interruption marker. */
export function AgentStatus({ agent, className }: { agent: Agent; className?: string }) {
  const t = useT();
  if (!agent.enabled)
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium text-danger', className)}>
        <Ban className="size-3.5" aria-hidden />
        {t('team.status.suspended')}
      </span>
    );
  const interrupted = transportInterrupted(agent);
  const desired = t(STATUS_META[agent.desiredStatus].label);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-0.5', className)}>
      <StatusLabel status={agent.effectiveStatus} />
      {interrupted && (
        <Tooltip
          content={
            agent.lastSeenAt
              ? t('team.status.interruptedSince', { status: desired, date: formatDateTime(agent.lastSeenAt) })
              : t('team.status.interrupted', { status: desired })
          }
        >
          <span
            className="inline-flex items-center gap-1 rounded-full bg-warning-tint px-2 py-0.5 text-xs font-medium text-warning"
            tabIndex={0}
          >
            <Unplug className="size-3" aria-hidden />
            {t('team.status.notConnected')}
            <span className="sr-only">
              {' '}
              {agent.lastSeenAt
                ? t('team.status.srSetToSeen', { status: desired, time: formatRelative(agent.lastSeenAt) })
                : t('team.status.srSetTo', { status: desired })}
            </span>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

export function LastSeen({ agent }: { agent: Agent }) {
  const t = useT();
  if (agent.connected && agent.enabled) return <span className="text-sm text-fg">{t('team.status.now')}</span>;
  if (!agent.lastSeenAt) return <span className="text-sm text-fg-2">{t('team.status.never')}</span>;
  return (
    <time dateTime={agent.lastSeenAt} title={formatDateTime(agent.lastSeenAt)} className="text-sm text-fg-2">
      {formatRelative(agent.lastSeenAt)}
    </time>
  );
}

/** "2 / 5" with a visual load bar; full capacity is called out in text. */
export function LoadCell({ agent }: { agent: Agent }) {
  const t = useT();
  const pct = agent.capacity > 0 ? Math.min(100, Math.round((agent.activeChats / agent.capacity) * 100)) : 0;
  const full = agent.activeChats >= agent.capacity;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tabular text-sm text-fg">
        {formatNumber(agent.activeChats)} / {formatNumber(agent.capacity)}
        <span className="sr-only"> {t('team.status.loadSr')}</span>
      </span>
      <span
        className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-surface-3 sm:inline-block"
        aria-hidden
      >
        <span
          className={cn('block h-full rounded-full', full ? 'bg-warning' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </span>
      {full && <span className="text-xs font-medium text-warning">{t('team.status.full')}</span>}
    </span>
  );
}
