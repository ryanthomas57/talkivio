import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Semantic data table pieces. Wrap in TableScroll for horizontal overflow on narrow screens. */
/** `relative` makes this the containing block of absolutely positioned descendants (e.g. `sr-only`), so they are clipped here instead of widening the page. */
export function TableScroll({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('relative w-full overflow-x-auto scroll-thin', className)} />;
}

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return <table {...rest} className={cn('w-full border-collapse text-left text-sm', className)} />;
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...rest} className={cn('sticky top-0 z-[1] bg-primary-tint', className)} />;
}

export function TR({
  className,
  interactive,
  selected,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      {...rest}
      aria-selected={selected || undefined}
      className={cn(
        'border-b border-line-subtle last:border-b-0',
        interactive && 'cursor-pointer hover:bg-surface-2',
        selected && 'bg-primary-tint/60',
        className,
      )}
    />
  );
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      {...rest}
      className={cn(
        'h-10 whitespace-nowrap border-b border-line px-4 text-xs font-semibold uppercase tracking-wide text-primary-hover dark:text-primary',
        className,
      )}
    />
  );
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={cn('h-12 px-4 align-middle text-fg', className)} />;
}
