'use client';
import { ChevronDown } from 'lucide-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { controlClass } from './input';

/** Native select (full keyboard + screen reader support) with product styling. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { size?: never; compact?: boolean }>(function Select(
  { className, children, compact, ...rest },
  ref,
) {
  const field = useFieldControl();
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} {...field} {...rest} className={cn(controlClass, 'appearance-none pe-9', compact ? 'h-8 py-1' : 'h-10 py-2')}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-fg-2" aria-hidden />
    </div>
  );
});
