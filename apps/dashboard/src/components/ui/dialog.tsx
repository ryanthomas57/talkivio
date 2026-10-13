'use client';
/**
 * Dialog and drawer on Radix Dialog: focus is trapped, Escape closes, and focus
 * returns to the opener (ch. 06). Shadows only on floating surfaces (ch. 05).
 */
import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { Button } from './button';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
  onEscapeKeyDown,
  hideClose,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
  hideClose?: boolean;
}) {
  const t = useT();
  const w = { sm: 'max-w-[420px]', md: 'max-w-[520px]', lg: 'max-w-[680px]', xl: 'max-w-[880px]' }[size];
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
      <D.Content
        onEscapeKeyDown={onEscapeKeyDown}
        aria-describedby={description ? undefined : undefined}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-dialog)] data-[state=open]:animate-scale-in',
          w,
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-subtle px-6 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <D.Title className="text-base font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="text-sm text-fg-2">{description}</D.Description> : <D.Description className="sr-only">{typeof title === 'string' ? title : t('ui.dialog.fallbackTitle')}</D.Description>}
          </div>
          {!hideClose && (
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.close')} className="-me-2 -mt-1">
                <X className="size-4" />
              </Button>
            </D.Close>
          )}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scroll-thin">{children}</div>}
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-subtle px-6 py-4">{footer}</div>}
      </D.Content>
    </D.Portal>
  );
}

/** Side drawer (visitor panel, agent details, mobile navigation). */
export function DrawerContent({
  title,
  description,
  children,
  footer,
  side = 'right',
  width = 420,
  className,
  hideHeader,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  side?: 'left' | 'right';
  width?: number;
  className?: string;
  hideHeader?: boolean;
}) {
  const t = useT();
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
      <D.Content
        style={{ width: `min(${width}px, 100vw)` }}
        className={cn(
          'fixed inset-y-0 z-50 flex flex-col bg-surface shadow-[var(--shadow-dialog)]',
          // side is logical: 'right' = the end edge (left in RTL), 'left' = the start edge.
          side === 'right' ? 'end-0 data-[state=open]:animate-slide-in-right rtl:data-[state=open]:animate-slide-in-left' : 'start-0 data-[state=open]:animate-slide-in-left rtl:data-[state=open]:animate-slide-in-right',
          className,
        )}
      >
        <div className={cn('flex items-start justify-between gap-4 border-b border-line-subtle px-5 py-4', hideHeader && 'sr-only')}>
          <div className="flex min-w-0 flex-col gap-1">
            <D.Title className="truncate text-base font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="text-sm text-fg-2">{description}</D.Description> : <D.Description className="sr-only">{typeof title === 'string' ? title : t('ui.dialog.fallbackPanel')}</D.Description>}
          </div>
          <D.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('ui.dialog.closePanel')} className="-me-2">
              <X className="size-4" />
            </Button>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line-subtle px-5 py-4">{footer}</div>}
      </D.Content>
    </D.Portal>
  );
}
