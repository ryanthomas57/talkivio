import { Circle, CircleDashed, CircleMinus, CircleSlash } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { EffectiveStatus } from '@/lib/types';
import { useT, type MessageKey } from '@/i18n';

/** Presence uses icon + text + color, never color alone (ch. 05). `label`/`description` are message keys: render with t(). */
export const STATUS_META: Record<EffectiveStatus, { label: MessageKey; className: string; Icon: typeof Circle; description: MessageKey }> = {
  online: { label: 'ui.status.online', className: 'text-success', Icon: Circle, description: 'ui.status.onlineHelp' },
  away: { label: 'ui.status.away', className: 'text-warning', Icon: CircleMinus, description: 'ui.status.awayHelp' },
  invisible: { label: 'ui.status.invisible', className: 'text-fg-2', Icon: CircleDashed, description: 'ui.status.invisibleHelp' },
  offline: { label: 'ui.status.offline', className: 'text-fg-2', Icon: CircleSlash, description: 'ui.status.offlineHelp' },
};

export function StatusIcon({ status, className }: { status: EffectiveStatus; className?: string }) {
  const m = STATUS_META[status];
  return <m.Icon className={cn('size-3 shrink-0', m.className, status === 'online' && 'fill-current', className)} aria-hidden />;
}

export function StatusLabel({ status, className }: { status: EffectiveStatus; className?: string }) {
  const t = useT();
  const m = STATUS_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
      <StatusIcon status={status} />
      <span>{t(m.label)}</span>
    </span>
  );
}
