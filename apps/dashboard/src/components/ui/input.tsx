'use client';
import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { useT } from '@/i18n';

export const controlClass =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-3 transition-colors ' +
  'hover:border-fg-3 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-0 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3 read-only:bg-surface-2 ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:outline-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  const field = useFieldControl();
  return <input ref={ref} {...field} {...rest} className={cn(controlClass, 'h-10 py-2.5', className)} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  const field = useFieldControl();
  return <textarea ref={ref} {...field} {...rest} className={cn(controlClass, 'min-h-24 py-2.5 leading-5', className)} />;
});

/** Password input with an explicit Show/Hide toggle; paste and managers allowed (ch. 07). */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function PasswordInput({ className, ...rest }, ref) {
  const t = useT();
  const field = useFieldControl();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input ref={ref} {...field} {...rest} type={shown ? 'text' : 'password'} className={cn(controlClass, 'h-10 py-2.5 pe-20', className)} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="absolute inset-y-1 end-1 inline-flex items-center gap-1 rounded-md px-2 text-xs font-medium text-fg-2 hover:bg-surface-3 hover:text-fg"
        aria-pressed={shown}
        aria-label={shown ? t('ui.password.hideLabel') : t('ui.password.showLabel')}
      >
        {shown ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
        {shown ? t('ui.password.hide') : t('ui.password.show')}
      </button>
    </div>
  );
});
