'use client';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { useT } from '@/i18n';
import { Button } from './button';
import { Dialog, DialogContent } from './dialog';
import { Banner } from './banner';

/**
 * Confirmation that names the object and the consequence (ch. 06). Dangerous
 * actions use the danger button; failures stay visible inside the dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  children?: ReactNode;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) {
          setError(null);
          onOpenChange(o);
        }
      }}
    >
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={run} loading={busy}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {(children || error) && (
          <div className="flex flex-col gap-3">
            {children}
            {error && <Banner tone="danger">{error}</Banner>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
