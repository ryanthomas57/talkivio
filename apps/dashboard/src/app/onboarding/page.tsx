'use client';
import { mergeWidgetConfig, type WidgetConfig } from '@talkivio/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Circle, Copy, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BrandLockup } from '@/components/brand';
import { SessionGate } from '@/components/shell/session-gate';
import { Banner, Button, Card, Field, Input, RadioGroup, Select, Spinner, Textarea, TimezonePicker } from '@/components/ui';
import { WidgetPreview, PREVIEW_STATES, type PreviewState } from '@/components/widget-preview';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { qk, useDepartments } from '@/lib/queries';
import type { Department, Site } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isolate, useT, type MessageKey } from '@/i18n';

const STEPS: ReadonlyArray<{ id: 'workspace' | 'site' | 'department' | 'widget' | 'install'; label: MessageKey }> = [
  { id: 'workspace', label: 'auth.onboarding.step.workspace' },
  { id: 'site', label: 'auth.onboarding.step.site' },
  { id: 'department', label: 'auth.onboarding.step.department' },
  { id: 'widget', label: 'auth.onboarding.step.widget' },
  { id: 'install', label: 'auth.onboarding.step.install' },
];
type StepId = (typeof STEPS)[number]['id'];

interface OriginRow {
  origin: string;
  patternType: 'exact' | 'subdomain';
}

/**
 * Five-step onboarding (ch. 08) with progress, Back, and resumable server-side
 * state: refreshing returns to the saved step with the saved site.
 */
function Onboarding() {
  const t = useT();
  const router = useRouter();
  const tenant = useSession((s) => s.tenant);
  const setTenant = useSession((s) => s.setTenant);
  const canManage = useSession((s) => s.permissions.has('tenant.manage'));
  const saved = (tenant?.onboardingState ?? {}) as { step?: string; siteId?: string };
  const [step, setStep] = useState<StepId>(() => (STEPS.some((s) => s.id === saved.step) ? (saved.step as StepId) : 'workspace'));
  const [siteId, setSiteId] = useState<string | null>(saved.siteId ?? null);
  const index = STEPS.findIndex((s) => s.id === step);

  const persist = useCallback(
    async (next: StepId, data: Record<string, unknown> = {}) => {
      const next_ = await api.patch<typeof tenant>('/tenants/current/onboarding', { step: next, data });
      if (next_) setTenant(next_);
    },
    [setTenant],
  );

  const go = async (next: StepId, data?: Record<string, unknown>) => {
    setStep(next);
    await persist(next, data).catch(() => undefined);
    window.scrollTo({ top: 0 });
  };

  const finish = async () => {
    const done = await api.patch<NonNullable<typeof tenant>>('/tenants/current/onboarding', { step: 'done', completed: true });
    setTenant(done);
    await useSession.getState().load();
    router.replace('/inbox');
  };

  if (!tenant) return null;
  if (!canManage)
    return (
      <Shell>
        <Card className="p-6">
          <h1 className="text-lg font-semibold">{t('auth.onboarding.inProgressTitle')}</h1>
          <p className="mt-2 text-sm text-fg-2">{t('auth.onboarding.inProgressBody')}</p>
          <Button asChild variant="primary" className="mt-4">
            <Link href="/inbox">{t('auth.onboarding.goToInbox')}</Link>
          </Button>
        </Card>
      </Shell>
    );

  return (
    <Shell>
      <nav aria-label={t('auth.onboarding.progress')} className="mb-6">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <span
                aria-current={s.id === step ? 'step' : undefined}
                className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium', i < index ? 'bg-success-tint text-success' : s.id === step ? 'bg-primary text-primary-fg' : 'bg-surface-3 text-fg-2')}
              >
                {i < index ? <Check className="size-3.5" aria-hidden /> : <span className="tabular">{i + 1}</span>}
                {t(s.label)}
                {i < index && <span className="sr-only">{t('auth.onboarding.stepDone')}</span>}
              </span>
              {i < STEPS.length - 1 && <span className="hidden h-px w-4 bg-line sm:block" aria-hidden />}
            </li>
          ))}
        </ol>
      </nav>
      {step === 'workspace' && <WorkspaceStep onNext={() => go('site')} />}
      {step === 'site' && <SiteStep siteId={siteId} onBack={() => go('workspace')} onNext={(id) => { setSiteId(id); void go('department', { siteId: id }); }} />}
      {step === 'department' && <DepartmentStep siteId={siteId} onBack={() => go('site')} onNext={() => go('widget')} />}
      {step === 'widget' && siteId && <WidgetStep siteId={siteId} onBack={() => go('department')} onNext={() => go('install')} />}
      {step === 'install' && siteId && <InstallStep siteId={siteId} onBack={() => go('widget')} onFinish={finish} />}
      {(step === 'widget' || step === 'install') && !siteId && (
        <Banner tone="warning" action={<Button size="sm" onClick={() => go('site')}>{t('auth.onboarding.addWebsite')}</Button>}>
          {t('auth.onboarding.addWebsiteFirst')}
        </Banner>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main id="main" className="min-h-dvh bg-canvas px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-[920px]">
        <div className="mb-8 flex items-center justify-between">
          <BrandLockup />
          <Link href="/inbox" className="text-sm font-medium text-fg-2 hover:text-fg">
            {t('auth.onboarding.skip')}
          </Link>
        </div>
        {children}
      </div>
    </main>
  );
}

