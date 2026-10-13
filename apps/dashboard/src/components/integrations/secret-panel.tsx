'use client';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { Banner, Button, Dialog, DialogContent, type ButtonProps } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

/** Fallback when the async Clipboard API is unavailable or denied (e.g. the document lost focus). */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  // Inside a modal dialog the focus trap only allows focus within the dialog, so attach there.
  (active?.closest('[role="dialog"]') ?? document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus();
  return ok;
}

/**
 * Copies text and announces the result politely (the visible label changes too).
 * `what` is a translated noun phrase naming the value ("event id"), used in the accessible name and status.
 */
export function CopyButton({ text, what, onCopied, ...rest }: Omit<ButtonProps, 'onClick' | 'children'> & { text: string; what: string; onCopied?: () => void }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? 'copied' : 'failed');
    if (ok) onCopied?.();
  };
  return (
    <>
      <Button size="sm" variant="secondary" {...rest} onClick={() => void copy()} aria-label={t('integrations.copy.ariaLabel', { what })}>
        {state === 'copied' ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {state === 'copied' ? t('common.copied') : state === 'failed' ? t('integrations.copy.failed') : t('common.copy')}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? t('integrations.copy.copiedStatus', { what }) : state === 'failed' ? t('integrations.copy.failedStatus') : ''}
      </span>
    </>
  );
}

/**
 * One-time secret display (ch. 55: secrets are shown once). The value is selectable
 * and copyable; the warning is explicit that it cannot be retrieved later.
 */
export function SecretPanel({ label, value, what, children, onCopied }: { label: string; value: string; what: string; children?: ReactNode; onCopied?: () => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <div role="alert" className="flex items-start gap-3 rounded-[var(--radius-control)] border border-warning/30 bg-warning-tint px-3 py-2.5 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="text-fg">
          <p className="font-semibold text-warning">{t('integrations.secret.warningTitle')}</p>
          <p className="mt-0.5">{t('integrations.secret.warningBody', { brand: BRAND_NAME, what })}</p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id={id}
            readOnly
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            autoComplete="off"
            dir="ltr"
            className={cn('h-10 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 font-mono text-sm text-fg', 'focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-0')}
          />
          <CopyButton text={value} what={what} size="md" onCopied={onCopied} />
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * Modal that shows a freshly issued secret. It can only be dismissed with “Done”
 * (Escape, outside clicks and the close icon are disabled) so the secret is not lost
 * by accident before it was copied.
 */
export function OneTimeSecretDialog({
  open,
  title,
  description,
  label,
  value,
  what,
  onDone,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  label: string;
  value: string | null;
  what: string;
  onDone: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open) setCopied(false);
  }, [open, value]);
  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      {open && (
        <DialogContent
          size="md"
          title={title}
          description={description}
          hideClose
          onEscapeKeyDown={(e) => e.preventDefault()}
          footer={
            <Button variant={copied || !value ? 'primary' : 'secondary'} onClick={onDone}>
              {value && !copied ? t('integrations.secret.doneStored') : t('common.done')}
            </Button>
          }
        >
          {value ? (
            <SecretPanel label={label} value={value} what={what} onCopied={() => setCopied(true)}>
              {children}
            </SecretPanel>
          ) : (
            <Banner tone="warning" title={t('integrations.secret.goneTitle')}>
              {t('integrations.secret.goneBody')}
            </Banner>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Read-only code sample with a Copy action. */
export function CodeSample({ code, what, className }: { code: string; what: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex justify-end">
        <CopyButton text={code} what={what} />
      </div>
      <pre dir="ltr" className="max-h-[420px] overflow-auto rounded-[var(--radius-control)] border border-line bg-surface-2 p-4 font-mono text-xs leading-5 text-fg scroll-thin" tabIndex={0} aria-label={what}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
