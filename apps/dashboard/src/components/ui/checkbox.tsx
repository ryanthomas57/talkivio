'use client';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { Check, Minus } from 'lucide-react';
import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(function Checkbox({ className, ...rest }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      {...rest}
      className={cn(
        'peer inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-fg-3 bg-surface transition-colors',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-fg',
        'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-fg',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <CheckboxPrimitive.Indicator>{rest.checked === 'indeterminate' ? <Minus className="size-3.5" strokeWidth={3} /> : <Check className="size-3.5" strokeWidth={3} />}</CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

/** Checkbox with a clickable label and optional description (44 px touch row). */
export function CheckboxField({ label, description, className, ...rest }: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex min-h-11 items-start gap-3 py-2', className)}>
      <Checkbox id={id} aria-describedby={description ? `${id}-d` : undefined} {...rest} className="mt-0.5" />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description && (
          <p id={`${id}-d`} className="text-xs text-fg-2">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

export const Switch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(function Switch({ className, ...rest }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      {...rest}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border-2 border-transparent bg-fg-3/50 transition-colors data-[state=checked]:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  );
});

/** Labelled switch row used throughout settings. */
export function SwitchField({ label, description, className, ...rest }: ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex min-h-11 items-center justify-between gap-6 py-2', className)}>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description && (
          <p id={`${id}-d`} className="text-xs text-fg-2">
            {description}
          </p>
        )}
      </div>
      <Switch id={id} aria-describedby={description ? `${id}-d` : undefined} {...rest} />
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/** Native radio group in a fieldset with legend. */
export function RadioGroup<T extends string>({ legend, name, value, onChange, options, className }: { legend: ReactNode; name: string; value: T; onChange: (v: T) => void; options: RadioOption<T>[]; className?: string }) {
  return (
    <fieldset className={cn('flex flex-col gap-1', className)}>
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      {options.map((o) => {
        const id = `${name}-${o.value}`;
        return (
          <div key={o.value} className="flex min-h-11 items-start gap-3 py-1.5">
            <input
              id={id}
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              aria-describedby={o.description ? `${id}-d` : undefined}
              className="mt-0.5 size-[18px] shrink-0 accent-[var(--primary)]"
            />
            <div className="flex flex-col gap-0.5">
              <label htmlFor={id} className="text-sm font-medium text-fg">
                {o.label}
              </label>
              {o.description && (
                <p id={`${id}-d`} className="text-xs text-fg-2">
                  {o.description}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
