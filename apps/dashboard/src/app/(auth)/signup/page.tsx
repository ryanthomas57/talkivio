'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Banner, browserTimezone, Button, Field, Input, PasswordInput, TimezonePicker } from '@/components/ui';
import { api, errorMessage, isApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { useSession } from '@/stores/session';
import { useT } from '@/i18n';

interface SignupResult {
  userId: string;
  tenantId: string;
  verificationRequired: boolean;
  me: Me;
}

export default function SignupPage() {
  const t = useT();
  const router = useRouter();
  const setMe = useSession((s) => s.setMe);
  const [form, setForm] = useState({ tenantName: '', displayName: '', email: '', password: '', timezone: 'UTC' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string | undefined>>({});

  useEffect(() => setForm((f) => ({ ...f, timezone: browserTimezone() })), []);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const errs: Record<string, string> = {};
    if (!form.tenantName.trim()) errs.tenantName = t('auth.validation.workspaceRequired');
    if (!form.email.trim()) errs.email = t('auth.validation.workEmailRequired');
    if (form.password.length < 12) errs.password = t('auth.validation.passwordMin');
    if (form.password.length > 128) errs.password = t('auth.validation.passwordMax');
    setFe(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api.post<SignupResult>('/auth/signup', { ...form, displayName: form.displayName.trim() || undefined }, { quietAuth: true });
      await setMe(r.me);
      router.replace('/onboarding');
    } catch (err) {
      if (isApiError(err) && Object.keys(err.fieldErrors).length) {
        setFe({ tenantName: err.field('tenant_name'), email: err.field('email'), password: err.field('password'), displayName: err.field('display_name'), timezone: err.field('timezone') });
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('auth.signup.title')}
      description={t('auth.signup.description')}
      footer={
        <>
          {t('auth.signup.haveAccount')}{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t('auth.login.submit')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('auth.field.workspaceName')} description={t('auth.field.workspaceNameHelp')} error={fe.tenantName} required>
          <Input autoComplete="organization" value={form.tenantName} onChange={(e) => set('tenantName')(e.target.value)} maxLength={120} autoFocus />
        </Field>
        <Field label={t('auth.field.yourName')} error={fe.displayName}>
          <Input autoComplete="name" value={form.displayName} onChange={(e) => set('displayName')(e.target.value)} maxLength={120} />
        </Field>
        <Field label={t('auth.field.workEmail')} error={fe.email} required>
          <Input type="email" autoComplete="email" inputMode="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
        <Field label={t('auth.field.password')} description={t('auth.field.passwordHelp')} error={fe.password} required>
          <PasswordInput autoComplete="new-password" value={form.password} onChange={(e) => set('password')(e.target.value)} />
        </Field>
        <Field label={t('auth.field.timezone')} description={t('auth.field.timezoneHelp')} error={fe.timezone}>
          <TimezonePicker value={form.timezone} onChange={set('timezone')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
          {t('auth.signup.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
