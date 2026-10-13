'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, KeyRound, LogOut, Monitor, ShieldCheck, ShieldOff } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, Input, PanelError, PasswordInput, Skeleton } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { Me } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isReauthCancelled } from '../reauth';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

async function refreshMe(): Promise<void> {
  const me = await api.get<Me>('/auth/me');
  useSession.setState({ me });
}

// ───────────────────────── Password ─────────────────────────

export function PasswordCard({ guard }: { guard: Guard }) {
  const t = useT();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof errors = {};
    if (!current) fe.current = t('settings.password.currentRequired');
    if (next.length < 12) fe.next = t('settings.password.tooShort', { min: 12 });
    else if (next.length > 128) fe.next = t('settings.profile.maxChars', { max: 128 });
    else if (next === current) fe.next = t('settings.password.sameAsCurrent');
    if (!fe.next && confirm !== next) fe.confirm = t('settings.password.mismatch');
    setErrors(fe);
    setDone(false);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setMessage(null);
    try {
      await guard(() => api.post('/auth/password/change', { currentPassword: current, newPassword: next }));
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      toast.success(t('settings.password.changedToast'));
      void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    } catch (err) {
      if (isReauthCancelled(err)) return;
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors({ current: err.field('current_password'), next: err.field('new_password') });
      else setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t('settings.password.title')} description={t('settings.password.description')} />
      <form onSubmit={submit} noValidate>
        <CardBody className="flex flex-col gap-5">
          {message && <Banner tone="danger">{message}</Banner>}
          {done && <Banner tone="success">{t('settings.password.changed')}</Banner>}
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label={t('settings.password.current')} required error={errors.current}>
              <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label={t('settings.password.new')} required description={t('settings.password.newHint', { min: 12, max: 128 })} error={errors.next}>
              <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" maxLength={128} />
            </Field>
            <Field label={t('settings.password.confirm')} required error={errors.confirm}>
              <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} />
            </Field>
          </div>
        </CardBody>
        <div className="flex justify-end border-t border-line-subtle px-4 py-3 sm:px-6">
          <Button type="submit" variant="primary" loading={busy} disabled={!current && !next && !confirm}>
            {t('settings.password.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ───────────────────────── Two-factor authentication ─────────────────────────

interface Enrollment {
  enrollmentId: string;
  secret: string;
  otpauthUrl: string;
}

const CODE_RE = /^\d{6}$/;
const cleanCode = (s: string) => s.replace(/\s/g, '');

export function MfaCard({ guard }: { guard: Guard }) {
  const t = useT();
  const enabled = useSession((s) => !!s.me?.user.mfaEnabled);
  const required = useSession((s) => !!s.tenant?.settings.security.requireMfa);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'disable' | 'regenerate' | null>(null);

  const start = async () => {
    setStarting(true);
    setMessage(null);
    try {
      setEnrollment(await guard(() => api.post<Enrollment>('/auth/mfa/enroll')));
    } catch (e) {
      if (!isReauthCancelled(e)) setMessage(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('settings.mfa.title')}
        description={t('settings.mfa.description')}
        action={enabled ? <Badge tone="success" icon={<ShieldCheck className="size-3.5" aria-hidden />}>{t('common.on')}</Badge> : <Badge tone="neutral" icon={<ShieldOff className="size-3.5" aria-hidden />}>{t('common.off')}</Badge>}
      />
      <CardBody className="flex flex-col gap-4">
        {message && <Banner tone="danger">{message}</Banner>}
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : enrollment ? (
          <EnrollmentSteps
            enrollment={enrollment}
            guard={guard}
            onCancel={() => setEnrollment(null)}
            onRestart={() => {
              setEnrollment(null);
              void start();
            }}
            onConfirmed={async (recovery) => {
              setEnrollment(null);
              setCodes(recovery);
              await refreshMe().catch(() => undefined);
              toast.success(t('settings.mfa.onToast'));
            }}
          />
        ) : enabled ? (
          <>
            <p className="text-sm text-fg-2">{t('settings.mfa.enabledHint')}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDialog('regenerate')}>
                <KeyRound className="size-4" aria-hidden />
                {t('settings.mfa.newCodes')}
              </Button>
              <Button variant="danger-ghost" onClick={() => setDialog('disable')}>
                {t('settings.mfa.turnOff')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {required && <Banner tone="warning">{t('settings.mfa.required')}</Banner>}
            <p className="text-sm text-fg-2">{t('settings.mfa.needApp')}</p>
            <div>
              <Button variant="primary" onClick={() => void start()} loading={starting}>
                {t('settings.mfa.setup')}
              </Button>
            </div>
          </>
        )}
      </CardBody>
      <CodeDialog
        open={dialog === 'disable'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('settings.mfa.disableTitle')}
        description={required ? t('settings.mfa.disableRequired') : t('settings.mfa.disableBody')}
        confirmLabel={t('settings.mfa.turnOff')}
        danger
        guard={guard}
        run={async (code) => {
          await api.post('/auth/mfa/disable', { code });
          await refreshMe().catch(() => undefined);
          toast.success(t('settings.mfa.offToast'));
        }}
      />
      <CodeDialog
        open={dialog === 'regenerate'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('settings.mfa.regenTitle')}
        description={t('settings.mfa.regenBody')}
        confirmLabel={t('settings.mfa.regenConfirm')}
        guard={guard}
        run={async (code) => {
          const r = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { code });
          setCodes(r.recoveryCodes);
        }}
      />
    </Card>
  );
}

function EnrollmentSteps({ enrollment, guard, onCancel, onRestart, onConfirmed }: { enrollment: Enrollment; guard: Guard; onCancel: () => void; onRestart: () => void; onConfirmed: (codes: string[]) => Promise<void> }) {
  const t = useT();
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 192, errorCorrectionLevel: 'M' })
      .then((url) => live && setQr(url))
      .catch(() => live && setQrFailed(true));
    return () => {
      live = false;
    };
  }, [enrollment.otpauthUrl]);

  const grouped = enrollment.secret.replace(/(.{4})/g, '$1 ').trim();

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('settings.mfa.copyKeyUnavailable'));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = cleanCode(code);
    if (!CODE_RE.test(c)) {
      setError(t('settings.mfa.enterSixDigits'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await guard(() => api.post<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { enrollmentId: enrollment.enrollmentId, code: c }));
      await onConfirmed(r.recoveryCodes);
    } catch (err) {
      if (isReauthCancelled(err)) return;
      if (isApiError(err, 'TOKEN_EXPIRED')) setExpired(true);
      else if (err instanceof ApiError && err.field('code')) setError(t('settings.mfa.invalidClock'));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (expired)
    return (
      <Banner
        tone="warning"
        title={t('settings.mfa.expiredTitle')}
        action={
          <Button size="sm" variant="secondary" onClick={onRestart}>
            {t('settings.mfa.startAgain')}
          </Button>
        }
      >
        {t('settings.mfa.expiredBody', { minutes: 15 })}
      </Banner>
    );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <ol className="flex flex-col gap-5">
        <li className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
          <div className="flex size-[200px] shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-line bg-white p-1">
            {qr ? <img src={qr} alt={t('settings.mfa.qrAlt')} width={192} height={192} /> : qrFailed ? <p className="p-3 text-center text-xs text-fg-2">{t('settings.mfa.qrFailed')}</p> : <Skeleton className="size-[192px]" />}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm font-semibold">{t('settings.mfa.step1')}</p>
            <p className="text-sm text-fg-2">{t('settings.mfa.step1Body')}</p>
            <p className="mt-2 text-sm font-semibold">{t('settings.mfa.cantScan')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code dir="ltr" className="break-all rounded-md bg-surface-3 px-2 py-1.5 font-mono text-sm tracking-wider" aria-label={t('settings.mfa.setupKeyLabel', { key: enrollment.secret.split('').join(' ') })}>
                {grouped}
              </code>
              <Button size="sm" variant="secondary" onClick={() => void copySecret()}>
                {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                {copied ? t('common.copied') : t('settings.mfa.copyKey')}
              </Button>
            </div>
            <p className="text-xs text-fg-2">{t('settings.mfa.totpInfo')}</p>
          </div>
        </li>
        <li className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{t('settings.mfa.step2')}</p>
          <Field label={t('settings.reauth.code')} hideLabel error={error} className="max-w-xs">
            <Input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError(null);
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456" // i18n-ignore: digits only
              className="font-mono text-base tracking-[0.3em]"
            />
          </Field>
        </li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={busy}>
          {t('settings.mfa.turnOn')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Recovery codes are shown once, with copy and .txt download. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const email = useSession((s) => s.me?.user.email ?? '');
  const [copied, setCopied] = useState(false);
  const text = `${t('settings.mfa.fileHeading', { email })}\n${t('settings.mfa.fileBody')}\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('settings.mfa.copyCodesUnavailable'));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'talkivio-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="warning" title={t('settings.mfa.saveCodesTitle')}>
        {t('settings.mfa.saveCodesBody')}
      </Banner>
      <ul className="grid grid-cols-2 gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 p-4 sm:grid-cols-5" aria-label={t('settings.mfa.codesLabel')} dir="ltr">
        {codes.map((c) => (
          <li key={c} className="font-mono text-sm tracking-wider">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? t('common.copied') : t('settings.mfa.copyCodes')}
        </Button>
        <Button variant="secondary" onClick={download}>
          <Download className="size-4" aria-hidden />
          {t('settings.mfa.downloadTxt')}
        </Button>
        <Button variant="primary" onClick={onDone}>
          {t('settings.mfa.savedCodes')}
        </Button>
      </div>
    </div>
  );
}

/** Asks for a current authenticator (or recovery) code before a two-factor change. */
function CodeDialog({ open, onOpenChange, title, description, confirmLabel, danger, guard, run }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string; danger?: boolean; guard: Guard; run: (code: string) => Promise<void> }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setCode('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = cleanCode(code);
    if (c.length < 6) {
      setError(t('settings.reauth.enterCode'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await guard(() => run(c));
      onOpenChange(false);
    } catch (err) {
      if (isReauthCancelled(err)) return;
      if (err instanceof ApiError && err.field('code')) setError(t('settings.mfa.invalidCode'));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="mfa-code-form" variant={danger ? 'danger' : 'primary'} loading={busy}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <form id="mfa-code-form" onSubmit={submit} noValidate>
          <Field label={t('settings.reauth.code')} required error={error}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={20} autoFocus className="font-mono tracking-widest" />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Sessions ─────────────────────────

interface SessionRow {
  id: string;
  browser: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  current: boolean;
  /** Not returned by the API today; rendered when present. */
  location?: string | null;
}

export function SessionsCard() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => api.get<SessionRow[]>('/auth/sessions'), staleTime: 15_000 });
  const [revoke, setRevoke] = useState<SessionRow | null>(null);
  const [others, setOthers] = useState(false);
  const rows = q.data ?? [];
  const otherCount = rows.filter((r) => !r.current).length;

  return (
    <Card>
      <CardHeader
        title={t('settings.sessions.title')}
        description={t('settings.sessions.description')}
        action={
          otherCount > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setOthers(true)}>
              <LogOut className="size-3.5" aria-hidden />
              {t('settings.sessions.signOutOthersButton')}
            </Button>
          )
        }
      />
      {q.isPending ? (
        <CardBody className="flex flex-col gap-3">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </CardBody>
      ) : q.isError ? (
        <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('settings.sessions.emptyTitle')} description={t('settings.sessions.emptyBody')} />
      ) : (
        <ul className="divide-y divide-line-subtle">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-2" aria-hidden>
                <Monitor className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {s.browser ? <bdi>{s.browser}</bdi> : t('settings.sessions.unknownBrowser')}
                  {s.current && <Badge tone="primary">{t('settings.sessions.thisDevice')}</Badge>}
                </p>
                <p className="text-xs text-fg-2">
                  {s.location && (
                    <>
                      <bdi>{s.location}</bdi>
                      {' · '}
                    </>
                  )}
                  {s.current ? (
                    t('settings.sessions.activeNow')
                  ) : s.lastActiveAt ? (
                    <time dateTime={s.lastActiveAt} title={formatDateTime(s.lastActiveAt)}>
                      {t('settings.sessions.lastActive', { time: formatRelative(s.lastActiveAt) })}
                    </time>
                  ) : (
                    t('settings.sessions.lastActiveUnknown')
                  )}
                  {' · '}
                  <time dateTime={s.createdAt} title={formatDateTime(s.createdAt)}>
                    {t('settings.sessions.signedIn', { time: formatRelative(s.createdAt) })}
                  </time>
                </p>
              </div>
              {!s.current && (
                <Button size="sm" variant="danger-ghost" onClick={() => setRevoke(s)}>
                  {t('settings.sessions.signOut')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={revoke?.browser ? t('settings.sessions.revokeTitle', { browser: isolate(revoke.browser) }) : t('settings.sessions.revokeThisTitle')}
        description={t('settings.sessions.revokeBody')}
        confirmLabel={t('settings.sessions.revokeConfirm')}
        danger
        onConfirm={async () => {
          if (!revoke) return;
          await api.delete(`/auth/sessions/${revoke.id}`);
          toast.success(t('settings.sessions.revoked'));
          await qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
        }}
      />
      <ConfirmDialog
        open={others}
        onOpenChange={setOthers}
        title={t('settings.sessions.othersTitle')}
        description={t('settings.sessions.othersBody', { count: otherCount })}
        confirmLabel={t('settings.sessions.othersConfirm')}
        danger
        onConfirm={async () => {
          const r = await api.post<{ revoked: number }>('/auth/sessions/revoke-others');
          toast.success(t('settings.sessions.othersDone', { count: r.revoked }));
          await qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
        }}
      />
    </Card>
  );
}
