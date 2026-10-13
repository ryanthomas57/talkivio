'use client';
/**
 * Recent authentication for credential and privacy actions (ch. 07/55). Endpoints
 * guarded by @RecentAuth answer 403 RECENT_AUTH_REQUIRED when the password was not
 * confirmed in the last few minutes. `guard(fn, action)` runs the request; on that
 * error it asks for the password (plus an authenticator code when two-factor is on),
 * calls POST /auth/reauthenticate and retries the request once. Cancelling rejects
 * with `RecentAuthCancelled` so callers can say "nothing was changed".
 *
 * Kept in this area (not shared foundation) because the copy names the specific
 * action being confirmed. `action` is a translated phrase that fills the slot in
 * 'integrations.reauth.description' ("To {action}, confirm…"): an English verb phrase
 * ("rotate the token “X”"), an Arabic verbal noun phrase ("تدوير الرمز «X»").
 */
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, Dialog, DialogContent, Field, Input, PasswordInput } from '@/components/ui';
import { isolate, tStatic, useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { useSession } from '@/stores/session';

/** An ApiError subclass so `errorMessage()` (and ConfirmDialog) show the plain-language reason. */
export class RecentAuthCancelled extends ApiError {
  constructor() {
    super({ status: 0, code: 'RECENT_AUTH_CANCELLED', message: tStatic('integrations.reauth.cancelled') });
    this.name = 'RecentAuthCancelled';
  }
}

export const isRecentAuthCancelled = (e: unknown): e is RecentAuthCancelled => e instanceof RecentAuthCancelled;

interface Pending {
  action: string;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export function useRecentAuth(): { guard: <T>(fn: () => Promise<T>, action: string) => Promise<T>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const guard = useCallback(async <T,>(fn: () => Promise<T>, action: string): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!isApiError(e, 'RECENT_AUTH_REQUIRED')) throw e;
      await new Promise<void>((resolve, reject) => setPending({ action, resolve, reject }));
      return fn();
    }
  }, []);

  const finish = (ok: boolean) => {
    const p = pendingRef.current;
    setPending(null);
    if (!p) return;
    if (ok) p.resolve();
    else p.reject(new RecentAuthCancelled());
  };

  const dialog = (
    <Dialog open={!!pending} onOpenChange={(o) => !o && finish(false)}>
      {pending && <ConfirmPasswordForm action={pending.action} onConfirmed={() => finish(true)} onCancel={() => finish(false)} />}
    </Dialog>
  );

  return { guard, dialog };
}

function ConfirmPasswordForm({ action, onConfirmed, onCancel }: { action: string; onConfirmed: () => void; onCancel: () => void }) {
  const t = useT();
  const mfa = useSession((s) => !!s.me?.user.mfaEnabled);
  const email = useSession((s) => s.me?.user.email);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ password?: string; code?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    if (!password) fe.password = t('integrations.reauth.enterPassword');
    if (mfa && !code.trim()) fe.code = t('integrations.reauth.enterCode');
    setFieldErr(fe);
    if (fe.password || fe.code) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reauthenticate', { password, ...(mfa ? { totpCode: code.replace(/\s/g, '') } : {}) });
      onConfirmed();
    } catch (err) {
      if (isApiError(err, 'INVALID_CREDENTIALS')) setFieldErr({ password: t('integrations.reauth.wrongPassword') });
      else if (isApiError(err, 'MFA_REQUIRED')) setFieldErr({ code: t('integrations.reauth.wrongCode') });
      else if (isApiError(err, 'RATE_LIMITED')) setError(t('integrations.reauth.rateLimited'));
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      size="sm"
      title={t('integrations.reauth.title')}
      description={t('integrations.reauth.description', { action, mfa: mfa ? 'yes' : 'no' })}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="recent-auth-form" loading={busy}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <form id="recent-auth-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        {email && <p className="text-sm text-fg-2">{t('integrations.reauth.signedInAs', { email: isolate(email) })}</p>}
        <Field label={t('integrations.reauth.password')} required error={fieldErr.password}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus maxLength={128} />
        </Field>
        {mfa && (
          <Field label={t('integrations.reauth.code')} required description={t('integrations.reauth.codeHint')} error={fieldErr.code}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={20} dir="ltr" className="font-mono tracking-widest" />
          </Field>
        )}
      </form>
    </DialogContent>
  );
}
