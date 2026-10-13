'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Banner, Button, Field, Input, PasswordInput, Spinner } from '@/components/ui';
import { api, errorMessage, isApiError } from '@/lib/api';
import { homeFor } from '@/lib/navigation';
import type { Me } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isolate, useT, type MessageKey } from '@/i18n';

const ROLE_LABEL: Record<string, MessageKey> = { owner: 'auth.role.owner', admin: 'auth.role.admin', supervisor: 'auth.role.supervisor', agent: 'auth.role.agent', analyst: 'auth.role.analyst' };

interface InvitationInfo {
  tenantName: string;
  email: string;
  role: string;
  hasAccount: boolean;
  expiresAt: string;
}

export default function AcceptInvitePage() {
  const t = useT();
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { me, status, load, setMe } = useSession();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | undefined>();

  useEffect(() => {
    void load();
    api
      .get<InvitationInfo>('/agents/invitations/lookup', { token })
      .then(setInfo)
      .catch((e) => setLookupError(isApiError(e, 'NOT_FOUND') ? t('auth.invite.invalid') : errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, load]);

  const signedInAs = status === 'ready' || status === 'no-tenant' ? me?.user.email : null;

  const accept = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (info && !info.hasAccount && !signedInAs && password.length < 12) return setPwError(t('auth.validation.passwordMin'));
    setPwError(undefined);
    setBusy(true);
    try {
      await api.post('/agents/invitations/accept', { token, displayName: displayName.trim() || undefined, password: info?.hasAccount || signedInAs ? undefined : password }, { quietAuth: true });
      const fresh = await api.get<Me>('/auth/me', undefined, { quietAuth: true });
      await setMe(fresh);
      router.replace(homeFor(fresh));
    } catch (err) {
      if (isApiError(err, 'AUTH_REQUIRED')) router.replace(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (lookupError)
    return (
      <AuthCard title={t('auth.invite.unavailableTitle')} description={lookupError}>
        <Button asChild variant="secondary" size="lg" className="w-full">
          <Link href="/login">{t('shell.gate.goToSignIn')}</Link>
        </Button>
      </AuthCard>
    );
  if (!info)
    return (
      <AuthCard title={t('auth.invite.loading')}>
        <Spinner />
      </AuthCard>
    );

  const title = t('auth.invite.title', { workspace: isolate(info.tenantName) });
  const description = t('auth.invite.description', { role: ROLE_LABEL[info.role] ? t(ROLE_LABEL[info.role]!) : info.role, email: isolate(info.email) });

  if (signedInAs) {
    const mismatch = signedInAs !== info.email;
    return (
      <AuthCard title={title} description={description}>
        <div className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error}</Banner>}
          {mismatch ? (
            <Banner tone="warning">{t('auth.invite.mismatch', { current: isolate(signedInAs), invited: isolate(info.email) })}</Banner>
          ) : (
            <Button variant="primary" size="lg" loading={busy} onClick={() => void accept()} className="w-full">
              {t('auth.invite.accept')}
            </Button>
          )}
        </div>
      </AuthCard>
    );
  }

  if (info.hasAccount)
    return (
      <AuthCard title={title} description={description}>
        <p className="mb-4 text-sm text-fg-2">{t('auth.invite.hasAccount')}</p>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>{t('auth.invite.signInToAccept')}</Link>
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard title={title} description={description}>
      <form onSubmit={accept} noValidate className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('common.email')}>
          <Input value={info.email} readOnly dir="ltr" />
        </Field>
        <Field label={t('auth.field.yourName')}>
          <Input autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} autoFocus />
        </Field>
        <Field label={t('auth.invite.choosePassword')} description={t('auth.invite.passwordHelp')} error={pwError} required>
          <PasswordInput autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
          {t('auth.invite.acceptCreate')}
        </Button>
      </form>
    </AuthCard>
  );
}