function StepCard({ title, description, children, footer }: { title: string; description: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <Card>
      <div className="border-b border-line-subtle px-6 py-5">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-fg-2">{description}</p>
      </div>
      <div className="px-6 py-6">{children}</div>
      <div className="flex items-center justify-between gap-3 border-t border-line-subtle px-6 py-4">{footer}</div>
    </Card>
  );
}

function WorkspaceStep({ onNext }: { onNext: () => void }) {
  const t = useT();
  const tenant = useSession((s) => s.tenant)!;
  const setTenant = useSession((s) => s.setTenant);
  const [name, setName] = useState(tenant.name);
  const [tz, setTz] = useState(tenant.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) return setError(t('auth.validation.workspaceRequired'));
    setBusy(true);
    setError(null);
    try {
      if (name.trim() !== tenant.name || tz !== tenant.timezone) setTenant(await api.patch('/tenants/current', { name: name.trim(), timezone: tz, expectedVersion: tenant.version }));
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepCard
      title={t('auth.onboarding.workspaceTitle')}
      description={t('auth.onboarding.workspaceBody')}
      footer={
        <>
          <span />
          <Button variant="primary" onClick={save} loading={busy}>
            {t('common.continue')}
          </Button>
        </>
      }
    >
      <div className="flex max-w-md flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('auth.field.workspaceName')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label={t('auth.field.timezone')}>
          <TimezonePicker value={tz} onChange={setTz} />
        </Field>
      </div>
    </StepCard>
  );
}

