'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Banner, Button, Dialog, DialogContent, Field, Input } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { Site } from '@/lib/types';
import {
  duplicateOriginErrors,
  newOriginRow,
  OriginsEditor,
  originErrorsFrom,
  originsPayload,
  type OriginRow,
} from './origins-editor';

export function CreateSiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<OriginRow[]>([newOriginRow()]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [originErrors, setOriginErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName('');
    setRows([newOriginRow()]);
    setNameError(null);
    setOriginErrors({});
    setError(null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    const nErr = name.trim() ? null : t('sites.create.nameRequired');
    const dup = duplicateOriginErrors(rows);
    const { origins, indexMap } = originsPayload(rows);
    const oErr: Record<number, string> = { ...dup };
    if (!origins.length) oErr[0] = t('sites.create.originRequired');
    setNameError(nErr);
    setOriginErrors(oErr);
    if (nErr || Object.keys(oErr).length) return;
    setBusy(true);
    try {
      const site = await api.post<Site>('/sites', { name: name.trim(), origins });
      await qc.invalidateQueries({ queryKey: qk.sites });
      toast.success(t('sites.create.created', { name: isolate(site.name) }));
      reset();
      onOpenChange(false);
      router.push(`/settings/sites/${site.id}?tab=installation`);
    } catch (err) {
      const rowErrors = originErrorsFrom(err, indexMap);
      setOriginErrors(rowErrors);
      if (isApiError(err)) setNameError(err.field('name') ?? null);
      setError(Object.keys(rowErrors).length ? t('sites.create.fixOrigins') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent
        size="lg"
        title={t('sites.create.title')}
        description={t('sites.create.description')}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form="create-site-form" loading={busy}>
              {t('sites.create.submit')}
            </Button>
          </>
        }
      >
        <form id="create-site-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
          {error && <Banner tone="danger">{error}</Banner>}
          <Field
            label={t('sites.create.name')}
            description={t('sites.create.nameHint')}
            error={nameError}
            required
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus dir="auto" />
          </Field>
          <OriginsEditor rows={rows} onChange={setRows} errors={originErrors} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
