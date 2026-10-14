'use client';
/**
 * Merge request (ch. 17/25): never merges directly. The request is queued for
 * admin review, the target must carry verified identity proof, and matching
 * email text is never accepted as proof.
 */
import { GitMerge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Banner, Button, Dialog, DialogContent, Field, Input, Textarea } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { MergeRequestResult, VisitorListItem } from './types';
import { VisitorPicker } from './visitor-picker';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MergeDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  source: { id: string; displayName: string };
}) {
  const t = useT();
  const [target, setTarget] = useState<VisitorListItem | null>(null);
  const [proof, setProof] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [result, setResult] = useState<MergeRequestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(null);
    setProof('');
    setReason('');
    setError(null);
    setFe({});
    setResult(null);
  }, [open]);

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!target) errs.target = t('visitors.merge.errTargetRequired');
    else if (!target.identityVerified) errs.target = t('visitors.merge.errTargetUnverified');
    if (proof.trim().length < 3) errs.proof = t('visitors.merge.errProofShort');
    else if (EMAIL_RE.test(proof.trim().toLowerCase())) errs.proof = t('visitors.merge.errProofEmail');
    if (reason.trim().length < 3) errs.reason = t('visitors.merge.errReason');
    setFe(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.post<MergeRequestResult>('/visitors/merge-requests', {
          sourceId: source.id,
          targetId: target!.id,
          proofReference: proof.trim(),
          reason: reason.trim(),
        }),
      );
    } catch (e) {
      if (e instanceof ApiError)
        setFe({
          target: e.field('target_id') ?? '',
          proof: e.field('proof_reference') ?? '',
          reason: e.field('reason') ?? '',
        });
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={t('visitors.merge.title', { name: isolate(source.displayName) })}
        description={t('visitors.merge.description')}
        footer={
          result ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t('common.done')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void submit()} loading={busy}>
                <GitMerge className="size-4" aria-hidden /> {t('visitors.merge.submit')}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <Banner tone="success" title={t('visitors.merge.successTitle')}>
            {t('visitors.merge.successBody', {
              id: isolate(result.id.slice(0, 8)),
              state: result.reviewState,
              stateText: result.reviewState.replace(/_/g, ' '),
              name: isolate(source.displayName),
            })}
          </Banner>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <VisitorPicker
              label={t('visitors.merge.pickerLabel')}
              description={t('visitors.merge.pickerDescription')}
              value={target}
              onChange={setTarget}
              excludeId={source.id}
              identifiedOnly
              error={fe.target || undefined}
            />
            <Field
              label={t('visitors.merge.proofLabel')}
              required
              description={t('visitors.merge.proofDescription')}
              error={fe.proof || undefined}
            >
              <Input value={proof} onChange={(e) => setProof(e.target.value)} maxLength={200} />
            </Field>
            <Field label={t('visitors.merge.reason')} required error={fe.reason || undefined}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
            </Field>
            {error && <Banner tone="danger">{error}</Banner>}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
