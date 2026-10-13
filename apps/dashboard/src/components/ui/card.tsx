import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('rounded-[var(--radius-card)] border border-line bg-surface', className)} />;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line-subtle px-4 py-4 sm:px-6', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-base font-semibold leading-6">{title}</h2>
        {description && <p className="text-sm text-fg-2">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('px-4 py-4 sm:px-6 sm:py-5', className)} />;
}

/** Page title row: H1 + description + primary actions. */
export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Standard page container: 24 px desktop / 16 px compact padding (ch. 05). */
export function Page({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('mx-auto flex w-full max-w-[1280px] flex-col gap-6 p-4 lg:p-6', className)} />;
}
