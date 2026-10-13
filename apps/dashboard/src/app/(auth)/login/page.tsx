'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { BRAND_NAME } from '@/components/brand';
import { Banner, Button, CheckboxField, Field, Input, PasswordInput } from '@/components/ui';
import { api, errorMessage, isApiError } from '@/lib/api';
import { homeFor } from '@/lib/navigation';
import type { Me } from '@/lib/types';
import { useSession } from '@/stores/session';
import { useT } from '@/i18n';

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const setMe = useSession((s) => s.setMe);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    const fe: Record<string, string> = {};
    if (!email.trim()) fe.email = t('auth.validation.emailRequired');
    if (!password) fe.password = t('auth.validation.passwordRequired');
    if (mfa && !code.trim()) fe.code = t('auth.login.codeRequired');
    if (Object.keys(fe).length) return setFieldErrors(fe);
    setBusy(true);
    try {
      const me = await api.post<Me>('/auth/login', { email, password, ...(mfa ? { totpCode: code.trim(), rememberDevice: remember, ...(challenge ? { challenge } : {}) } : {}) }, { quietAuth: true });
      await setMe(me);
      router.replace(homeFor(me, params.get('next')));
    } catch (err) {
      // Each MFA_REQUIRED may carry a fresh single-use challenge for the next attempt.
      if (isApiError(err, 'MFA_REQUIRED') && typeof err.details.challenge === 'string') setChallenge(err.details.challenge);
      if (isApiError(err, 'MFA_REQUIRED') && !mfa) {
        setMfa(true);
      } else if (isApiError(err) && Object.keys(err.fieldErrors).length) {
        setFieldErrors({ email: err.field('email'), password: err.field('password'), code: err.field('totp_code') });
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const reason = params.get('reason');
  return (
    <AuthCard
      title={mfa ? t('auth.login.mfaTitle') : t('auth.login.title')}
      description={mfa ? t('auth.login.mfaDescription') : t('auth.login.description')}
      footer={
        !mfa && (
          <>
            {t('auth.login.newTo', { brand: BRAND_NAME })}{' '}
            <Link href="/signup" className="font-medium text-primary hover:underline">
              {t('auth.login.createWorkspace')}
            </Link>
          </>
        )
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {reason === 'expired' && !error && <Banner tone="info">{t('auth.login.sessionEnded')}</Banner>}
        {reason === 'revoked' && !error && <Banner tone="warning">{t('auth.login.accessChanged')}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
        {!mfa ? (
          <>
            <Field label={t('common.email')} error={fieldErrors.email} required>
              <Input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <Field
              label={t('auth.field.password')}
              error={fieldErrors.password}
              required
              action={
                <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
                  {t('auth.login.forgot')}
                </Link>
              }
            >
              <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label={t('auth.login.codeLabel')} error={fieldErrors.code} required>
              <Input autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus maxLength={20} />
            </Field>
            <CheckboxField label={t('auth.login.trustDevice')} checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
          </>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
          {mfa ? t('auth.login.verifySubmit') : t('auth.login.submit')}
        </Button>
        {mfa && (
          <Button
            variant="ghost"
            onClick={() => {
              setMfa(false);
              setCode('');
              setError(null);
            }}
          >
            {t('auth.login.differentAccount')}
          </Button>
        )}
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
