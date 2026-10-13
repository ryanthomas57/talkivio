'use client';
import { Building2, ChevronRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { BrandLockup } from '@/components/brand';
import { SessionGate } from '@/components/shell/session-gate';
import { Banner, Button, browserTimezone, Field, Input, TimezonePicker } from '@/components/ui';
import { api, errorMessage, isApiError } from '@/lib/api';
import { homeFor } from '@/lib/navigation';
import { realtime } from '@/lib/realtime';
import type { Me } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isolate, useT, type MessageKey } from '@/i18n';

const ROLE_LABEL: Record<string, MessageKey> = { owner: 'auth.role.owner', admin: 'auth.role.admin', supervisor: 'auth.role.supervisor', agent: 'auth.role.agent', analyst: 'auth.role.analyst' };

/** Workspace chooser: pick an enabled membership or create a new workspace. */
function Workspaces() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const me = useSession((s) => s.me);
  const setMe = useSession((s) => s.setMe);
  const logout = useSession((s) => s.logout);
  const [creating, setCreating] = useState(params.get('create') === '1');
  const [name, setName] = useState('');
  const [tz, setTz] = useState('UTC');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();

  useEffect(() => setTz(browserTimezone()), []);
  if (!me) return null;
  const enabled = me.memberships.filter((m) => m.enabled);
  const suspended = me.memberships.filter((m) => !m.enabled);

  const open = async (tenantId: string) => {
    setBusy(tenantId);
    setError(null);
    try {
      realtime.stop();
      const next = await api.post<Me>('/tenants/switch', { tenantId });
      await setMe(next);
      router.replace(homeFor(next));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setNameError(t('auth.validation.workspaceRequired'));
    setNameError(undefined);
    setBusy('create');
    setError(null);
    try {
      realtime.stop();
      const next = await api.post<Me>('/tenants', { tenantName: name.trim(), timezone: tz });
      await setMe(next);
      router.replace('/onboarding');
    } catch (err) {
      if (isApiError(err) && err.field('tenant_name')) setNameError(err.field('tenant_name'));
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center bg-canvas px-4 py-10 sm:py-16">
      <BrandLockup className="mb-8" />
      <div className="w-full max-w-[420px]">
        {creating || enabled.length === 0 ? (
          <AuthCard title={t('auth.login.createWorkspace')} description={enabled.length === 0 ? t('auth.workspaces.noneBody') : t('auth.workspaces.createBody')}>
            <form onSubmit={create} noValidate className="flex flex-col gap-4">
              {error && <Banner tone="danger">{error}</Banner>}
              <Field label={t('auth.field.workspaceName')} error={nameError} required>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
              </Field>
              <Field label={t('auth.field.timezone')}>
                <TimezonePicker value={tz} onChange={setTz} />
              </Field>
              <Button type="submit" variant="primary" size="lg" loading={busy === 'create'} className="w-full">
                {t('auth.signup.submit')}
              </Button>
              {enabled.length > 0 && (
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  {t('auth.workspaces.back')}
                </Button>
              )}
            </form>
          </AuthCard>
        ) : (
          <AuthCard title={t('auth.workspaces.chooseTitle')} description={t('auth.workspaces.signedInAs', { email: isolate(me.user.email) })}>
            <div className="flex flex-col gap-2">
              {error && <Banner tone="danger">{error}</Banner>}
              <ul className="flex flex-col gap-2">
                {enabled.map((m) => (
                  <li key={m.tenantId}>
                    <button
                      type="button"
                      onClick={() => void open(m.tenantId)}
                      disabled={!!busy}
                      className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-control)] border border-line px-3 text-start hover:bg-surface-2 disabled:opacity-60"
                    >
                      <span className="flex size-9 items-center justify-center rounded-md bg-primary-tint text-primary">
                        <Building2 className="size-4" aria-hidden />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium" dir="auto">{m.tenantName}</span>
                        <span className="text-xs text-fg-2">{ROLE_LABEL[m.role] ? t(ROLE_LABEL[m.role]!) : m.role}</span>
                      </span>
                      <ChevronRight className="size-4 text-fg-2 rtl:-scale-x-100" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
              {suspended.length > 0 && <p className="text-xs text-fg-2">{t('auth.workspaces.suspended', { names: suspended.map((m) => isolate(m.tenantName)).join(t('auth.workspaces.listSeparator')) })}</p>}
              <Button variant="secondary" onClick={() => setCreating(true)} className="mt-2">
                {t('auth.workspaces.createAnother')}
              </Button>
            </div>
          </AuthCard>
        )}
        <div className="mt-6 text-center">
          <Button
            variant="link"
            onClick={async () => {
              await logout().catch(() => undefined);
              router.replace('/login');
            }}
          >
            {t('shell.account.signOut')}
          </Button>
        </div>
      </div>
    </main>
  );
}

export default function WorkspacesPage() {
  return (
    <SessionGate requireTenant={false}>
      <Suspense>
        <Workspaces />
      </Suspense>
    </SessionGate>
  );
}
