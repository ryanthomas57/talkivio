'use client';
/**
 * Recent re-authentication (ch. 07): sensitive endpoints answer
 * `RECENT_AUTH_REQUIRED` when the session has not confirmed the password in the
 * last 15 minutes. `useReauth().withReauth(fn)` runs `fn`; on that error it asks
 * for the password (+ TOTP code when MFA is on), calls `/auth/reauthenticate` and
 * retries `fn` once. Cancelling rejects with a `REAUTH_CANCELLED` ApiError so
 * callers can show "nothing was changed" instead of a generic failure.
 */
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, Dialog, DialogContent, Field, Input, PasswordInput } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { useSession } from '@/stores/session';

export const REAUTH_CANCELLED = 'REAUTH_CANCELLED';

export function isReauthCancelled(e: unknown): boolean {
  return isApiError(e, REAUTH_CANCELLED);
}

interface Pending {
  resolve: () => void;
  reject: (e: unknown) => void;
  action?: string;
}

export function useReauth(): {
  withReauth: <T>(fn: () => Promise<T>, action?: string) => Promise<T>;
  reauthDialog: ReactNode;
} {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const withReauth = useCallback(async <T,>(fn: () => Promise<T>, action?: string): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!isApiError(e, 'RECENT_AUTH_REQUIRED')) throw e;
      await new Promise<void>((resolve, reject) => setPending({ resolve, reject, action }));
      return fn();
    }
  }, []);

  const finish = (ok: boolean) => {
    const p = pendingRef.current;
    setPending(null);
    if (!p) return;
    if (ok) p.resolve();
    else
      p.reject(
        new ApiError({
          status: 0,
          code: REAUTH_CANCELLED,
          message: t('team.reauth.cancelled'),
        }),
      );
  };

  return {
    withReauth,
    reauthDialog: (
      <ReauthDialog
        open={!!pending}
        action={pending?.action}
        onDone={() => finish(true)}
        onCancel={() => finish(false)}
      />
    ),
  };
}

function ReauthDialog({
  open,
  action,
  onDone,
  onCancel,
}: {
  open: boolean;
  action?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const me = useSession((s) => s.me);
  const mfa = !!me?.user.mfaEnabled;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; code?: string }>({});

  const reset = () => {
    setPassword('');
    setCode('');
    setError(null);
    setFieldErrors({});
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const fe: typeof fieldErrors = {};
    if (!password) fe.password = t('team.reauth.errPassword');
    if (mfa && !code.trim())
      fe.code = t('team.reauth.errCode');
    setFieldErrors(fe);
    if (fe.password || fe.code) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reauthenticate', { password, totpCode: mfa ? code.trim() : undefined });
      reset();
      onDone();
    } catch (err) {
      if (isApiError(err, 'INVALID_CREDENTIALS')) setFieldErrors({ password: t('team.reauth.wrongPassword') });
      else if (isApiError(err, 'MFA_REQUIRED'))
        setFieldErrors({ code: t('team.reauth.wrongCode') });
      else if (isApiError(err, 'RATE_LIMITED'))
        setError(t('team.reauth.rateLimited'));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) {
          reset();
          onCancel();
        }
      }}
    >
      <DialogContent
        size="sm"
        title={t('team.reauth.title')}
        description={
          action
            ? t(mfa ? 'team.reauth.descActionMfa' : 'team.reauth.descAction', { action: isolate(action) })
            : t(mfa ? 'team.reauth.descMfa' : 'team.reauth.desc')
        }
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                reset();
                onCancel();
              }}
            >
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
          <p className="sr-only" aria-live="polite">
            {t('team.reauth.signedInAs', { email: isolate(me?.user.email) })}
          </p>
          <Field label={t('team.reauth.password')} error={fieldErrors.password} required>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              maxLength={128}
            />
          </Field>
          {mfa && (
            <Field
              label={t('team.reauth.code')}
              description={t('team.reauth.codeHint')}
              error={fieldErrors.code}
              required
            >
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="text"
                maxLength={20}
                className="font-mono"
                dir="ltr"
              />
            </Field>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
