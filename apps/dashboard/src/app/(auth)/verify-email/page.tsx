'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/i18n';

function Verify() {
  const t = useT();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api
      .post('/auth/verify-email', { token }, { quietAuth: true })
      .then(() => setState('done'))
      .catch((e) => {
        setError(errorMessage(e));
        setState('failed');
      });
  }, [token]);

  if (state === 'working')
    return (
      <AuthCard title={t('auth.verify.workingTitle')}>
        <div className="flex items-center gap-3 text-sm text-fg-2">
          <Spinner /> {t('auth.verify.checking')}
        </div>
      </AuthCard>
    );
  if (state === 'done')
    return (
      <AuthCard title={t('auth.verify.doneTitle')} description={t('auth.verify.doneBody')}>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/inbox">{t('auth.verify.continue')}</Link>
        </Button>
      </AuthCard>
    );
  return (
    <AuthCard title={t('auth.verify.failedTitle')} description={error ?? t('auth.verify.missingToken')}>
      <p className="mb-4 text-sm text-fg-2">{t('auth.verify.failedHelp', { action: t('shell.verify.resend') })}</p>
      <Button asChild variant="primary" size="lg" className="w-full">
        <Link href="/login">{t('auth.login.submit')}</Link>
      </Button>
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
