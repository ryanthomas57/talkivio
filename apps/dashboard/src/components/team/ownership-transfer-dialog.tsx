'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Banner, Button, Combobox, Dialog, DialogContent, Field, Textarea } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { Agent } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isReauthCancelled, useReauth } from './reauth-dialog';
import { ROLE_LABEL } from './roles';

/**
 * Owner-only ownership transfer (ch. 04/07). Requires recent re-authentication; the
 * current owner becomes an admin and both memberships reconnect with new permissions.
 */
export function OwnershipTransferDialog({
  open,
  onOpenChange,
  agents,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agents: Agent[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const self = useSession((s) => s.agent?.agent.id ?? null);
  const tenant = useSession((s) => s.tenant?.name ?? null);
  const tenantName = tenant ? isolate(tenant) : t('team.transfer.thisWorkspace');
  const { withReauth, reauthDialog } = useReauth();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ target?: string; reason?: string }>({});

  const eligible = agents.filter((a) => a.id !== self && a.enabled && a.role !== 'owner');
  const chosen = eligible.find((a) => a.id === target);

  const reset = () => {
    setTarget(null);
    setReason('');
    setError(null);
    setFieldErrors({});
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const fe: typeof fieldErrors = {};
    if (!target) fe.target = t('team.transfer.errTarget');
    if (!reason.trim()) fe.reason = t('team.transfer.errReason');
    setFieldErrors(fe);
    if (fe.target || fe.reason) return;
    setBusy(true);
    setError(null);
    try {
      await withReauth(
        () =>
          api.post('/tenants/current/ownership-transfer', {
            targetMembershipId: target,
            reason: reason.trim(),
          }),
        t('team.transfer.reauthAction'),
      );
      toast.success(
        chosen
          ? t('team.transfer.success', { name: isolate(chosen.displayName), workspace: tenantName })
          : t('team.transfer.successNoName', { workspace: tenantName }),
      );
      reset();
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: qk.agents });
      // Our own role changed; the server also closes live sessions so permissions refresh.
      void useSession
        .getState()
        .refreshAgent()
        .catch(() => undefined);
    } catch (err) {
      if (isReauthCancelled(err)) setError(errorMessage(err));
      else if (isApiError(err, 'NOT_FOUND'))
        setError(t('team.transfer.notEligible'));
      else if (isApiError(err, 'CONFLICT'))
        setError(t('team.transfer.conflict', { error: errorMessage(err) }));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return;
          if (!o) reset();
          onOpenChange(o);
        }}
      >
        <DialogContent
          size="md"
          title={t('team.transfer.title')}
          description={t('team.transfer.description', { workspace: tenantName })}
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
              <Button
                variant="danger"
                type="submit"
                form="transfer-form"
                loading={busy}
                disabled={!eligible.length}
              >
                {t('team.transfer.title')}
              </Button>
            </>
          }
        >
          <form id="transfer-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {error && <Banner tone="danger">{error}</Banner>}
            <Banner tone="warning" title={t('team.transfer.whatChanges')}>
              <ul className="ms-4 list-disc">
                <li>
                  {chosen
                    ? t('team.transfer.changeOwner', { name: isolate(chosen.displayName) })
                    : t('team.transfer.changeOwnerNoName')}
                </li>
                <li>{t('team.transfer.changeAdmin')}</li>
                <li>{t('team.transfer.changeReconnect')}</li>
              </ul>
            </Banner>
            {eligible.length === 0 ? (
              <p className="text-sm text-fg-2">
                {t('team.transfer.noEligible')}
              </p>
            ) : (
              <Field
                label={t('team.transfer.newOwner')}
                description={t('team.transfer.newOwnerHint')}
                error={fieldErrors.target}
                required
              >
                <Combobox
                  value={target}
                  onChange={setTarget}
                  options={eligible.map((a) => ({
                    value: a.id,
                    label: a.displayName,
                    hint: t(ROLE_LABEL[a.role]),
                    keywords: [a.email],
                  }))}
                  placeholder={t('team.transfer.placeholder')}
                  searchPlaceholder={t('team.transfer.searchPlaceholder')}
                />
              </Field>
            )}
            <Field
              label={t('team.transfer.reason')}
              description={t('team.transfer.reasonHint')}
              error={fieldErrors.reason}
              required
            >
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                className="min-h-20"
              />
            </Field>
            <p className="text-xs text-fg-2">{t('team.transfer.reauthNote')}</p>
          </form>
        </DialogContent>
      </Dialog>
      {reauthDialog}
    </>
  );
}
