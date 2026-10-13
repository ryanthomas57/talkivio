'use client';
import * as T from '@radix-ui/react-tabs';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

export const Tabs = T.Root;
export const TabsContent = T.Content;

export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof T.List>>(function TabsList({ className, ...rest }, ref) {
  return <T.List ref={ref} {...rest} className={cn('flex items-end gap-1 overflow-x-auto border-b border-line scroll-thin', className)} />;
});

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof T.Trigger>>(function TabsTrigger({ className, ...rest }, ref) {
  return (
    <T.Trigger
      ref={ref}
      {...rest}
      className={cn(
        'relative -mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium text-fg-2 transition-colors hover:text-fg',
        'data-[state=active]:border-primary data-[state=active]:text-fg',
        className,
      )}
    />
  );
});
