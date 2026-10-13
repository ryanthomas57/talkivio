'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Banner, Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/i18n';

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setFieldError(t('auth.validation.emailRequired'));
    setFieldError(null);
    setBusy(true);
    try {
      await api.post('/auth/password/reset-request', { email }, { quietAuth: true });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <AuthCard title={t('auth.forgot.sentTitle')} description={t('auth.forgot.sentBody')}>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/login">{t('auth.backToSignIn')}</Link>
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard
      title={t('auth.forgot.title')}
      description={t('auth.forgot.description')}
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t('auth.backToSignIn')}
        </Link>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('common.email')} error={fieldError} required>
          <Input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
          {t('auth.forgot.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
