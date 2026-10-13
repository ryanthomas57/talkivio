import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'note';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-fg-2',
  primary: 'bg-primary-tint text-primary-hover dark:text-primary',
  success: 'bg-success-tint text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  info: 'bg-info-tint text-info',
  note: 'bg-note text-note-fg',
};

export function Badge({ tone = 'neutral', icon, className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; icon?: ReactNode }) {
  return (
    <span {...rest} className={cn('inline-flex h-6 max-w-full items-center gap-1 rounded-full px-2.5 text-xs font-medium', tones[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Numeric counter capped visually at 99+, with the full value for assistive tech. */
export function CountBadge({ count, label, tone = 'primary', className }: { count: number; label: string; tone?: 'primary' | 'danger' | 'neutral'; className?: string }) {
  const tr = useT();
  if (count <= 0) return null;
  const t = tone === 'primary' ? 'bg-primary text-primary-fg' : tone === 'danger' ? 'bg-danger text-danger-fg' : 'bg-surface-3 text-fg-2';
  return (
    <span className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular', t, className)}>
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      {/* Full count for assistive tech (aria-label is not permitted on a generic span). */}
      <span className="sr-only">{tr('ui.countBadge.sr', { count, label })}</span>
    </span>
  );
}
