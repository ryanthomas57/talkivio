'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Banner, Button, Dialog, DialogContent, Field, Input, MultiCombobox, Select } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { qk, useDepartments } from '@/lib/queries';
import type { Role } from '@/lib/types';
import { useSession } from '@/stores/session';
import { CAPACITY_MAX, CAPACITY_MIN } from './agent-draft';
import { RoleSummary } from './agent-drawer';
import { ASSIGNABLE_ROLES, ROLE_LABEL } from './roles';

export const invitationsKey = ['agents', 'invitations'] as const;

export interface Invitation {
  id: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  departmentIds: string[];
  capacity: number;
  createdAt: string;
  expiresAt: string;
}

export interface InviteInput {
  email: string;
  role: Exclude<Role, 'owner'>;
  departmentIds: string[];
  capacity: number;
}

/** Shared failure copy for invitation errors (also used by "Resend"). */
export function useInviteErrorBanner() {
  const t = useT();
  const email = useSession((s) => s.me?.user.email);
  const [resend, setResend] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const resendVerification = async () => {
    setResend('sending');
    try {
      await api.post('/auth/verify-email/resend');
      setResend('sent');
    } catch {
      setResend('failed');
    }
  };
  return (e: unknown): ReactNode => {
    if (isApiError(e, 'EMAIL_NOT_VERIFIED'))
      return (
        <Banner
          tone="warning"
          title={t('team.invite.verifyTitle')}
          action={
            resend === 'sent' ? (
              <span className="text-sm font-medium text-success">{t('team.invite.emailSent')}</span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={resend === 'sending'}
                onClick={() => void resendVerification()}
              >
                {t('team.invite.resendLink')}
              </Button>
            )
          }
        >
          {email ? t('team.invite.verifyBody', { email: isolate(email) }) : t('team.invite.verifyBodyNoEmail')}
          {resend === 'failed' && ` ${t('team.invite.resendFailed')}`}
        </Banner>
      );
    if (isApiError(e, 'PLAN_LIMIT'))
      return (
        <Banner tone="warning" title={t('team.invite.noSeatsTitle')}>
          {t('team.invite.noSeatsBody', { error: errorMessage(e) })}
        </Banner>
      );
    if (isApiError(e, 'PERMISSION_DENIED'))
      return <Banner tone="danger">{t('team.invite.noPermission')}</Banner>;
    if (isApiError(e, 'NOT_FOUND'))
      return (
        <Banner tone="danger">{t('team.invite.deptMissing')}</Banner>
      );
    return <Banner tone="danger">{errorMessage(e)}</Banner>;
  };
}

export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const departments = useDepartments(open);
  const verified = useSession((s) => s.me?.user.emailVerified ?? true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteInput['role']>('agent');
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const [capacity, setCapacity] = useState('3');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<'email' | 'role' | 'departments' | 'capacity', string>>
  >({});
  const [sent, setSent] = useState<{ email: string; expiresAt: string } | null>(null);
  const describe = useInviteErrorBanner();

  const reset = () => {
    setEmail('');
    setRole('agent');
    setDeptIds([]);
    setCapacity('3');
    setFailure(null);
    setFieldErrors({});
    setSent(null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const fe: typeof fieldErrors = {};
    const trimmed = email.trim();
    if (!trimmed) fe.email = t('team.invite.errEmailRequired');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      fe.email = t('team.invite.errEmailInvalid');
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < CAPACITY_MIN || cap > CAPACITY_MAX)
      fe.capacity = t('team.draft.errCapacity', { min: CAPACITY_MIN, max: CAPACITY_MAX });
    setFieldErrors(fe);
    setFailure(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: string; email: string; expiresAt: string }>('/agents/invitations', {
        email: trimmed,
        role,
        departmentIds: deptIds,
        capacity: cap,
      });
      void qc.invalidateQueries({ queryKey: invitationsKey });
      toast.success(t('team.invite.sentToast', { email: isolate(r.email) }));
      setSent({ email: r.email, expiresAt: r.expiresAt });
      setEmail('');
    } catch (err) {
      if (isApiError(err, 'CONFLICT')) setFieldErrors({ email: errorMessage(err) });
      else if (isApiError(err, 'VALIDATION_FAILED') && Object.keys(err.fieldErrors).length) {
        setFieldErrors({
          email: err.field('email'),
          role: err.field('role'),
          departments: err.field('department_ids'),
          capacity: err.field('capacity'),
        });
        setFailure(err);
      } else {
        setFailure(err);
        if (isApiError(err, 'NOT_FOUND')) void qc.invalidateQueries({ queryKey: qk.departments });
      }
    } finally {
      setBusy(false);
    }
  };

  const options = (departments.data ?? [])
    .filter((d) => !d.archivedAt)
    .map((d) => ({ value: d.id, label: d.name, hint: d.enabled ? undefined : t('team.invite.disabledHint') }));

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
        size="md"
        title={t('team.invite.title')}
        description={t('team.invite.description')}
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
              {sent ? t('common.done') : t('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form="invite-form" loading={busy}>
              {sent ? t('team.invite.sendAnother') : t('team.invite.send')}
            </Button>
          </>
        }
      >
        <form id="invite-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {sent && (
            <Banner tone="success" title={t('team.invite.sentToast', { email: isolate(sent.email) })}>
              {t('team.invite.sentBody', { date: formatDateTime(sent.expiresAt) })}
            </Banner>
          )}
          {!verified && !failure && (
            <Banner tone="info">{t('team.invite.unverifiedNotice')}</Banner>
          )}
          {failure ? describe(failure) : null}
          <Field label={t('team.invite.emailLabel')} error={fieldErrors.email} required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              maxLength={200}
              placeholder="name@company.com" // i18n-ignore (example address)
              dir="ltr"
              autoFocus
            />
          </Field>
          <Field label={t('team.invite.role')} error={fieldErrors.role}>
            <Select value={role} onChange={(e) => setRole(e.target.value as InviteInput['role'])}>
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(ROLE_LABEL[r])}
                </option>
              ))}
            </Select>
          </Field>
          <RoleSummary role={role} />
          <Field
            label={t('common.departments')}
            description={role === 'analyst' ? t('team.invite.deptHintAnalyst') : t('team.invite.deptHint')}
            error={fieldErrors.departments}
          >
            <MultiCombobox
              values={deptIds}
              onChange={setDeptIds}
              options={options}
              placeholder={
                departments.isLoading
                  ? t('team.invite.loadingDepartments')
                  : options.length
                    ? t('team.invite.chooseDepartments')
                    : t('team.invite.noDepartments')
              }
              searchPlaceholder={t('team.invite.searchDepartments')}
              disabled={!options.length}
            />
          </Field>
          <Field
            label={t('team.invite.capacity')}
            description={t('team.invite.capacityHint', { min: CAPACITY_MIN, max: CAPACITY_MAX })}
            error={fieldErrors.capacity}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={CAPACITY_MIN}
              max={CAPACITY_MAX}
              step={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="w-28 tabular"
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
