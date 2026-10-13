import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { Banner } from './banner';
import { Button } from './button';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden />;
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  const t = useT();
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn('size-4 animate-spin text-fg-2', className)} aria-hidden />
      <span className="sr-only">{label ?? t('common.loading')}</span>
    </span>
  );
}

/** Empty list: explains the current filter and offers a meaningful action (ch. 06). */
export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {icon && <div className="flex size-12 items-center justify-center rounded-full bg-surface-3 text-fg-2 [&_svg]:size-6">{icon}</div>}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-semibold text-fg">{title}</p>
        {description && <p className="text-sm text-fg-2">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Partial failure that stays inside its panel with Retry (ch. 06). */
export function PanelError({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  const t = useT();
  return (
    <div className={cn('p-4', className)}>
      <Banner
        tone="danger"
        action={
          onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )
        }
      >
        {message}
      </Banner>
    </div>
  );
}
