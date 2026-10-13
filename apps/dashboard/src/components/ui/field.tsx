'use client';
/**
 * Form field wrapper (ch. 05): visible label, optional description, and an error
 * line with an icon that the control references through aria-describedby.
 */
import { AlertCircle } from 'lucide-react';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface FieldCtx {
  id: string;
  descriptionId: string;
  errorId: string;
  invalid: boolean;
  hasDescription: boolean;
  required: boolean;
}

const Ctx = createContext<FieldCtx | null>(null);

/** Props to spread onto the control inside a <Field>. */
export function useFieldControl(): { id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; 'aria-required'?: boolean } {
  const c = useContext(Ctx);
  if (!c) return {};
  const describedBy = [c.hasDescription ? c.descriptionId : null, c.invalid ? c.errorId : null].filter(Boolean).join(' ');
  return { id: c.id, 'aria-invalid': c.invalid || undefined, 'aria-describedby': describedBy || undefined, 'aria-required': c.required || undefined };
}

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  id?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Field({ label, description, error, required = false, className, hideLabel, id, action, children }: FieldProps) {
  const auto = useId();
  const base = id ?? `f${auto.replace(/:/g, '')}`;
  const ctx: FieldCtx = { id: base, descriptionId: `${base}-desc`, errorId: `${base}-err`, invalid: !!error, hasDescription: !!description, required };
  return (
    <Ctx.Provider value={ctx}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        <div className={cn('flex items-center justify-between gap-2', hideLabel && 'sr-only')}>
          <label htmlFor={base} className="text-sm font-medium text-fg">
            {label}
            {required && (
              <span className="ms-0.5 text-danger" aria-hidden>
                *
              </span>
            )}
          </label>
          {action}
        </div>
        {children}
        {description && !error && (
          <p id={ctx.descriptionId} className="text-xs text-fg-2">
            {description}
          </p>
        )}
        {description && error && (
          <p id={ctx.descriptionId} className="sr-only">
            {description}
          </p>
        )}
        {error && (
          <p id={ctx.errorId} className="flex items-start gap-1.5 text-xs font-medium text-danger" role="alert">
            <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}
      </div>
    </Ctx.Provider>
  );
}
