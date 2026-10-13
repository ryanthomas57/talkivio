'use client';
import {
  mergeWidgetConfig,
  WIDGET_LANGUAGES,
  type FieldRequirement,
  type WidgetConfig,
  type WidgetLanguage,
} from '@talkivio/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  PanelError,
  RadioGroup,
  Select,
  Skeleton,
  Switch,
  SwitchField,
} from '@/components/ui';
import { WidgetPreview, PREVIEW_STATES, type PreviewState } from '@/components/widget-preview';
import { useRealtimeEvent, useScopes } from '@/hooks/use-realtime';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { qk } from '@/lib/queries';
import type { Site } from '@/lib/types';
import { useCan } from '@/stores/session';
import {
  ColorField,
  Group,
  NumField,
  PairContrast,
  PrimaryContrast,
  RequirementSelect,
  TextField,
} from './widget-fields';
import {
  cleanForSave,
  getPath,
  MAX_PATTERNS,
  NUM_RANGE,
  PATTERN_MAX,
  sanitizeForPreview,
  serverErrors,
  setPath,
  stable,
  TEXT_MAX,
  validateConfig,
  type Errors,
} from './widget-validation';

interface ConfigResponse {
  draft: { revision: number; config: WidgetConfig; etag?: string; createdAt: string } | null;
  published: { revision: number; config: WidgetConfig; etag?: string; publishedAt: string } | null;
}

const LANGUAGE_LABEL: Record<WidgetLanguage, MessageKey> = {
  auto: 'sites.widget.lang.auto',
  en: 'sites.widget.lang.en',
  es: 'sites.widget.lang.es',
  fr: 'sites.widget.lang.fr',
  de: 'sites.widget.lang.de',
  pt: 'sites.widget.lang.pt',
  it: 'sites.widget.lang.it',
  nl: 'sites.widget.lang.nl',
  ar: 'sites.widget.lang.arRtl',
  ja: 'sites.widget.lang.ja',
};
/** Locales the widget UI is translated into (apps/widget/src/frame/i18n.ts). */
const TRANSLATED = new Set<string>(['auto', 'en', 'ar', 'es', 'fr', 'de', 'pt']);
const PREVIEW_LOCALES: Array<{ value: string; label: MessageKey }> = [
  { value: '', label: 'sites.widget.previewLang.follow' },
  { value: 'en', label: 'sites.widget.lang.en' },
  { value: 'ar', label: 'sites.widget.previewLang.ar' },
  { value: 'es', label: 'sites.widget.lang.es' },
  { value: 'fr', label: 'sites.widget.lang.fr' },
  { value: 'de', label: 'sites.widget.lang.de' },
  { value: 'pt', label: 'sites.widget.lang.pt' },
];

const normalize = (r: ConfigResponse): ConfigResponse => ({
  draft: r.draft ? { ...r.draft, config: mergeWidgetConfig(r.draft.config) } : null,
  published: r.published ? { ...r.published, config: mergeWidgetConfig(r.published.config) } : null,
});

export const widgetConfigKey = (siteId: string) => [...qk.sites, siteId, 'widget-config'] as const;

/**
 * Widget configuration editor (ch. 08, 27–29). Edits stay local until "Save draft"
 * (PUT → draft revision); "Publish" publishes exactly that revision and fails with
 * VERSION_CONFLICT when a newer draft exists. The live preview updates on every
 * keystroke; invalid values fall back to the saved value in the preview only.
 */
