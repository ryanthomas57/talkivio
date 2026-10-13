'use client';
import { Slot } from '@radix-ui/react-slot';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-primary/50',
  secondary: 'border border-line bg-surface text-fg hover:bg-surface-3 disabled:text-fg-3',
  ghost: 'text-fg-2 hover:bg-surface-3 hover:text-fg disabled:text-fg-3',
  danger: 'bg-danger text-danger-fg hover:bg-danger-hover disabled:bg-danger/50',
  'danger-ghost': 'text-danger hover:bg-danger-tint disabled:opacity-50',
  link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-base',
  icon: 'h-10 w-10 justify-center',
  'icon-sm': 'h-8 w-8 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps width and label while showing progress (ch. 05 submitting state). */
  loading?: boolean;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, asChild = false, className, children, disabled, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-colors disabled:cursor-not-allowed',
        variants[variant],
        variant !== 'link' && sizes[size],
        className,
      )}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        <>
          {/* opacity, not visibility: the label stays the button's accessible name while the spinner shows */}
          <span className={cn('inline-flex items-center gap-[inherit]', loading && 'opacity-0')}>{children}</span>
          {loading && (
            <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
              <Loader2 className="size-4 animate-spin" />
            </span>
          )}
        </>
      )}
    </Comp>
  );
});
