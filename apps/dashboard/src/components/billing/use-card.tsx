'use client';
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, Field, Input } from '@/components/ui';
import { useT } from '@/i18n';
import { captureCard, type CaptureResult } from '@/lib/billing';

/**
 * Adds a card through the gateway's hosted form (Converge Lightbox). On a server using the test gateway it asks for
 * a test card number in a small dialog instead; only its last four digits leave the browser.
 */
export function useCardCapture(): { capture: () => Promise<CaptureResult>; dialog: ReactNode } {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('4242 4242 4242 4242');
  const pending = useRef<((v: string | null) => void) | null>(null);

  const askTestCard = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        pending.current = resolve;
        setOpen(true);
      }),
    [],
  );
  const finish = (v: string | null) => {
    pending.current?.(v);
    pending.current = null;
    setOpen(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (number.replace(/\D/g, '').length >= 12) finish(number);
  };

  const capture = useCallback(async (): Promise<CaptureResult> => {
    try {
      return await captureCard(askTestCard);
    } catch {
      return { ok: false, reason: 'error', message: t('billing.card.loadError') };
    }
  }, [askTestCard, t]);

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent
        title={t('billing.test.title')}
        description={t('billing.test.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => finish(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form="test-card-form">
              {t('billing.test.submit')}
            </Button>
          </>
        }
      >
        <form id="test-card-form" onSubmit={submit}>
          <Field label={t('billing.test.number')}>
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              maxLength={23}
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
  return { capture, dialog };
}
