'use client';
/**
 * Recent re-authentication (ch. 07). Credential changes are guarded server-side by
 * @RecentAuth: a stale session gets 403 RECENT_AUTH_REQUIRED. `guard(fn)` runs the
 * request; on that error it asks for the password (and an authenticator code when
 * two-factor is on), calls POST /auth/reauthenticate, then retries the request once.
 */
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, Dialog, DialogContent, Field, Input, PasswordInput } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { useSession } from '@/stores/session';

export class ReauthCancelled extends Error {
  constructor() {
    super('Confirmation cancelled');
    this.name = 'ReauthCancelled';
  }
}

export const isReauthCancelled = (e: unknown): e is ReauthCancelled => e instanceof ReauthCancelled;

interface Pending {
  retry: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function useReauth(): { guard: <T>(fn: () => Promise<T>) => Promise<T>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!isApiError(e, 'RECENT_AUTH_REQUIRED')) throw e;
      return new Promise<T>((resolve, reject) => {
        setPending({ retry: fn, resolve: resolve as (v: unknown) => void, reject });
      });
    }
  }, []);

  const cancel = () => {
    pendingRef.current?.reject(new ReauthCancelled());
    setPending(null);
  };

  const dialog = (
    <Dialog open={!!pending} onOpenChange={(o) => !o && cancel()}>
      {pending && (
        <ReauthForm
          onCancel={cancel}
          onConfirmed={async () => {
            const p = pendingRef.current;
            setPending(null);
            if (!p) return;
            try {
              p.resolve(await p.retry());
            } catch (e) {
              p.reject(e);
            }
          }}
        />
      )}
    </Dialog>
  );

  return { guard, dialog };
}

function ReauthForm({ onCancel, onConfirmed }: { onCancel: () => void; onConfirmed: () => Promise<void> }) {
  const t = useT();
  const mfa = useSession((s) => !!s.me?.user.mfaEnabled);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ password?: string; code?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    if (!password) fe.password = t('settings.reauth.enterPassword');
    if (mfa && !code.trim()) fe.code = t('settings.reauth.enterCode');
    setFieldErr(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reauthenticate', { password, ...(mfa ? { totpCode: code.replace(/\s/g, '') } : {}) });
      await onConfirmed();
    } catch (err) {
      if (isApiError(err, 'INVALID_CREDENTIALS')) setFieldErr({ password: t('settings.reauth.wrongPassword') });
      else if (isApiError(err, 'MFA_REQUIRED')) setFieldErr({ code: t('settings.reauth.wrongCode') });
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      size="sm"
      title={t('settings.reauth.title')}
      description={t('settings.reauth.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="reauth-form" loading={busy}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <form id="reauth-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('settings.reauth.password')} required error={fieldErr.password}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
        {mfa && (
          <Field label={t('settings.reauth.code')} required description={t('settings.reauth.codeHint')} error={fieldErr.code}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={20} className="font-mono tracking-widest" />
          </Field>
        )}
      </form>
    </DialogContent>
  );
}
