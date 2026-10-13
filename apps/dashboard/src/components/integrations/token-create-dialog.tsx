'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { Banner, Button, Checkbox, Dialog, DialogContent, Field, Input, PanelError, Select, Skeleton } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useSession } from '@/stores/session';
import { isRecentAuthCancelled } from './recent-auth';
import { richT } from './rich';
import { DAY_MS, DEFAULT_TTL_DAYS, groupScopes, MAX_TTL_DAYS, useTokenScopes } from './scopes';
import type { IntegrationTokenWithSecret } from './types';

type Guard = <T>(fn: () => Promise<T>, action: string) => Promise<T>;
const PRESETS = [30, 60, 90, 180, 365] as const;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Expiry instant for a preset or a picked calendar day (same time of day as now, capped at the maximum lifetime). */
function expiryFor(choice: string, customDay: string): Date | null {
  const now = Date.now();
  if (choice !== 'custom') return new Date(now + Number(choice) * DAY_MS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(customDay)) return null;
  const [y, m, d] = customDay.split('-').map(Number) as [number, number, number];
  const at = new Date();
  at.setFullYear(y, m - 1, d);
  return new Date(Math.min(at.getTime(), now + MAX_TTL_DAYS * DAY_MS - 60_000));
}

export function TokenCreateDialog({ open, onOpenChange, guard, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; guard: Guard; onCreated: (t: IntegrationTokenWithSecret) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <CreateForm onClose={() => onOpenChange(false)} guard={guard} onCreated={onCreated} />}
    </Dialog>
  );
}