function SiteStep({ siteId, onBack, onNext }: { siteId: string | null; onBack: () => void; onNext: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [loading, setLoading] = useState(!!siteId);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<OriginRow[]>([{ origin: '', patternType: 'exact' }]);
  const [version, setVersion] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!siteId) return;
    api
      .get<Site>(`/sites/${siteId}`)
      .then((s) => {
        setName(s.name);
        setRows(s.origins.length ? s.origins.map((o) => ({ origin: o.origin, patternType: o.patternType })) : [{ origin: '', patternType: 'exact' }]);
        setVersion(s.version);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [siteId]);

  const save = async () => {
    setError(null);
    setFieldErrors({});
    if (!name.trim()) return setFieldErrors({ name: t('auth.onboarding.siteNameRequired') });
    const origins = rows.filter((r) => r.origin.trim()).map((r) => ({ origin: r.origin.trim(), patternType: r.patternType }));
    if (!origins.length) return setFieldErrors({ 'origins.0.origin': t('auth.onboarding.originRequired', { example: 'https://www.example.com' }) });
    setBusy(true);
    try {
      const site = siteId ? await api.patch<Site>(`/sites/${siteId}`, { name: name.trim(), origins, expectedVersion: version }) : await api.post<Site>('/sites', { name: name.trim(), origins });
      void qc.invalidateQueries({ queryKey: qk.sites });
      onNext(site.id);
    } catch (e) {
      if (isApiError(e) && Object.keys(e.fieldErrors).length) {
        setFieldErrors(Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [k, v[0] ?? t('auth.onboarding.invalid')])));
        setError(e.message);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner />;
  return (
    <StepCard
      title={t('auth.onboarding.siteTitle')}
      description={t('auth.onboarding.siteBody')}
      footer={
        <>
          <Button variant="secondary" onClick={onBack}>
            {t('common.back')}
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {t('auth.onboarding.saveContinue')}
          </Button>
        </>
      }
    >
      <div className="flex max-w-xl flex-col gap-5">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('auth.onboarding.siteName')} description={t('auth.onboarding.siteNameHelp')} error={fieldErrors.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">{t('auth.onboarding.origins')}</legend>
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <Field label={t('auth.onboarding.originN', { n: i + 1 })} hideLabel error={fieldErrors[`origins.${i}.origin`]} className="flex-1">
                <Input value={r.origin} placeholder="https://www.example.com" /* i18n-ignore: example URL */ dir="ltr" inputMode="url" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, origin: e.target.value } : x)))} />
              </Field>
              <Field label={t('auth.onboarding.matchN', { n: i + 1 })} hideLabel className="w-44">
                <Select value={r.patternType} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, patternType: e.target.value as OriginRow['patternType'] } : x)))}>
                  <option value="exact">{t('auth.onboarding.matchExact')}</option>
                  <option value="subdomain">{t('auth.onboarding.matchSubdomains')}</option>
                </Select>
              </Field>
              <Button variant="ghost" size="icon" aria-label={t('auth.onboarding.removeOriginN', { n: i + 1 })} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" className="self-start" onClick={() => setRows([...rows, { origin: '', patternType: 'exact' }])} disabled={rows.length >= 50}>
            <Plus className="size-4" aria-hidden /> {t('auth.onboarding.addOrigin')}
          </Button>
        </fieldset>
      </div>
    </StepCard>
  );
}

function DepartmentStep({ siteId, onBack, onNext }: { siteId: string | null; onBack: () => void; onNext: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const departments = useDepartments();
  const active = (departments.data ?? []).filter((d) => !d.archivedAt);
  const first = active[0];
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Department['routingMode']>('broadcast');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (first) {
      setName(first.name);
      setMode(first.routingMode);
    }
  }, [first?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!name.trim()) return setError(t('auth.onboarding.departmentRequired'));
    setBusy(true);
    setError(null);
    try {
      const dept = first ? await api.patch<Department>(`/departments/${first.id}`, { name: name.trim(), routingMode: mode, expectedVersion: first.version }) : await api.post<Department>('/departments', { name: name.trim(), routingMode: mode });
      if (siteId) await api.patch(`/sites/${siteId}`, { defaultDepartmentId: dept.id });
      await qc.invalidateQueries({ queryKey: qk.departments });
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepCard
      title={t('auth.onboarding.departmentTitle')}
      description={t('auth.onboarding.departmentBody')}
      footer={
        <>
          <Button variant="secondary" onClick={onBack}>
            {t('common.back')}
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={departments.isLoading}>
            {t('auth.onboarding.saveContinue')}
          </Button>
        </>
      }
    >
      {departments.isLoading ? (
        <Spinner />
      ) : (
        <div className="flex max-w-xl flex-col gap-5">
          {error && <Banner tone="danger">{error}</Banner>}
          <Field label={t('auth.onboarding.departmentName')} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <RadioGroup
            legend={t('auth.onboarding.routingLegend')}
            name="routing"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'broadcast', label: t('auth.routing.broadcast'), description: t('auth.routing.broadcastHelp') },
              { value: 'assigned', label: t('auth.routing.assigned'), description: t('auth.routing.assignedHelp') },
              { value: 'manual', label: t('auth.routing.manual'), description: t('auth.routing.manualHelp') },
            ]}
          />
        </div>
      )}
    </StepCard>
  );
}

