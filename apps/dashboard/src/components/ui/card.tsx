'use client';
import { useEffect, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTopbarSlots } from '@/components/shell/topbar-slots';
import { useMediaQuery } from '@/hooks/use-media';
import { cn } from '@/lib/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('rounded-[var(--radius-card)] border border-line bg-surface', className)} />
  );
}

/** Card title band in the logo colour family (tinted), with optional description and action. */
export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 rounded-t-[calc(var(--radius-card)-1px)] border-b border-line-subtle bg-primary-tint px-4 py-3 sm:px-6',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-base font-semibold leading-6 text-primary-hover dark:text-primary">{title}</h2>
        {description && <p className="text-sm text-fg-2">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('px-4 py-4 sm:px-6 sm:py-5', className)} />;
}

/**
 * Page title row: H1 + description + primary actions. Inside the app shell the title (a logo-coloured box) and
 * the actions go to the top bar, so the page keeps its height for content; elsewhere they render in place.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const slots = useTopbarSlots();
  const roomyTopbar = useMediaQuery('(min-width: 768px)', true);
  const claim = slots?.claim;
  useEffect(() => claim?.(), [claim]);
  if (slots) {
    const heading = (
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="min-w-0 truncate rounded-md bg-primary px-3 py-1 text-base font-semibold leading-6 text-primary-fg">
          {title}
        </h1>
        {description && <p className="hidden min-w-0 truncate text-xs text-fg-2 lg:block">{description}</p>}
      </div>
    );
    return (
      <>
        {slots.title && createPortal(heading, slots.title)}
        {actions &&
          (roomyTopbar ? (
            slots.actions && createPortal(actions, slots.actions)
          ) : (
            <div className={cn('flex flex-wrap items-center gap-2', className)}>{actions}</div>
          ))}
      </>
    );
  }
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
  return (
    <div
      {...rest}
      className={cn('mx-auto flex w-full max-w-[1280px] flex-col gap-6 p-4 lg:p-6', className)}
    />
  );
}