export function WidgetEditor({
  site,
  onDirtyChange,
}: {
  site: Site;
  onDirtyChange: (dirty: boolean, save: () => Promise<boolean>) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const canManage = useCan('sites.manage') && !site.archivedAt;
  const q = useQuery({
    queryKey: widgetConfigKey(site.id),
    queryFn: async () => normalize(await api.get<ConfigResponse>(`/sites/${site.id}/widget-config`)),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [server, setServer] = useState<ConfigResponse | null>(null);
  const [baseline, setBaseline] = useState<WidgetConfig | null>(null);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [srvErrors, setSrvErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'save' | 'publish' | 'discard' | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'danger' | 'warning' | 'info';
    title?: string;
    body: ReactNode;
    reload?: boolean;
  } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [preview, setPreview] = useState<{ state: PreviewState; online: boolean; locale: string }>({
    state: 'welcome',
    online: true,
    locale: '',
  });
  const ownPublish = useRef<number | null>(null);
  /** Etag of the server draft these edits are based on (null = based on the published config). */
  const baseEtag = useRef<string | null>(null);

  const init = useCallback((r: ConfigResponse) => {
    const base = r.draft?.config ?? r.published?.config ?? mergeWidgetConfig({});
    baseEtag.current = r.draft?.etag ?? null;
    setServer(r);
    setBaseline(base);
    setConfig(base);
    setSrvErrors({});
  }, []);

  useEffect(() => {
    if (q.data && !server) init(q.data);
  }, [q.data, server, init]);

  const reload = useCallback(async () => {
    const r = await q.refetch();
    if (r.data) {
      init(r.data);
      setNotice(null);
    }
  }, [q, init]);

  const clientErrors = useMemo(() => (config ? validateConfig(config) : {}), [config]);
  const errors = useMemo(() => ({ ...srvErrors, ...clientErrors }), [srvErrors, clientErrors]);
  const errorCount = Object.keys(errors).length;
  const dirty = !!config && !!baseline && stable(config) !== stable(baseline);
  const draftDiffers =
    !!server?.draft && stable(server.draft.config) !== stable(server.published?.config ?? null);
  const configRef = useRef(config);
  configRef.current = config;

  // Someone else published (or our own publish echoed back over the config scope).
  useScopes([{ kind: 'config', id: site.id }]);
  useRealtimeEvent<{ siteId: string; configVersion: number }>('config.published', (e) => {
    if (e.payload.siteId !== site.id || ownPublish.current === e.payload.configVersion) return;
    void qc.invalidateQueries({ queryKey: [...qk.sites, site.id], exact: true });
    if (!dirty)
      void reload().then(() =>
        toast.info(t('sites.widget.notice.publishedByTeammateToast', { revision: e.payload.configVersion })),
      );
    else {
      // The draft we were based on is gone; saving now creates a new draft on top.
      baseEtag.current = null;
      setNotice({
        tone: 'warning',
        title: t('sites.widget.notice.publishedByTeammateTitle', { revision: e.payload.configVersion }),
        body: t('sites.widget.notice.publishedByTeammateBody'),
        reload: true,
      });
      // Keep the "live" line and Discard accurate without touching the edits.
      void api
        .get<ConfigResponse>(`/sites/${site.id}/widget-config`)
        .then((r) => setServer((s) => (s ? { ...s, published: normalize(r).published } : s)))
        .catch(() => undefined);
    }
  });

  /** PUT the draft; returns the saved revision, or null when nothing was saved. */
  const saveDraft = async (): Promise<number | null> => {
    if (!config || !server) return null;
    if (Object.keys(clientErrors).length) {
      setNotice({
        tone: 'danger',
        body: t('sites.widget.notice.fixFields', { count: Object.keys(clientErrors).length }),
      });
      return null;
    }
    const startSig = stable(config);
    const toSave = cleanForSave(config);
    const expected = server.draft?.revision ?? (server.published?.revision ?? 0) + 1;
    setBusy('save');
    setNotice(null);
    try {
      const r = await api.put<{ revision: number; config: WidgetConfig; etag: string }>(`/sites/${site.id}/widget-config`, {
        config: toSave,
        baseEtag: baseEtag.current,
      });
      baseEtag.current = r.etag;
      const saved = mergeWidgetConfig(r.config);
      setServer((s) =>
        s
          ? {
              ...s,
              draft: {
                revision: r.revision,
                config: saved,
                etag: r.etag,
                createdAt: s.draft?.revision === r.revision ? s.draft.createdAt : new Date().toISOString(),
              },
            }
          : s,
      );
      setBaseline(saved);
      setConfig((cur) => (cur && stable(cur) === startSig ? saved : cur));
      setSrvErrors({});
      qc.setQueryData(widgetConfigKey(site.id), (old: ConfigResponse | undefined) =>
        old
          ? { ...old, draft: { revision: r.revision, config: saved, etag: r.etag, createdAt: new Date().toISOString() } }
          : old,
      );
      if (r.revision !== expected)
        setNotice({
          tone: 'warning',
          title: t('sites.widget.notice.savedAsTitle', { revision: r.revision }),
          body: t('sites.widget.notice.savedAsBody', { expected }),
        });
      return r.revision;
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) {
        // Keep the edits; a second save deliberately replaces the teammate's draft.
        const current = e.details.currentEtag ?? e.details.current_etag;
        baseEtag.current = typeof current === 'string' ? current : null;
        setNotice({
          tone: 'warning',
          title: t('sites.widget.notice.draftChangedTitle'),
          body: t('sites.widget.notice.draftChangedBody'),
          reload: true,
        });
        return null;
      }
      const fe = serverErrors(e);
      setSrvErrors(fe);
      setNotice({
        tone: 'danger',
        title: t('sites.widget.notice.notSaved'),
        body: Object.keys(fe).length ? t('sites.widget.notice.notSavedFields', { error: errorMessage(e), count: Object.keys(fe).length }) : errorMessage(e),
      });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!server) return;
    let revision = server.draft?.revision ?? null;
    if (dirty) {
      revision = await saveDraft();
      if (revision === null) return;
    }
    if (revision === null) return;
    setBusy('publish');
    setNotice(null);
    ownPublish.current = revision;
    try {
      const r = await api.post<{ revision: number; alreadyPublished: boolean }>(
        `/sites/${site.id}/widget-config/publish`,
        { revision, ...(baseEtag.current ? { etag: baseEtag.current } : {}) },
      );
      await reload();
      void qc.invalidateQueries({ queryKey: qk.sites });
      toast.success(r.alreadyPublished ? t('sites.widget.notice.alreadyPublished', { revision: r.revision }) : t('sites.widget.notice.published', { revision: r.revision }));
    } catch (e) {
      ownPublish.current = null;
      if (isApiError(e, 'VERSION_CONFLICT'))
        setNotice({
          tone: 'warning',
          title: t('sites.widget.notice.newerDraftTitle'),
          body: t('sites.widget.notice.newerDraftBody', { revision }),
          reload: true,
        });
      else setNotice({ tone: 'danger', title: t('sites.widget.notice.notPublished'), body: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  /** Discard: delete the unpublished server draft (the editor falls back to the published settings); otherwise just reset local edits. */
  const discard = async () => {
    if (!server) return;
    if (draftDiffers && server.published) {
      setBusy('discard');
      try {
        const etag = baseEtag.current ? `?etag=${encodeURIComponent(baseEtag.current)}` : '';
        await api.delete(`/sites/${site.id}/widget-config/draft${etag}`);
        const published = server.published;
        baseEtag.current = null;
        setServer({ ...server, draft: null });
        qc.setQueryData(widgetConfigKey(site.id), (old: ConfigResponse | undefined) => (old ? { ...old, draft: null } : old));
        setBaseline(published.config);
        setConfig(published.config);
        setSrvErrors({});
        setNotice(null);
        toast.success(t('sites.widget.notice.discarded', { revision: published.revision }));
      } catch (e) {
        setNotice(
          isApiError(e, 'VERSION_CONFLICT')
            ? { tone: 'warning', title: t('sites.widget.notice.notDiscarded'), body: errorMessage(e), reload: true }
            : { tone: 'danger', title: t('sites.widget.notice.notDiscarded'), body: errorMessage(e) },
        );
      } finally {
        setBusy(null);
      }
    } else if (baseline) {
      setConfig(baseline);
      setSrvErrors({});
      setNotice(null);
    }
  };

  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  useEffect(
    () => onDirtyChange(dirty, async () => (await saveRef.current()) !== null),
    [dirty, onDirtyChange],
  );

  const previewConfig = useMemo(
    () => (config && baseline ? sanitizeForPreview(config, clientErrors, baseline) : null),
    [config, baseline, clientErrors],
  );

  if (q.isError && !server)
    return (
      <Card>
        <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      </Card>
    );
  if (!config || !server || !baseline || !previewConfig)
    return (
      <div className="grid gap-6 min-[1200px]:grid-cols-[minmax(0,1fr)_420px]" aria-busy>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-[480px] w-full" />
        </div>
        <Skeleton className="h-[600px] w-full" />
      </div>
    );

  const set = (path: string, value: unknown) => {
    setConfig((c) => (c ? setPath(c, path, value) : c));
    setSrvErrors((e) => {
      const hit = Object.keys(e).filter((k) => k === path || k.startsWith(`${path}.`));
      if (!hit.length) return e;
      const next = { ...e };
      hit.forEach((k) => delete next[k]);
      return next;
    });
  };
  const str = (path: string) => getPath(config, path) as string;
  const num = (path: string) => getPath(config, path) as number;
  const bool = (path: string) => getPath(config, path) as boolean;
  const dis = !canManage;
  const px = t('sites.widget.unit.px');
  const a = config.appearance;
  const b = config.behavior;

  const text = (
    path: string,
    label: string,
    opts: { description?: ReactNode; multiline?: boolean; placeholder?: string } = {},
  ) => (
    <TextField
      label={label}
      value={str(path)}
      onChange={(v) => set(path, v)}
      max={TEXT_MAX[path]!}
      error={errors[path]}
      disabled={dis}
      {...opts}
    />
  );
  const number = (path: string, label: string, unit?: string, description?: ReactNode) => {
    const [min, max] = NUM_RANGE[path]!;
    return (
      <NumField
        label={label}
        value={num(path)}
        onChange={(v) => set(path, v)}
        min={min}
        max={max}
        unit={unit}
        description={description}
        error={errors[path]}
        disabled={dis}
      />
    );
  };
  const toggle = (path: string, label: string, description?: ReactNode) => (
    <SwitchField
      label={label}
      description={description}
      checked={bool(path)}
      onCheckedChange={(v) => set(path, v)}
      disabled={dis}
    />
  );
  const requirement = (path: string, label: string) => (
    <RequirementSelect
      label={label}
      value={getPath(config, path) as FieldRequirement}
      onChange={(v) => set(path, v)}
      disabled={dis || !bool(path.replace(/\.[^.]+$/, '.enabled'))}
    />
  );
  const urlField = (path: string, label: string, description: ReactNode) => (
    <Field label={label} description={description} error={errors[path]}>
      <Input
        value={(getPath(config, path) as string | null) ?? ''}
        onChange={(e) => set(path, e.target.value === '' ? null : e.target.value)}
        placeholder="https://cdn.example.com/logo.png" // i18n-ignore: example URL
        dir="ltr"
        inputMode="url"
        spellCheck={false}
        maxLength={520}
        disabled={dis}
      />
    </Field>
  );

  const patterns = b.visibility.patterns;
  const publishedAt = server.published?.publishedAt;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-live="polite">
              <dt className="text-fg-2">{t('sites.widget.status.live')}</dt>
              <dd>
                {server.published ? (
                  <>
                    <span className="font-medium">{t('sites.list.revision', { revision: server.published.revision })}</span>
                    {publishedAt && (
                      <>
                        {' · '}
                        <time dateTime={publishedAt} title={formatDateTime(publishedAt)}>
                          {t('sites.widget.status.publishedAgo', { time: formatRelative(publishedAt) })}
                        </time>
                      </>
                    )}
                  </>
                ) : (
                  t('sites.widget.status.nothingPublished')
                )}
              </dd>
              <dt className="text-fg-2">{t('sites.widget.status.draft')}</dt>
              <dd>
                {draftDiffers && server.draft ? (
                  <span className="font-medium text-warning">{t('sites.widget.status.draftSaved', { revision: server.draft.revision })}</span>
                ) : (
                  t('sites.widget.status.noDraft')
                )}
              </dd>
              <dt className="text-fg-2">{t('sites.widget.status.editor')}</dt>
              <dd>{dirty ? <span className="font-medium">{t('sites.widget.unsavedEdits')}</span> : t('sites.widget.status.matches')}</dd>
            </dl>
          </div>
          {notice && (
            <Banner
              tone={notice.tone}
              title={notice.title}
              action={
                notice.reload ? (
                  <Button size="sm" variant="secondary" onClick={() => void reload()}>
                    {t('common.reload')}
                  </Button>
                ) : undefined
              }
            >
              {notice.body}
            </Banner>
          )}
          {!canManage && (
            <Banner tone="info">
              {site.archivedAt ? t('sites.widget.archivedReadOnly') : t('sites.widget.viewOnly')}
            </Banner>
          )}
        </CardBody>
      </Card>

      <div className="grid items-start gap-6 min-[1200px]:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title={t('sites.widget.appearance.title')} description={t('sites.widget.appearance.description')} />
            <CardBody className="flex flex-col gap-5">
              <Group title={t('sites.widget.appearance.colors')}>
                <div className="grid gap-5 md:grid-cols-2">
                  <ColorField
                    label={t('sites.widget.appearance.brandColor')}
                    description={t('sites.widget.appearance.brandColorHint')}
                    value={a.primaryColor}
                    onChange={(v) => set('appearance.primaryColor', v)}
                    error={errors['appearance.primaryColor']}
                    disabled={dis}
                  >
                    <PrimaryContrast color={a.primaryColor} />
                  </ColorField>
                  <ColorField
                    label={t('sites.widget.appearance.secondaryColor')}
                    description={t('sites.widget.appearance.secondaryColorHint')}
                    value={a.secondaryColor}
                    onChange={(v) => set('appearance.secondaryColor', v)}
                    error={errors['appearance.secondaryColor']}
                    disabled={dis}
                  />
                  <ColorField
                    label={t('sites.widget.appearance.headerBackground')}
                    value={a.headerBackground}
                    onChange={(v) => set('appearance.headerBackground', v)}
                    error={errors['appearance.headerBackground']}
                    disabled={dis}
                  >
                    <PairContrast bg={a.headerBackground} fg={a.headerTextColor} what={t('sites.widget.appearance.headerText')} />
                  </ColorField>
                  <ColorField
                    label={t('sites.widget.appearance.headerText')}
                    value={a.headerTextColor}
                    onChange={(v) => set('appearance.headerTextColor', v)}
                    error={errors['appearance.headerTextColor']}
                    disabled={dis}
                  />
                </div>
              </Group>
              <Group title={t('sites.widget.appearance.position')}>
                <RadioGroup
                  legend={t('sites.widget.appearance.corner')}
                  name="position"
                  value={a.position}
                  onChange={(v) => set('appearance.position', v)}
                  options={[
                    { value: 'bottom-right', label: t('sites.widget.appearance.bottomRight'), disabled: dis },
                    { value: 'bottom-left', label: t('sites.widget.appearance.bottomLeft'), disabled: dis },
                  ]}
                />
                <div className="grid gap-5 sm:grid-cols-2">
                  {number('appearance.offsetX', t('sites.widget.appearance.sideOffset'), px, t('sites.widget.appearance.sideOffsetHint', { min: 0, max: 200, mobile: 12 }))}
                  {number('appearance.offsetY', t('sites.widget.appearance.bottomOffset'), px, t('sites.widget.appearance.bottomOffsetHint', { min: 0, max: 200 }))}
                </div>
              </Group>
              <Group title={t('sites.widget.appearance.launcher')}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t('sites.widget.appearance.icon')}>
                    <Select
                      value={a.launcherIcon}
                      onChange={(e) => set('appearance.launcherIcon', e.target.value)}
                      disabled={dis}
                    >
                      <option value="chat">{t('sites.widget.icon.chat')}</option>
                      <option value="message">{t('sites.widget.icon.message')}</option>
                      <option value="help">{t('sites.widget.icon.help')}</option>
                      <option value="wave">{t('sites.widget.icon.wave')}</option>
                      <option value="custom">{t('sites.widget.icon.custom')}</option>
                    </Select>
                  </Field>
                  {a.launcherIcon === 'custom' &&
                    urlField('appearance.launcherIconUrl', t('sites.widget.appearance.customIconUrl'), t('sites.widget.appearance.customIconUrlHint', { size: 48 }))}
                </div>
                {text('appearance.launcherLabel', t('sites.widget.appearance.launcherLabel'), {
                  description: t('sites.widget.appearance.launcherLabelHint'),
                })}
                {toggle('appearance.showLauncherLabel', t('sites.widget.appearance.showLauncherLabel'), t('sites.widget.appearance.showLauncherLabelHint'))}
              </Group>
              <Group title={t('sites.widget.appearance.header')}>
                <div className="grid gap-5 md:grid-cols-2">
                  {text('appearance.title', t('sites.widget.appearance.titleField'))}
                  {text('appearance.companyName', t('sites.widget.appearance.companyName'), {
                    description: t('sites.widget.appearance.companyNameHint'),
                  })}
                </div>
                {text('appearance.subtitle', t('sites.widget.appearance.subtitle'), {
                  description: t('sites.widget.appearance.subtitleHint'),
                })}
                {urlField('appearance.logoUrl', t('sites.widget.appearance.logoUrl'), t('sites.widget.appearance.logoUrlHint'))}
                {toggle('appearance.showAgentAvatars', t('sites.widget.appearance.showAvatars'))}
                {toggle('appearance.showAgentNames', t('sites.widget.appearance.showNames'), t('sites.widget.appearance.showNamesHint'))}
                {toggle('appearance.showBranding', t('sites.widget.appearance.showBranding'))}
              </Group>
              <Group title={t('sites.widget.appearance.shape')}>
                <div className="grid gap-5 sm:grid-cols-2">
                  {number('appearance.borderRadius', t('sites.widget.appearance.windowRadius'), px)}
                  {number('appearance.buttonRadius', t('sites.widget.appearance.launcherRadius'), px, t('sites.widget.appearance.launcherRadiusHint', { min: 0, max: 40, circle: 28 }))}
                  {number('appearance.width', t('sites.widget.appearance.width'), px, t('sites.widget.appearance.widthHint', { min: 320, max: 480 }))}
                  {number('appearance.height', t('sites.widget.appearance.height'), px, t('sites.widget.appearance.heightHint', { min: 420, max: 760 }))}
                  <Field label={t('sites.widget.appearance.font')}>
                    <Select
                      value={a.font}
                      onChange={(e) => set('appearance.font', e.target.value)}
                      disabled={dis}
                    >
                      <option value="system">{t('sites.widget.font.system')}</option>
                      <option value="inter">Inter{/* i18n-ignore: font name */}</option>
                      <option value="serif">{t('sites.widget.font.serif')}</option>
                      <option value="rounded">{t('sites.widget.font.rounded')}</option>
                      <option value="mono">{t('sites.widget.font.mono')}</option>
                    </Select>
                  </Field>
                  <Field label={t('sites.widget.appearance.theme')}>
                    <Select
                      value={a.theme}
                      onChange={(e) => set('appearance.theme', e.target.value)}
                      disabled={dis}
                    >
                      <option value="light">{t('sites.widget.theme.light')}</option>
                      <option value="dark">{t('sites.widget.theme.dark')}</option>
                      <option value="auto">{t('sites.widget.theme.auto')}</option>
                    </Select>
                  </Field>
                </div>
              </Group>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={t('sites.widget.content.title')}
              description={t('sites.widget.content.description')}
            />
            <CardBody className="flex flex-col gap-5">
              <Field
                label={t('sites.widget.content.language')}
                description={
                  TRANSLATED.has(config.content.language)
                    ? config.content.language === 'ar'
                      ? t('sites.widget.content.languageArabic')
                      : t('sites.widget.content.languageSdk')
                    : t('sites.widget.content.languageUntranslated', { language: t(LANGUAGE_LABEL[config.content.language]) })
                }
              >
                <Select
                  value={config.content.language}
                  onChange={(e) => set('content.language', e.target.value)}
                  disabled={dis}
                >
                  {WIDGET_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {t(LANGUAGE_LABEL[l])}
                    </option>
                  ))}
                </Select>
              </Field>
              <Group title={t('sites.widget.content.conversation')}>
                {text('content.welcomeMessage', t('sites.widget.content.welcome'), {
                  multiline: true,
                  description: t('sites.widget.content.welcomeHint'),
                })}
                {text('content.inputPlaceholder', t('sites.widget.content.inputPlaceholder'))}
                {text('content.prechatGreeting', t('sites.widget.content.prechatGreeting'), { multiline: true })}
                {text('content.waitingMessage', t('sites.widget.content.waiting'), {
                  multiline: true,
                  description: t('sites.widget.content.waitingHint'),
                })}
                {text('content.chatEndedMessage', t('sites.widget.content.ended'))}
                {text('content.ratingPrompt', t('sites.widget.content.rating'))}
              </Group>
              <Group title={t('sites.widget.content.offline')}>
                {text('content.offlineTitle', t('sites.widget.content.offlineTitle'))}
                {text('content.offlineMessage', t('sites.widget.content.offlineMessage'), { multiline: true })}
                {text('content.offlineThanks', t('sites.widget.content.offlineThanks'), {
                  multiline: true,
                  description: t('sites.widget.content.offlineThanksHint'),
                })}
              </Group>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('sites.widget.behavior.title')} description={t('sites.widget.behavior.description')} />
            <CardBody className="flex flex-col gap-5">
              <Group title={t('sites.widget.behavior.greeting')} description={t('sites.widget.behavior.greetingHint')}>
                {toggle('behavior.greeting.enabled', t('sites.widget.behavior.showGreeting'))}
                {b.greeting.enabled && (
                  <>
                    {text('behavior.greeting.message', t('sites.widget.behavior.greetingMessage'))}
                    {number('behavior.greeting.delaySeconds', t('sites.widget.behavior.delay'), t('sites.widget.unit.seconds'), t('sites.widget.behavior.delayHint', { min: 0, max: 600 }))}
                    {toggle('behavior.greeting.showOnMobile', t('sites.widget.behavior.showOnMobile'))}
                  </>
                )}
              </Group>
              <Group title={t('sites.widget.behavior.prechat')} description={t('sites.widget.behavior.prechatHint')}>
                {toggle('behavior.prechatForm.enabled', t('sites.widget.behavior.prechatEnabled'))}
                <div className="grid gap-4 sm:grid-cols-2">
                  {requirement('behavior.prechatForm.name', t('common.name'))}
                  {requirement('behavior.prechatForm.email', t('common.email'))}
                  {requirement('behavior.prechatForm.phone', t('sites.widget.behavior.phone'))}
                  {requirement('behavior.prechatForm.department', t('common.department'))}
                </div>
              </Group>
              <Group title={t('sites.widget.behavior.offlineForm')} description={t('sites.widget.behavior.offlineFormHint')}>
                {toggle('behavior.offlineForm.enabled', t('sites.widget.behavior.offlineFormEnabled'))}
                <div className="grid gap-4 sm:grid-cols-2">
                  {requirement('behavior.offlineForm.phone', t('sites.widget.behavior.phone'))}
                  {requirement('behavior.offlineForm.department', t('common.department'))}
                </div>
              </Group>
              <Group title={t('sites.widget.behavior.during')}>
                {toggle('behavior.attachments.enabled', t('sites.widget.behavior.attachments'), t('sites.widget.behavior.attachmentsHint'))}
                {toggle('behavior.ratings.enabled', t('sites.widget.behavior.ratings'))}
                {toggle('behavior.transcripts.enabled', t('sites.widget.behavior.transcripts'))}
                {toggle('behavior.sound', t('sites.widget.behavior.sound'))}
                {toggle('behavior.openOnAgentMessage', t('sites.widget.behavior.openOnAgentMessage'))}
                {toggle('behavior.showQueuePosition', t('sites.widget.behavior.queuePosition'), t('sites.widget.behavior.queuePositionHint'))}
              </Group>
              <Group title={t('sites.widget.behavior.visibility')}>
                {toggle('behavior.hideOnMobile', t('sites.widget.behavior.hideOnMobile'))}
                {toggle('behavior.hideWhenOffline', t('sites.widget.behavior.hideWhenOffline'), t('sites.widget.behavior.hideWhenOfflineHint'))}
                {toggle('behavior.trackPages', t('sites.widget.behavior.trackPages'), t('sites.widget.behavior.trackPagesHint'))}
                <RadioGroup
                  legend={t('sites.widget.behavior.pages')}
                  name="visibility-mode"
                  value={b.visibility.mode}
                  onChange={(v) => set('behavior.visibility.mode', v)}
                  options={[
                    { value: 'all', label: t('sites.widget.behavior.pagesAll'), disabled: dis },
                    { value: 'include', label: t('sites.widget.behavior.pagesInclude'), disabled: dis },
                    { value: 'exclude', label: t('sites.widget.behavior.pagesExclude'), disabled: dis },
                  ]}
                />
                {b.visibility.mode !== 'all' && (
                  <fieldset className="flex flex-col gap-2" disabled={dis}>
                    <legend className="mb-1 text-sm font-medium">
                      {b.visibility.mode === 'include' ? t('sites.widget.behavior.showOn') : t('sites.widget.behavior.hideOn')}
                    </legend>
                    <p className="-mt-1 text-xs text-fg-2">{t('sites.widget.behavior.patternHelp')}</p>
                    {errors['behavior.visibility.patterns'] && (
                      <p className="text-xs font-medium text-danger" role="alert">
                        {errors['behavior.visibility.patterns']}
                      </p>
                    )}
                    {patterns.map((p, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <Field
                          label={t('sites.widget.behavior.patternN', { n: i + 1 })}
                          hideLabel
                          error={errors[`behavior.visibility.patterns.${i}`]}
                          className="min-w-0 flex-1"
                        >
                          <Input
                            value={p}
                            maxLength={PATTERN_MAX + 20}
                            spellCheck={false}
                            placeholder="https://www.example.com/help/*" // i18n-ignore: example URL pattern
                            dir="ltr"
                            onChange={(e) =>
                              set(
                                'behavior.visibility.patterns',
                                patterns.map((x, j) => (j === i ? e.target.value : x)),
                              )
                            }
                          />
                        </Field>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('sites.widget.behavior.removePattern', { n: i + 1 })}
                          onClick={() =>
                            set(
                              'behavior.visibility.patterns',
                              patterns.filter((_, j) => j !== i),
                            )
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      disabled={patterns.length >= MAX_PATTERNS}
                      onClick={() => set('behavior.visibility.patterns', [...patterns, ''])}
                    >
                      <Plus className="size-4" aria-hidden /> {t('sites.widget.behavior.addPattern')}
                    </Button>
                  </fieldset>
                )}
              </Group>
            </CardBody>
          </Card>
        </div>

        <aside
          className="flex flex-col gap-3 min-[1200px]:sticky min-[1200px]:top-4"
          aria-label={t('sites.widget.preview.label')}
        >
          <Card>
            <CardBody className="flex flex-col gap-3 sm:py-4">
              <div className="grid gap-3 sm:grid-cols-2 min-[1200px]:grid-cols-1">
                <Field label={t('sites.widget.preview.state')}>
                  <Select
                    value={preview.state}
                    onChange={(e) => setPreview({ ...preview, state: e.target.value as PreviewState })}
                  >
                    {PREVIEW_STATES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {t(s.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('sites.widget.preview.language')}>
                  <Select
                    value={preview.locale}
                    onChange={(e) => setPreview({ ...preview, locale: e.target.value })}
                  >
                    {PREVIEW_LOCALES.map((l) => (
                      <option key={l.value} value={l.value}>
                        {t(l.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="flex min-h-11 items-center justify-between gap-4">
                <label htmlFor="preview-online" className="text-sm font-medium">
                  {t('sites.widget.preview.agentsAvailable')}
                  <span className="block text-xs font-normal text-fg-2">{preview.online ? t('sites.widget.preview.online') : t('sites.widget.preview.offline')}</span>
                </label>
                <Switch
                  id="preview-online"
                  checked={preview.online}
                  onCheckedChange={(v) => setPreview({ ...preview, online: v })}
                />
              </div>
            </CardBody>
          </Card>
          <WidgetPreview
            siteKey={site.publicKey}
            config={previewConfig}
            state={preview.state}
            online={preview.online}
            locale={preview.locale}
            height={680}
          />
          <p className="text-xs text-fg-2">
            {t('sites.widget.preview.note')}
          </p>
        </aside>
      </div>

      {canManage && (
        <div className="sticky bottom-0 z-[3] flex flex-wrap items-center justify-end gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
          <span className="me-auto text-sm" role="status" aria-live="polite">
            {errorCount > 0 ? (
              <span className="font-medium text-danger">{t('sites.widget.bar.attention', { count: errorCount })}</span>
            ) : dirty ? (
              <span className="text-fg">{t('sites.widget.unsavedEdits')}</span>
            ) : draftDiffers ? (
              <span className="text-warning">{t('sites.widget.bar.draftReady')}</span>
            ) : (
              <span className="text-fg-2">{t('sites.widget.bar.upToDate')}</span>
            )}
          </span>
          <Button
            variant="ghost"
            disabled={(!dirty && !draftDiffers) || !!busy}
            loading={busy === 'discard'}
            onClick={() => (draftDiffers ? setConfirmDiscard(true) : void discard())}
          >
            {draftDiffers ? t('sites.widget.bar.discardDraft') : t('sites.widget.bar.discardEdits')}
          </Button>
          <Button
            variant="secondary"
            disabled={!dirty || errorCount > 0 || (!!busy && busy !== 'save')}
            loading={busy === 'save'}
            onClick={() => void saveDraft()}
          >
            {t('sites.widget.bar.saveDraft')}
          </Button>
          <Button
            variant="primary"
            disabled={(!dirty && !draftDiffers) || errorCount > 0 || (!!busy && busy !== 'publish')}
            loading={busy === 'publish'}
            onClick={() => void publish()}
          >
            {dirty ? t('sites.widget.bar.saveAndPublish') : draftDiffers && server.draft ? t('sites.widget.bar.publishRevision', { revision: server.draft.revision }) : t('common.publish')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={server.draft ? t('sites.widget.discard.title', { revision: server.draft.revision }) : t('sites.widget.discard.titleNoRevision')}
        danger
        confirmLabel={t('sites.widget.bar.discardDraft')}
        description={t(dirty ? 'sites.widget.discard.bodyWithEdits' : 'sites.widget.discard.body', { revision: server.published?.revision ?? '—' })}
        onConfirm={discard}
      />
    </div>
  );
}
