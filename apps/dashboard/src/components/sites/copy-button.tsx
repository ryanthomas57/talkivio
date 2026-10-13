'use client';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui';
import { useT } from '@/i18n';

/**
 * Copies text to the clipboard and announces the result politely. `what` is a translated
 * noun phrase ("site key") used in the accessible name and the announcement.
 */
export function CopyButton({
  text,
  label,
  copiedLabel,
  what,
  ...rest
}: Omit<ButtonProps, 'onClick' | 'children'> & {
  text: string;
  label?: string;
  copiedLabel?: string;
  what?: string;
}) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        {...rest}
        onClick={() => void copy()}
        aria-label={what ? (label ? t('sites.copy.labelWhat', { label, what }) : t('sites.copy.copyWhat', { what })) : undefined}
      >
        {state === 'copied' ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
        {state === 'copied' ? (copiedLabel ?? t('common.copied')) : state === 'failed' ? t('sites.copy.failed') : (label ?? t('common.copy'))}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? (what ? t('sites.copy.copiedWhat', { what }) : t('sites.copy.copiedText')) : state === 'failed' ? t('sites.copy.failedHint') : ''}
      </span>
    </>
  );
}

/** Read-only code block with a Copy action. Code stays left-to-right in every UI language. */
export function CodeBlock({ code, what, className }: { code: string; what: string; className?: string }) {
  return (
    <div className={className}>
      <div className="relative" dir="ltr">
        <pre
          className="overflow-x-auto rounded-[var(--radius-control)] border border-line bg-surface-2 p-4 pe-24 text-start font-mono text-xs leading-5 text-fg scroll-thin"
          tabIndex={0}
          aria-label={what}
        >
          <code>{code}</code>
        </pre>
        <div className="absolute end-2 top-2">
          <CopyButton text={code} what={what} />
        </div>
      </div>
    </div>
  );
}