function WidgetStep({ siteId, onBack, onNext }: { siteId: string; onBack: () => void; onNext: () => void }) {
  const t = useT();
  const [site, setSite] = useState<Site | null>(null);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [preview, setPreview] = useState<PreviewState>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<Site>(`/sites/${siteId}`), api.get<{ draft: { config: WidgetConfig } | null; published: { config: WidgetConfig } | null }>(`/sites/${siteId}/widget-config`)])
      .then(([s, c]) => {
        setSite(s);
        setConfig(mergeWidgetConfig(c.draft?.config ?? c.published?.config ?? {}));
      })
      .catch((e) => setError(errorMessage(e)));
  }, [siteId]);

  const setAppearance = (patch: Partial<WidgetConfig['appearance']>) => setConfig((c) => (c ? { ...c, appearance: { ...c.appearance, ...patch } } : c));
  const setContent = (patch: Partial<WidgetConfig['content']>) => setConfig((c) => (c ? { ...c, content: { ...c.content, ...patch } } : c));

  const save = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await api.put<{ revision: number }>(`/sites/${siteId}/widget-config`, { config });
      await api.post(`/sites/${siteId}/widget-config/publish`, { revision: draft.revision });
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepCard
      title={t('auth.onboarding.widgetTitle')}
      description={t('auth.onboarding.widgetBody')}
      footer={
        <>
          <Button variant="secondary" onClick={onBack}>
            {t('common.back')}
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!config}>
            {t('auth.onboarding.publishContinue')}
          </Button>
        </>
      }
    >
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      {!config || !site ? (
        <Spinner />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="flex flex-col gap-4">
            <Field label={t('auth.onboarding.brandColor')} description={t('auth.onboarding.brandColorHelp')}>
              <div className="flex items-center gap-2">
                <input type="color" aria-label={t('auth.onboarding.pickColor')} value={config.appearance.primaryColor} onChange={(e) => setAppearance({ primaryColor: e.target.value })} className="h-10 w-12 cursor-pointer rounded-md border border-line bg-surface p-1" />
                <Input value={config.appearance.primaryColor} onChange={(e) => setAppearance({ primaryColor: e.target.value })} maxLength={7} className="w-32 font-mono" dir="ltr" />
              </div>
            </Field>
            <Field label={t('auth.onboarding.companyName')}>
              <Input value={config.appearance.companyName} onChange={(e) => setAppearance({ companyName: e.target.value })} maxLength={60} />
            </Field>
            <Field label={t('auth.onboarding.headerTitle')}>
              <Input value={config.appearance.title} onChange={(e) => setAppearance({ title: e.target.value })} maxLength={60} />
            </Field>
            <Field label={t('auth.onboarding.welcomeMessage')}>
              <Textarea value={config.content.welcomeMessage} onChange={(e) => setContent({ welcomeMessage: e.target.value })} maxLength={300} className="min-h-20" />
            </Field>
            <Field label={t('auth.onboarding.position')}>
              <Select value={config.appearance.position} onChange={(e) => setAppearance({ position: e.target.value as WidgetConfig['appearance']['position'] })}>
                <option value="bottom-right">{t('auth.onboarding.bottomRight')}</option>
                <option value="bottom-left">{t('auth.onboarding.bottomLeft')}</option>
              </Select>
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            <Field label={t('auth.onboarding.previewState')}>
              <Select value={preview} onChange={(e) => setPreview(e.target.value as PreviewState)}>
                {PREVIEW_STATES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {t(s.label)}
                  </option>
                ))}
              </Select>
            </Field>
            <WidgetPreview siteKey={site.publicKey} config={config} state={preview} height={600} />
          </div>
        </div>
      )}
    </StepCard>
  );
}

