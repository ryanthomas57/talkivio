'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Banner, Button, Field, PasswordInput } from '@/components/ui';
import { api, errorMessage, isApiError } from '@/lib/api';
import { useT } from '@/i18n';

function ResetForm() {
  const t = useT();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<{ password?: string; confirm?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const errs: typeof fe = {};
    if (password.length < 12) errs.password = t('auth.validation.passwordMin');
    else if (password.length > 128) errs.password = t('auth.validation.passwordMax');
    if (confirm !== password) errs.confirm = t('auth.validation.passwordMismatch');
    setFe(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/auth/password/reset', { token, newPassword: password }, { quietAuth: true });
      setDone(true);
    } catch (err) {
      if (isApiError(err) && err.field('new_password')) setFe({ password: err.field('new_password') });
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token)
    return (
      <AuthCard title={t('auth.reset.incompleteTitle')} description={t('auth.reset.incompleteBody')}>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/forgot-password">{t('auth.reset.requestNew')}</Link>
        </Button>
      </AuthCard>
    );

  if (done)
    return (
      <AuthCard title={t('auth.reset.doneTitle')} description={t('auth.reset.doneBody')}>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/login">{t('auth.login.submit')}</Link>
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard title={t('auth.reset.title')} description={t('auth.reset.description')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && (
          <Banner
            tone="danger"
            action={
              <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">
                {t('auth.reset.newLink')}
              </Link>
            }
          >
            {error}
          </Banner>
        )}
        <Field label={t('auth.reset.newPassword')} error={fe.password} required>
          <PasswordInput autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        <Field label={t('auth.reset.confirmPassword')} error={fe.confirm} required>
          <PasswordInput autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
          {t('auth.reset.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