function CreateForm({ onClose, guard, onCreated }: { onClose: () => void; guard: Guard; onCreated: (t: IntegrationTokenWithSecret) => void }) {
  const t = useT();
  const perms = useSession((s) => s.permissions);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [ttl, setTtl] = useState<string>(String(DEFAULT_TTL_DAYS));
  const [customDay, setCustomDay] = useState('');
  const [idemKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ name?: string; scopes?: string; expiry?: string }>({});

  const bounds = useMemo(() => ({ min: ymd(new Date(Date.now() + DAY_MS)), max: ymd(new Date(Date.now() + MAX_TTL_DAYS * DAY_MS - 60_000)) }), []);
  const expiry = expiryFor(ttl, customDay);
  const catalogue = useTokenScopes();
  const groups = useMemo(() => groupScopes(catalogue.data ?? [], t), [catalogue.data, t]);
  const unavailable = (catalogue.data ?? []).filter((s) => !s.grantable).length;

  const toggle = (key: string, on: boolean) => setScopes((cur) => (on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    if (!name.trim()) fe.name = t('integrations.tokenCreate.nameRequired');
    else if (name.trim().length > 80) fe.name = t('integrations.form.maxChars', { max: 80 });
    if (!scopes.length) fe.scopes = catalogue.data ? t('integrations.tokenCreate.scopesRequired') : t('integrations.tokenCreate.scopesNotLoaded');
    if (!expiry) fe.expiry = t('integrations.tokenCreate.expiryRequired');
    else if (expiry.getTime() < Date.now() + 3_600_000) fe.expiry = t('integrations.tokenCreate.expiryTooSoon');
    setFieldErr(fe);
    if (fe.name || fe.scopes || fe.expiry) return;
    setBusy(true);
    setError(null);
    try {
      const res = await guard(
        () => api.post<IntegrationTokenWithSecret>('/integration-tokens', { name: name.trim(), scopes, expiresAt: expiry!.toISOString() }, { idempotencyKey: idemKey }),
        t('integrations.reauth.action.createToken'),
      );
      onCreated(res);
      onClose();
    } catch (err) {
      if (isRecentAuthCancelled(err)) setError(err.message);
      else if (isApiError(err)) {
        setFieldErr({ name: err.field('name'), scopes: err.field('scopes'), expiry: err.field('expires_at') });
        setError(err.message);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent
      size="lg"
      title={t('integrations.tokenCreate.title')}
      description={t('integrations.tokenCreate.description', { brand: BRAND_NAME })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="token-create-form" loading={busy} disabled={!catalogue.data}>
            {t('integrations.tokens.create')}
          </Button>
        </>
      }
    >
      <form id="token-create-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('common.name')} required description={t('integrations.tokenCreate.nameHelp')} error={fieldErr.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus autoComplete="off" dir="auto" />
        </Field>

        <fieldset className="flex flex-col gap-3" aria-describedby={fieldErr.scopes ? 'token-scopes-err' : 'token-scopes-desc'}>
          <legend className="text-sm font-medium text-fg">
            {t('integrations.tokenCreate.scopes')}
            <span className="ms-0.5 text-danger" aria-hidden>
              *
            </span>
          </legend>
          <p id="token-scopes-desc" className="text-xs text-fg-2">
            {unavailable > 0 ? t('integrations.tokenCreate.scopesHelpUnavailable') : t('integrations.tokenCreate.scopesHelp')}
          </p>
          {catalogue.isPending ? (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy>
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : catalogue.isError ? (
            <PanelError message={t('integrations.tokenCreate.scopesLoadError', { error: errorMessage(catalogue.error) })} onRetry={() => void catalogue.refetch()} className="p-0" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {groups.map((g) => (
                <div key={g.id} className="flex min-w-0 flex-col rounded-[var(--radius-control)] border border-line-subtle px-3 py-2">
                  <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-fg-2">{g.label}</p>
                  {g.scopes.map((s) => {
                    const id = `scope-${s.scope.replace(/[^a-z0-9]/gi, '-')}`;
                    // The API decides grantability; the session only names what is missing.
                    const missing = s.grantable ? [] : s.permissions.filter((p) => !perms.has(p));
                    return (
                      <div key={s.scope} className="flex min-h-11 items-start gap-3 py-2">
                        <Checkbox id={id} checked={scopes.includes(s.scope)} disabled={!s.grantable} onCheckedChange={(v) => toggle(s.scope, v === true)} aria-describedby={`${id}-d`} className="mt-0.5" />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <label htmlFor={id} className={s.grantable ? 'text-sm font-medium text-fg' : 'text-sm font-medium text-fg-2'}>
                            {s.label}{' '}
                            <code className="font-mono text-xs font-normal text-fg-2" dir="ltr">
                              {s.scope}
                            </code>
                          </label>
                          <p id={`${id}-d`} className="text-xs text-fg-2">
                            {s.description}
                            {!s.grantable && (
                              <span className="mt-0.5 block font-medium text-fg-2">
                                {missing.length > 0
                                  ? richT(
                                      t,
                                      'integrations.tokenCreate.unavailableList',
                                      {
                                        permissions: (
                                          <code className="break-all font-mono" dir="ltr">
                                            {missing.join(', ')}
                                          </code>
                                        ),
                                      },
                                      { count: missing.length },
                                    )
                                  : t('integrations.tokenCreate.unavailable')}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {fieldErr.scopes && (
            <p id="token-scopes-err" role="alert" className="text-xs font-medium text-danger">
              {fieldErr.scopes}
            </p>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('integrations.tokenCreate.expires')}
            description={expiry ? t('integrations.tokenCreate.expiresOn', { date: formatDateTime(expiry), max: MAX_TTL_DAYS }) : t('integrations.tokenCreate.expiresMax', { max: MAX_TTL_DAYS })}
            error={ttl === 'custom' ? undefined : fieldErr.expiry}
          >
            <Select value={ttl} onChange={(e) => setTtl(e.target.value)}>
              {PRESETS.map((d) => (
                <option key={d} value={String(d)}>
                  {t(d === DEFAULT_TTL_DAYS ? 'integrations.tokenCreate.presetDaysRecommended' : 'integrations.tokenCreate.presetDays', { count: d })}
                </option>
              ))}
              <option value="custom">{t('integrations.tokenCreate.customDate')}</option>
            </Select>
          </Field>
          {ttl === 'custom' && (
            <Field label={t('integrations.tokenCreate.expiryDate')} required error={fieldErr.expiry}>
              <Input type="date" value={customDay} min={bounds.min} max={bounds.max} onChange={(e) => setCustomDay(e.target.value)} />
            </Field>
          )}
        </div>
      </form>
    </DialogContent>
  );
}