interface Installation {
  siteKey: string;
  snippet: string;
  status: 'verified' | 'seen_before' | 'not_detected';
  lastVerifiedAt: string | null;
  lastVerifiedOrigin: string | null;
  diagnostics: string[];
}

function InstallStep({ siteId, onBack, onFinish }: { siteId: string; onBack: () => void; onFinish: () => Promise<void> }) {
  const t = useT();
  const [info, setInfo] = useState<Installation | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<Installation>(`/sites/${siteId}/installation-status`);
        if (!stop) setInfo(r);
      } catch (e) {
        if (!stop) setError(errorMessage(e));
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [siteId]);

  const copy = async () => {
    if (!info) return;
    await navigator.clipboard.writeText(info.snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const finish = async () => {
    setBusy(true);
    try {
      await onFinish();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const verified = info?.status === 'verified';
  return (
    <StepCard
      title={t('auth.onboarding.installTitle')}
      description={t('auth.onboarding.installBody', { tag: '</body>' })}
      footer={
        <>
          <Button variant="secondary" onClick={onBack}>
            {t('common.back')}
          </Button>
          <Button variant="primary" onClick={finish} loading={busy}>
            {verified ? t('auth.onboarding.finish') : t('auth.onboarding.finishLater')}
          </Button>
        </>
      }
    >
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      {!info ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="relative">
            <pre dir="ltr" className="overflow-x-auto rounded-[var(--radius-control)] border border-line bg-surface-2 p-4 pe-24 font-mono text-xs leading-5 text-fg scroll-thin">
              <code>{info.snippet}</code>
            </pre>
            <Button size="sm" variant="secondary" className="absolute end-2 top-2" onClick={() => void copy()}>
              {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
          <ul className="flex flex-col gap-2" aria-label={t('auth.onboarding.checklist')}>
            <CheckItem done label={t('auth.onboarding.checkOrigins')} />
            <CheckItem done label={t('auth.onboarding.checkPublished')} />
            <CheckItem
              done={verified || info.status === 'seen_before'}
              label={verified ? t('auth.onboarding.detectedOn', { origin: isolate(info.lastVerifiedOrigin ?? t('auth.onboarding.yourSite')), when: formatRelative(info.lastVerifiedAt) }) : info.status === 'seen_before' ? t('auth.onboarding.lastDetected', { when: formatRelative(info.lastVerifiedAt) }) : t('auth.onboarding.waitingDetection')}
              pending={!verified && info.status === 'not_detected'}
            />
          </ul>
          {info.diagnostics.map((d) => (
            <Banner key={d} tone="warning">
              {d}
            </Banner>
          ))}
        </div>
      )}
    </StepCard>
  );
}

function CheckItem({ done, label, pending }: { done: boolean; label: string; pending?: boolean }) {
  const t = useT();
  return (
    <li className="flex items-center gap-2.5 text-sm">
      {done ? <CheckCircle2 className="size-5 text-success" aria-hidden /> : pending ? <Spinner className="size-5" label={t('auth.onboarding.checking')} /> : <Circle className="size-5 text-fg-3" aria-hidden />}
      <span className={done ? 'text-fg' : 'text-fg-2'}>{label}</span>
      <span className="sr-only">{done ? t('auth.onboarding.complete') : t('auth.onboarding.notYet')}</span>
    </li>
  );
}

export default function OnboardingPage() {
  return (
    <SessionGate>
      <Onboarding />
    </SessionGate>
  );
}
