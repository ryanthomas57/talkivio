import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const tones = {
  info: { cls: 'border-info/30 bg-info-tint text-info', Icon: Info },
  success: { cls: 'border-success/30 bg-success-tint text-success', Icon: CheckCircle2 },
  warning: { cls: 'border-warning/30 bg-warning-tint text-warning', Icon: AlertTriangle },
  danger: { cls: 'border-danger/30 bg-danger-tint text-danger', Icon: XCircle },
} as const;

/** Inline status banner; failures stay on screen (toasts are never the sole evidence). */
export function Banner({ tone = 'info', title, children, action, className, live = tone === 'danger' ? 'assertive' : 'polite' }: { tone?: keyof typeof tones; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; live?: 'polite' | 'assertive' | 'off' }) {
  const t = tones[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} aria-live={live} className={cn('flex items-start gap-3 rounded-[var(--radius-control)] border px-3 py-2.5 text-sm', t.cls, className)}>
      <t.Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-fg')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
