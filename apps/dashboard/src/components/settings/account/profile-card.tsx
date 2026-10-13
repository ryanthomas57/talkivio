'use client';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Badge, Banner, Button, Card, CardBody, CardHeader, Field, Input } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { AgentMe, Me } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isEqual, SaveBar } from '../form-kit';

interface ProfileForm {
  name: string;
  avatarUrl: string;
  title: string;
  workspaceName: string;
}

function isUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Profile: account-wide name and avatar (PATCH /auth/profile) plus the title and an
 * optional name override for this workspace (PATCH /agents/me/preferences).
 */
export function ProfileCard({ onDirtyChange, registerSave }: { onDirtyChange: (d: boolean) => void; registerSave: (fn: () => Promise<boolean>) => void }) {
  const t = useT();
  const me = useSession((s) => s.me);
  const agent = useSession((s) => s.agent);
  const setAgent = useSession((s) => s.setAgent);
  const tenantName = useSession((s) => s.tenant?.name);

  const baseline = useMemo<ProfileForm | null>(() => {
    if (!me || !agent) return null;
    const override = agent.agent.displayName !== me.user.displayName ? agent.agent.displayName : '';
    return { name: me.user.displayName, avatarUrl: me.user.avatarUrl ?? '', title: agent.agent.title ?? '', workspaceName: override };
  }, [me, agent]);
  const [draft, setDraft] = useState<ProfileForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileForm, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? baseline;
  const dirty = !!draft && !!baseline && !isEqual(draft, baseline);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const set = (patch: Partial<ProfileForm>) => {
    if (!value) return;
    setDraft({ ...value, ...patch });
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k as keyof ProfileForm];
      return next;
    });
  };

  const save = async (): Promise<boolean> => {
    if (!draft || !baseline || !dirty) return true;
    const fe: typeof errors = {};
    if (!draft.name.trim()) fe.name = t('settings.profile.nameRequired');
    else if (draft.name.trim().length > 120) fe.name = t('settings.profile.maxChars', { max: 120 });
    if (draft.avatarUrl.trim() && (!isUrl(draft.avatarUrl.trim()) || draft.avatarUrl.trim().length > 500)) fe.avatarUrl = t('settings.profile.avatarInvalid');
    if (draft.title.trim().length > 80) fe.title = t('settings.profile.maxChars', { max: 80 });
    if (draft.workspaceName.trim().length > 120) fe.workspaceName = t('settings.profile.maxChars', { max: 120 });
    setErrors(fe);
    if (Object.keys(fe).length) return false;

    setSaving(true);
    setMessage(null);
    const accountChanged = draft.name.trim() !== baseline.name || draft.avatarUrl.trim() !== baseline.avatarUrl;
    const memberChanged = draft.title.trim() !== baseline.title || draft.workspaceName.trim() !== baseline.workspaceName;
    try {
      if (accountChanged) {
        try {
          const next = await api.patch<Me>('/auth/profile', { displayName: draft.name.trim(), avatarUrl: draft.avatarUrl.trim() || null });
          useSession.setState({ me: next });
        } catch (e) {
          if (e instanceof ApiError) setErrors({ name: e.field('display_name'), avatarUrl: e.field('avatar_url') });
          throw e;
        }
      }
      if (memberChanged) {
        try {
          const next = await api.patch<AgentMe>('/agents/me/preferences', { title: draft.title.trim() || null, displayName: draft.workspaceName.trim() || null });
          setAgent(next);
        } catch (e) {
          if (e instanceof ApiError) setErrors({ title: e.field('title'), workspaceName: e.field('display_name') });
          throw e;
        }
      } else if (accountChanged) {
        // The workspace projection shows the account name when there is no override.
        await useSession.getState().refreshAgent();
      }
      setDraft(null);
      toast.success(t('settings.profile.saved'));
      return true;
    } catch (e) {
      setMessage(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    registerSave(save);
  });

  if (!value || !me) return null;
  const previewName = value.workspaceName.trim() || value.name.trim() || me.user.email;
  const avatarOk = !value.avatarUrl.trim() || isUrl(value.avatarUrl.trim());

  return (
    <Card>
      <CardHeader title={t('settings.profile.title')} description={t('settings.profile.description')} />
      <CardBody className="flex flex-col gap-5">
        {message && <Banner tone="danger">{message}</Banner>}
        <div className="flex items-center gap-4">
          <Avatar name={previewName} src={avatarOk ? value.avatarUrl.trim() || null : null} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold" dir="auto">{previewName}</p>
            {value.title.trim() ? (
              <p className="truncate text-sm text-fg-2" dir="auto">{value.title.trim()}</p>
            ) : (
              <p className="truncate text-sm text-fg-2">{t('settings.profile.noTitle')}</p>
            )}
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('common.name')} required description={t('settings.profile.nameHint')} error={errors.name}>
            <Input value={value.name} maxLength={120} autoComplete="name" dir="auto" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t('settings.profile.avatar')} description={t('settings.profile.avatarHint')} error={errors.avatarUrl}>
            <Input
              value={value.avatarUrl}
              type="url"
              inputMode="url"
              maxLength={500}
              placeholder="https://" // i18n-ignore: URL scheme
              dir="ltr"
              onChange={(e) => set({ avatarUrl: e.target.value })}
            />
          </Field>
          <Field label={t('settings.profile.jobTitle')} description={tenantName ? t('settings.profile.jobTitleHint', { workspace: isolate(tenantName) }) : t('settings.profile.jobTitleHintGeneric')} error={errors.title}>
            <Input value={value.title} maxLength={80} placeholder={t('settings.profile.jobTitlePlaceholder')} dir="auto" onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field
            label={t('settings.profile.workspaceName')}
            description={t('settings.profile.workspaceNameHint')}
            error={errors.workspaceName}
            action={value.workspaceName.trim() ? <Badge tone="info">{t('settings.profile.override')}</Badge> : undefined}
          >
            <Input value={value.workspaceName} maxLength={120} placeholder={value.name} dir="auto" onChange={(e) => set({ workspaceName: e.target.value })} />
          </Field>
        </div>
      </CardBody>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onDiscard={() => (setDraft(null), setErrors({}), setMessage(null))} />
    </Card>
  );
}

/** Sign-in email and verification state with a resend action. */
export function EmailCard() {
  const t = useT();
  const me = useSession((s) => s.me);
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const resend = async () => {
    setState('sending');
    setError(null);
    try {
      await api.post('/auth/verify-email/resend');
      setState('sent');
    } catch (e) {
      setError(errorMessage(e));
      setState('idle');
    }
  };
  return (
    <Card>
      <CardHeader title={t('common.email')} description={t('settings.email.description')} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 break-all text-sm font-medium" dir="ltr">{me.user.email}</span>
          {me.user.emailVerified ? <Badge tone="success">{t('settings.email.verified')}</Badge> : <Badge tone="warning">{t('settings.email.notVerified')}</Badge>}
        </div>
        {!me.user.emailVerified && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-fg-2">{t('settings.email.verifyHint')}</p>
            {state === 'sent' ? (
              <p role="status" className="text-sm font-medium text-success">
                {t('settings.email.sent', { email: isolate(me.user.email) })}
              </p>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void resend()} loading={state === 'sending'}>
                {t('settings.email.resend')}
              </Button>
            )}
          </div>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
      </CardBody>
    </Card>
  );
}
