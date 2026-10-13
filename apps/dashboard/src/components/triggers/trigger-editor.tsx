'use client';
/**
 * Trigger editor (ch. 32/33): event, ALL/ANY conditions, ordered actions, priority,
 * stop processing and cooldown, validated live by the shared DSL validator (the
 * same function the API runs on save and publish). Save draft = PUT /draft, Publish
 * = POST /publish {revision, enabled} after a confirmation summary. Tabs add the
 * simulator (runs the current, possibly unsaved, definition), run history,
 * revision history and the invitation funnel. `trigger.published` events refresh
 * the screen and explain changes made elsewhere.
 *
 * The definition is held in wire form (snake_case) throughout — see triggers-api.ts.
 */
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, MoreHorizontal, Rocket, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DSL_EVENTS,
  DSL_MAX_COOLDOWN_SECONDS,
  DSL_PRIORITY_MAX,
  validateDslDefinition,
  type DslDefinition,
  type DslEvent,
  type DslIssue,
} from '@talkivio/contracts';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Page,
  PanelError,
  Select,
  Skeleton,
  SwitchField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { isolate, tStatic, useT, type Translate } from '@/i18n';
import { ApiError, errorMessage, isApiError } from '@/lib/api';
import { uuid } from '@/lib/ids';
import { byId, useDepartments, useSites, useTags } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { ActionList } from './action-list';
import { ConditionBuilder, TagDatalist, type RefData } from './condition-builder';
import { blankDefinition, departmentNamer, describeAction, eventLabel, fieldGroups, IssueIndex, localizeIssues, issuesFromFieldErrors, validationContext } from './dsl-ui';
import { FunnelPanel, FunnelRangeSelect, type FunnelRange } from './funnel';
import { CharCount, IssueList, NumberBox } from './inputs';
import { RevisionHistory } from './revision-history';
import { RunsTab } from './runs-tab';
import { Simulator } from './simulator';
import { archiveTrigger, createTrigger, patchTriggerMeta, publishTrigger, saveTriggerDraft, setTriggerEnabled } from './trigger-commands';
import { StatusBadge } from './trigger-list';
import { fetchTrigger, hasInvitation, tk, useCustomFields, useTrigger, useTriggersRealtime, type TriggerChange, type TriggerDetail } from './triggers-api';

interface Form {
  name: string;
  description: string;
  def: DslDefinition;
}

const TABS = ['builder', 'simulator', 'runs', 'history', 'invitations'] as const;
type Tab = (typeof TABS)[number];

function isEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function BackLink() {
  const t = useT();
  return (
    <Link href="/settings/triggers" className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-fg-2 hover:text-fg">
      <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {t('triggers.editor.back')}
    </Link>
  );
}

function EditorSkeleton() {
  return (
    <Page aria-busy>
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </Page>
  );
}

// ───────────────────────── Route wrappers ─────────────────────────

export function TriggerEditorRoute({ id }: { id: string }) {
  const t = useT();
  const q = useTrigger(id);
  if (q.isPending) return <EditorSkeleton />;
  if (q.isError)
    return (
      <Page>
        <BackLink />
        <Card>
          {isApiError(q.error, 'NOT_FOUND') ? (
            <EmptyState
              title={t('triggers.editor.notFoundTitle')}
              description={t('triggers.editor.notFoundBody')}
              action={
                <Button asChild variant="secondary">
                  <Link href="/settings/triggers">{t('triggers.editor.backToTriggers')}</Link>
                </Button>
              }
            />
          ) : (
            <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
          )}
        </Card>
      </Page>
    );
  if (q.data.archivedAt)
    return (
      <Page>
        <BackLink />
        <Banner tone="info">{t('triggers.editor.archived', { name: isolate(q.data.name) })}</Banner>
      </Page>
    );
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <Editor key={q.data.id} trigger={q.data} />
    </Suspense>
  );
}

export function NewTriggerRoute() {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <NewTrigger />
    </Suspense>
  );
}

function NewTrigger() {
  const t = useT();
  const params = useSearchParams();
  const from = params.get('from');
  const eventParam = params.get('event');
  const event: DslEvent = eventParam && (DSL_EVENTS as readonly string[]).includes(eventParam) ? (eventParam as DslEvent) : 'visitor.timer.elapsed';
  const source = useTrigger(from);
  if (from && source.isPending) return <EditorSkeleton />;
  if (from && source.isError)
    return (
      <Page>
        <BackLink />
        <Card>
          <PanelError message={t('triggers.editor.copyLoadError', { error: errorMessage(source.error) })} onRetry={() => void source.refetch()} />
        </Card>
      </Page>
    );
  const src = from ? source.data : undefined;
  const def = src?.draft?.definition ?? src?.published?.definition ?? blankDefinition(event);
  const initial: Form = src ? { name: t('triggers.editor.copyOf', { name: src.name }).slice(0, 120), description: src.description ?? '', def } : { name: '', description: '', def };
  return <Editor key={from ?? event} initial={initial} />;
}

// ───────────────────────── Editor ─────────────────────────

function formOf(t: TriggerDetail): Form {
  return { name: t.name, description: t.description ?? '', def: (t.draft?.definition ?? t.published?.definition)! };
}

function Editor({ trigger, initial }: { trigger?: TriggerDetail; initial?: Form }) {
  const t = useT();
  const isNew = !trigger;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const canManage = useCan('triggers.manage');
  const readOnly = !canManage;

  const server = useMemo(() => (trigger ? formOf(trigger) : initial!), [trigger, initial]);
  const [base, setBase] = useState<Form>(server);
  const [form, setForm] = useState<Form>(server);
  const [baseVersion, setBaseVersion] = useState(trigger?.version ?? 0);
  const [serverIssues, setServerIssues] = useState<DslIssue[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  // `info` marks the neutral "edits re-based" notice; everything else is an error.
  const [message, setMessageState] = useState<{ text: string; info: boolean } | null>(null);
  const setMessage = (text: string | null, info = false) => setMessageState(text === null ? null : { text, info });
  const [conflict, setConflict] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [toggleOpen, setToggleOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [funnelRange, setFunnelRange] = useState<FunnelRange>('30');
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  const createKey = useRef(uuid());
  const dirty = !isEqualJson(form, base);

  // Live refresh (trigger.published on team:all). Our own writes come back as events too: they are
  // recognised by their aggregate version once the write that caused them has been adopted.
  const versionRef = useRef(baseVersion);
  versionRef.current = Math.max(versionRef.current, baseVersion);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const ownWrites = useRef(0);
  const own = async <T,>(fn: () => Promise<T>): Promise<T> => {
    ownWrites.current += 1;
    try {
      return await fn();
    } finally {
      ownWrites.current -= 1;
    }
  };
  useTriggersRealtime((c) => {
    const before = triggerRef.current;
    const e = c.event;
    if (!before || e.payload?.triggerId !== before.id) return;
    const check = () => {
      if (ownWrites.current > 0) {
        setTimeout(check, 300);
        return;
      }
      if (e.aggregateVersion !== null && e.aggregateVersion <= versionRef.current) return;
      setRemoteNotice(remoteChangeText(tStatic, before, c));
    };
    check();
  });

  // A newer version arrived (refetch). Adopt it when clean; flag it when editing.
  useEffect(() => {
    if (!trigger || trigger.version === baseVersion) return;
    const next = formOf(trigger);
    if (!dirty || isEqualJson(next, base)) {
      setBase(next);
      setForm(dirty ? form : next);
      setBaseVersion(trigger.version);
      setRemoteChanged(false);
    } else setRemoteChanged(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.version]);

  // Reference data for pickers and the validator's cross-tenant checks.
  const depts = useDepartments();
  const sites = useSites();
  const tags = useTags();
  const custom = useCustomFields();
  const activeDepts = useMemo(() => (depts.data ?? []).filter((d) => !d.archivedAt), [depts.data]);
  const activeSites = useMemo(() => (sites.data ?? []).filter((s) => !s.archivedAt), [sites.data]);
  const refs: RefData = useMemo(
    () => ({
      departments: depts.data ? activeDepts.map((d) => ({ id: d.id, name: d.name })) : undefined,
      sites: sites.data ? activeSites.map((s) => ({ id: s.id, name: s.name })) : undefined,
      tags: (tags.data ?? []).filter((t) => !t.archivedAt).map((t) => t.slug),
    }),
    [depts.data, sites.data, tags.data, activeDepts, activeSites],
  );
  const ctx = useMemo(
    () =>
      validationContext({
        departmentIds: depts.data ? activeDepts.map((d) => d.id) : undefined,
        siteIds: sites.data ? activeSites.map((s) => s.id) : undefined,
        customDefs: custom.data,
      }),
    [depts.data, sites.data, custom.data, activeDepts, activeSites],
  );
  const groups = useMemo(() => fieldGroups(t, form.def.event, custom.data), [t, form.def.event, custom.data]);
  const validation = useMemo(() => validateDslDefinition(form.def, ctx), [form.def, ctx]);
  const issues = useMemo(() => new IssueIndex(localizeIssues(t, [...(validation.ok ? [] : validation.issues), ...serverIssues])), [validation, serverIssues, t]);
  const nameProblem = nameError ?? (!form.name.trim() ? t('triggers.editor.nameRequired') : [...form.name].length > 120 ? t('triggers.editor.maxChars', { max: 120 }) : null);
  const descProblem = [...form.description].length > 500 ? t('triggers.editor.maxChars', { max: 500 }) : null;
  const valid = validation.ok && !nameProblem && !descProblem;
  const problemCount = issues.count + (nameProblem ? 1 : 0) + (descProblem ? 1 : 0);

  const deptById = useMemo(() => byId(depts.data), [depts.data]);
  const deptName = departmentNamer(t, (id) => deptById.get(id)?.name);

  const tabParam = params.get('tab') as Tab | null;
  const showInvitations = !isNew && (hasInvitation(form.def) || hasInvitation(trigger?.published?.definition));
  const tab: Tab = isNew ? 'builder' : tabParam && TABS.includes(tabParam) && (tabParam !== 'invitations' || showInvitations) ? tabParam : 'builder';
  const setTab = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === 'builder') next.delete('tab');
    else next.set('tab', value);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const update = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (serverIssues.length) setServerIssues([]);
    if (patch.name !== undefined && nameError) setNameError(null);
  };
  const setDef = (def: DslDefinition) => update({ def });

  const discard = () => {
    setForm(base);
    setServerIssues([]);
    setNameError(null);
    setMessage(null);
    setConflict(false);
  };

  const adopt = useCallback(
    (d: TriggerDetail) => {
      const next = formOf(d);
      qc.setQueryData(tk.detail(d.id), d);
      versionRef.current = Math.max(versionRef.current, d.version);
      setBase(next);
      setForm(next);
      setBaseVersion(d.version);
      setRemoteChanged(false);
      setConflict(false);
      void qc.invalidateQueries({ queryKey: tk.root, predicate: (q) => q.queryKey[1] === 'list' });
    },
    [qc],
  );

  const reload = async () => {
    if (!trigger) return;
    const d = await fetchTrigger(trigger.id);
    adopt(d);
    setMessage(null);
    setServerIssues([]);
    setRemoteNotice(null);
  };

  /** Keep my edits after a conflict: re-base them on the latest version (explicit choice). */
  const keepMine = async () => {
    if (!trigger) return;
    const d = await fetchTrigger(trigger.id);
    qc.setQueryData(tk.detail(d.id), d);
    setBase(formOf(d));
    setBaseVersion(d.version);
    setConflict(false);
    setRemoteChanged(false);
    setMessage(t('triggers.editor.rebased', { n: d.currentRevision }), true);
  };

  const fail = (e: unknown) => {
    if (isApiError(e, 'VERSION_CONFLICT')) {
      setConflict(true);
      setMessage(null);
      return;
    }
    if (e instanceof ApiError) {
      setServerIssues(issuesFromFieldErrors(e.fieldErrors));
      const n = e.fieldErrors.name?.[0];
      if (n) setNameError(n);
    }
    setMessage(errorMessage(e));
  };

  /** Save metadata + draft; returns the saved head revision, or null on failure. */
  const persist = async (): Promise<number | null> => {
    setMessage(null);
    if (!valid) {
      setMessage(t('triggers.editor.fixFirst'));
      return null;
    }
    setSaving(true);
    try {
      if (isNew) {
        const d = await createTrigger({ name: form.name.trim(), description: form.description.trim() || null, definition: form.def }, createKey.current);
        qc.setQueryData(tk.detail(d.id), d);
        void qc.invalidateQueries({ queryKey: tk.root, predicate: (q) => q.queryKey[1] === 'list' });
        setBase(form); // clean before navigating so the guard does not prompt
        toast.success(t('triggers.editor.savedAsDraft'));
        router.replace(`/settings/triggers/${d.id}`);
        return d.currentRevision;
      }
      let version = baseVersion;
      let detail: TriggerDetail | null = null;
      const meta: { name?: string; description?: string | null } = {};
      if (form.name.trim() !== base.name) meta.name = form.name.trim();
      if (form.description.trim() !== base.description.trim()) meta.description = form.description.trim() || null;
      if (Object.keys(meta).length) {
        detail = await patchTriggerMeta(trigger!.id, meta, version);
        version = detail.version;
        setBaseVersion(version);
        setBase((b) => ({ ...b, name: detail!.name, description: detail!.description ?? '' }));
      }
      let revision = trigger!.currentRevision;
      if (!isEqualJson(form.def, base.def)) {
        const r = await saveTriggerDraft(trigger!.id, form.def, version);
        revision = r.draft.revision;
      }
      const fresh = await fetchTrigger(trigger!.id);
      adopt(fresh);
      toast.success(t('triggers.editor.draftSaved', { n: fresh.currentRevision }));
      return fresh.currentRevision ?? revision;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<boolean> => (await persist()) !== null;
  const guard = useDirtyGuard(dirty && canManage, { what: form.name ? isolate(form.name) : t('triggers.editor.thisTrigger'), onSave: save });

  const needsPublish = !isNew && (dirty || !trigger!.publishedRevision || trigger!.draftPending);

  return (
    <Page>
      {guard}
      <TagDatalist tags={refs.tags} />
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="break-words text-xl" dir="auto">
            {isNew ? (form.name.trim() ? form.name : t('triggers.editor.newTrigger')) : base.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
            {trigger ? <StatusBadge t={trigger} /> : <Badge tone="warning">{t('triggers.editor.notSaved')}</Badge>}
            <span>{eventLabel(t, form.def.event)}</span>
            {trigger && (
              <span className="tabular">
                {trigger.publishedRevision
                  ? t('triggers.editor.revisionsPublished', { draft: trigger.currentRevision, published: trigger.publishedRevision })
                  : t('triggers.editor.revisions', { draft: trigger.currentRevision })}
              </span>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {trigger && trigger.publishedRevision && (
              <Button variant="secondary" onClick={() => setToggleOpen(true)}>
                {trigger.enabled ? t('common.disable') : t('common.enable')}
              </Button>
            )}
            {needsPublish && (
              <Button variant={dirty ? 'secondary' : 'primary'} onClick={() => setPublishOpen(true)} disabled={!valid}>
                <Rocket className="size-4" aria-hidden />
                {t('triggers.editor.publishEllipsis')}
              </Button>
            )}
            {trigger && (
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t('triggers.editor.moreActions')}>
                    <MoreHorizontal className="size-4" aria-hidden />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Copy />} onSelect={() => router.push(`/settings/triggers/new?from=${trigger.id}`)}>
                    {t('triggers.list.duplicate')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 />} danger onSelect={() => setArchiveOpen(true)}>
                    {t('common.archive')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </div>
        )}
      </div>

      {readOnly && <Banner tone="info">{t('triggers.editor.readOnly')}</Banner>}
      {conflict && (
        <Banner
          tone="warning"
          title={t('triggers.editor.conflictTitle')}
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void reload()}>
                {t('triggers.editor.reloadTheirs')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void keepMine()}>
                {t('triggers.editor.keepMine')}
              </Button>
            </div>
          }
        >
          {t('triggers.editor.conflictBody')}
        </Banner>
      )}
      {remoteNotice && !conflict && (
        <Banner
          tone={remoteChanged ? 'warning' : 'info'}
          title={remoteNotice}
          action={
            <div className="flex flex-wrap gap-2">
              {remoteChanged && (
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  {t('triggers.editor.loadLatest')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setRemoteNotice(null)}>
                {t('common.dismiss')}
              </Button>
            </div>
          }
        >
          {remoteChanged ? t('triggers.editor.remoteChangedBody') : dirty ? t('triggers.editor.remoteKeptBody') : t('triggers.editor.remoteLatestBody')}
        </Banner>
      )}
      {remoteChanged && !remoteNotice && !conflict && (
        <Banner
          tone="warning"
          action={
            <Button size="sm" variant="secondary" onClick={() => void reload()}>
              {t('triggers.editor.loadLatest')}
            </Button>
          }
        >
          {t('triggers.editor.remoteChangedBanner')}
        </Banner>
      )}
      {message && !conflict && (
        <Banner tone={message.info ? 'info' : 'danger'}>
          <span dir="auto">{message.text}</span>
        </Banner>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t('triggers.editor.sections')}>
          <TabsTrigger value="builder">
            {t('triggers.editor.tabBuilder')}
            {issues.count > 0 && (
              <Badge tone="danger" className="h-5 px-1.5" aria-label={t('triggers.editor.problemsLabel', { count: issues.count })}>
                {issues.count}
              </Badge>
            )}
          </TabsTrigger>
          {!isNew && <TabsTrigger value="simulator">{t('triggers.editor.tabSimulator')}</TabsTrigger>}
          {!isNew && <TabsTrigger value="runs">{t('triggers.editor.tabRuns')}</TabsTrigger>}
          {!isNew && <TabsTrigger value="history">{t('triggers.editor.tabHistory')}</TabsTrigger>}
          {showInvitations && <TabsTrigger value="invitations">{t('triggers.editor.tabInvitations')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="builder" className="mt-6 flex flex-col gap-6">
          <Card>
            <CardHeader title={t('triggers.editor.basics')} description={t('triggers.editor.basicsHelp')} />
            <CardBody className="grid gap-5 md:grid-cols-2">
              <Field label={t('common.name')} required error={nameProblem && (dirty || nameError || isNew) ? nameProblem : undefined}>
                <Input value={form.name} onChange={(e) => update({ name: e.target.value })} maxLength={140} disabled={readOnly} dir="auto" />
              </Field>
              <Field label={t('triggers.label.event')} error={issues.first('event')} description={t('triggers.editor.eventHelp')}>
                <Select value={form.def.event} onChange={(e) => setDef({ ...form.def, event: e.target.value as DslEvent })} disabled={readOnly}>
                  {DSL_EVENTS.map((e) => (
                    <option key={e} value={e}>
                      {eventLabel(t, e)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('common.description')} className="md:col-span-2" error={descProblem ?? undefined}>
                <Textarea value={form.description} onChange={(e) => update({ description: e.target.value })} rows={2} disabled={readOnly} dir="auto" className="min-h-16" />
              </Field>
              <Field label={t('triggers.label.priority')} error={issues.first('priority')} description={t('triggers.editor.priorityHelp', { max: DSL_PRIORITY_MAX })}>
                <NumberBox value={form.def.priority} min={0} max={DSL_PRIORITY_MAX} onChange={(v) => setDef({ ...form.def, priority: v })} disabled={readOnly} />
              </Field>
              <Field label={t('triggers.label.cooldown')} error={issues.first('cooldown_seconds')} description={t('triggers.editor.cooldownHelp')}>
                <NumberBox value={form.def.cooldown_seconds} min={0} max={DSL_MAX_COOLDOWN_SECONDS} suffix={t('triggers.label.seconds')} onChange={(v) => setDef({ ...form.def, cooldown_seconds: v })} disabled={readOnly} />
              </Field>
              <SwitchField
                className="md:col-span-2"
                label={t('triggers.editor.stopLabel')}
                description={t('triggers.editor.stopHelp')}
                checked={form.def.stop_processing}
                onCheckedChange={(c) => setDef({ ...form.def, stop_processing: c })}
                disabled={readOnly}
              />
              <div className="md:col-span-2">
                <IssueList messages={[...issues.at(''), ...issues.at('dsl_version'), ...issues.at('stop_processing')].map((i) => i.message)} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('triggers.label.conditions')} description={t('triggers.editor.conditionsHelp')} />
            <CardBody>
              <ConditionBuilder def={form.def} onChange={setDef} groups={groups} issues={issues} refs={refs} disabled={readOnly} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('triggers.label.actions')} description={t('triggers.editor.actionsHelp')} />
            <CardBody>
              <ActionList def={form.def} onChange={setDef} issues={issues} refs={refs} customDefs={custom.data} disabled={readOnly} />
            </CardBody>
          </Card>
        </TabsContent>

        {trigger && (
          <>
            <TabsContent value="simulator" className="mt-6">
              <Simulator
                trigger={trigger}
                definition={form.def}
                groups={groups}
                refs={refs}
                customDefs={custom.data}
                canRun={canManage}
                onDefinitionIssues={(list) => {
                  // The builder already shows local validator issues; keep only what the server adds.
                  const local = validation.ok ? [] : validation.issues;
                  setServerIssues(list.filter((i) => !local.some((l) => l.path === i.path && l.message === i.message)));
                }}
                onShowBuilder={() => setTab('builder')}
              />
            </TabsContent>
            <TabsContent value="runs" className="mt-6">
              <RunsTab triggerId={trigger.id} />
            </TabsContent>
            <TabsContent value="history" className="mt-6">
              <RevisionHistory trigger={trigger} canManage={canManage} dirty={dirty} onRestored={adopt} refs={refs} customDefs={custom.data} />
            </TabsContent>
            {showInvitations && (
              <TabsContent value="invitations" className="mt-6">
                <Card>
                  <CardHeader title={t('triggers.editor.funnel')} description={t('triggers.editor.funnelHelp')} action={<FunnelRangeSelect value={funnelRange} onChange={setFunnelRange} />} />
                  <CardBody>
                    <FunnelPanel triggerId={trigger.id} range={funnelRange} />
                  </CardBody>
                </Card>
              </TabsContent>
            )}
          </>
        )}
      </Tabs>

      {canManage && tab === 'builder' && (
        <div className="sticky bottom-0 z-[3] rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-float)]">
          <div className="flex w-full flex-wrap items-center justify-end gap-3 px-4 py-3">
            <p className="me-auto flex items-center gap-1.5 text-sm" role="status" aria-live="polite">
              {problemCount > 0 ? (
                <>
                  <AlertTriangle className="size-4 text-danger" aria-hidden />
                  <span className="font-medium text-danger">{t('triggers.editor.problemsToFix', { count: problemCount })}</span>
                </>
              ) : dirty ? (
                <span className="text-fg-2">{t('triggers.editor.unsavedChanges')}</span>
              ) : (
                <>
                  <CheckCircle2 className="size-4 text-success" aria-hidden />
                  <span className="text-fg-2">{isNew ? t('triggers.editor.validNotSaved') : t('common.saved')}</span>
                </>
              )}
            </p>
            {!isNew && (
              <Button variant="ghost" onClick={discard} disabled={!dirty || saving}>
                {t('triggers.editor.discard')}
              </Button>
            )}
            <Button variant="primary" onClick={() => void persist()} loading={saving} disabled={(!dirty && !isNew) || !valid}>
              <Save className="size-4" aria-hidden />
              {t('triggers.editor.saveDraft')}
            </Button>
          </div>
        </div>
      )}

      {trigger && publishOpen && (
        <PublishDialog
          trigger={trigger}
          def={form.def}
          name={form.name.trim() || trigger.name}
          dirty={dirty}
          deptName={deptName}
          onClose={() => setPublishOpen(false)}
          onConfirm={(enabled) =>
            own(async () => {
              let revision = trigger.currentRevision;
              if (dirty) {
                const r = await persist();
                if (r === null) throw new Error(t('triggers.editor.publishSaveFailed'));
                revision = r;
              }
              try {
                const d = await publishTrigger(trigger.id, revision, enabled);
                adopt(d);
                toast.success(t(enabled ? 'triggers.editor.publishedEnabled' : 'triggers.editor.publishedDisabled', { n: revision }));
              } catch (e) {
                if (isApiError(e, 'VERSION_CONFLICT')) {
                  void reload();
                  throw new Error(t('triggers.editor.publishConflict'));
                }
                throw e;
              }
            })
          }
        />
      )}

      {trigger && (
        <ConfirmDialog
          open={toggleOpen}
          onOpenChange={setToggleOpen}
          title={t(trigger.enabled ? 'triggers.list.disableTitle' : 'triggers.list.enableTitle', { name: isolate(trigger.name) })}
          description={
            trigger.enabled
              ? t('triggers.editor.disableBody', { revision: trigger.publishedRevision, event: eventLabel(t, trigger.event) })
              : t(trigger.draftPending ? 'triggers.list.enableBodyDraft' : 'triggers.list.enableBody', { revision: trigger.publishedRevision, event: eventLabel(t, trigger.event) })
          }
          confirmLabel={trigger.enabled ? t('common.disable') : t('common.enable')}
          danger={trigger.enabled}
          onConfirm={() =>
            own(async () => {
              try {
                const d = await setTriggerEnabled({ ...trigger, version: baseVersion }, !trigger.enabled);
                qc.setQueryData(tk.detail(d.id), d);
                versionRef.current = Math.max(versionRef.current, d.version);
                setBaseVersion(d.version);
                void qc.invalidateQueries({ queryKey: tk.root });
                toast.success(d.enabled ? t('triggers.list.enabledToast') : t('triggers.list.disabledToast'));
              } catch (e) {
                if (isApiError(e, 'VERSION_CONFLICT')) {
                  void qc.invalidateQueries({ queryKey: tk.detail(trigger.id) });
                  throw new Error(t('triggers.editor.changedElsewhere'));
                }
                throw e;
              }
            })
          }
        />
      )}

      {trigger && (
        <ConfirmDialog
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
          title={t('triggers.list.archiveTitle', { name: isolate(trigger.name) })}
          description={t('triggers.editor.archiveBody')}
          confirmLabel={t('triggers.list.archiveConfirm')}
          danger
          onConfirm={() =>
            own(async () => {
              await archiveTrigger(trigger.id, baseVersion);
              setBase(form);
              void qc.invalidateQueries({ queryKey: tk.root });
              toast.success(t('triggers.list.archivedToast'));
              router.push('/settings/triggers');
            })
          }
        />
      )}
    </Page>
  );
}

/** Plain-language summary of a `trigger.published` event, compared with what the editor showed before. */
function remoteChangeText(t: Translate, before: TriggerDetail, c: TriggerChange): string {
  if (c.type === 'trigger.updated') {
    const u = c.event.payload;
    if (u.change === 'draft_saved') return t('triggers.remote.draftSaved', { n: u.currentRevision });
    if (u.change === 'restored') return t('triggers.remote.restored', { n: u.currentRevision });
    if (u.change === 'details') return t('triggers.remote.details');
    return t('triggers.remote.changed');
  }
  const p = c.event.payload;
  if (p.revision && p.revision !== before.publishedRevision) return t(p.enabled ? 'triggers.remote.publishedRunning' : 'triggers.remote.publishedDisabled', { n: p.revision });
  if (p.enabled !== before.enabled) return t(p.enabled ? 'triggers.remote.enabled' : 'triggers.remote.disabled');
  return t('triggers.remote.changed');
}

// ───────────────────────── Publish confirmation ─────────────────────────

function PublishDialog({
  trigger,
  def,
  name,
  dirty,
  deptName,
  onClose,
  onConfirm,
}: {
  trigger: TriggerDetail;
  def: DslDefinition;
  name: string;
  dirty: boolean;
  deptName: (id: string | null) => string;
  onClose: () => void;
  onConfirm: (enabled: boolean) => Promise<void>;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(trigger.publishedRevision ? trigger.enabled : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newRevision = dirty && !trigger.draftPending && !!trigger.publishedRevision;
  const replaces = trigger.publishedRevision
    ? newRevision
      ? t('triggers.publish.replaceNew', { published: trigger.publishedRevision })
      : t('triggers.publish.replace', { revision: trigger.currentRevision, published: trigger.publishedRevision })
    : t('triggers.publish.first');
  const description = dirty ? `${t('triggers.publish.savedFirst')} ${replaces}` : replaces;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(enabled);
      onClose();
    } catch (e) {
      setError(e instanceof Error && !(e instanceof ApiError) ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        size="lg"
        title={t('triggers.list.publishTitle', { name: isolate(name) })}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void run()} loading={busy}>
              {enabled ? t('triggers.list.publishAndEnable') : t('triggers.publish.disabled')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-fg-2">{t('triggers.label.event')}</dt>
            <dd className="text-fg">{eventLabel(t, def.event)}</dd>
            <dt className="text-fg-2">{t('triggers.label.priority')}</dt>
            <dd className="tabular text-fg">{def.priority}</dd>
            <dt className="text-fg-2">{t('triggers.label.conditions')}</dt>
            <dd className="text-fg">
              {def.all.length === 0 && def.any.length === 0
                ? t('triggers.publish.conditionsNone')
                : def.any.length
                  ? t('triggers.publish.conditionsAllAny', { all: def.all.length, any: def.any.length })
                  : t('triggers.publish.conditionsAll', { all: def.all.length })}
            </dd>
            <dt className="text-fg-2">{t('triggers.label.afterwards')}</dt>
            <dd className="text-fg">{def.stop_processing ? t('triggers.label.stopsLower') : t('triggers.label.lowerStillRun')}</dd>
            <dt className="text-fg-2">{t('triggers.label.cooldown')}</dt>
            <dd className="text-fg">{def.cooldown_seconds ? t('triggers.label.cooldownValue', { count: def.cooldown_seconds }) : t('common.none')}</dd>
          </dl>
          <div>
            <p className="font-medium text-fg">{t('triggers.label.whenMatches')}</p>
            <ol className="mt-1 list-decimal ps-5 text-fg-2">
              {def.actions.map((a, i) => (
                <li key={i}>{describeAction(t, a, { department: deptName })}</li>
              ))}
            </ol>
          </div>
          <SwitchField
            label={t('triggers.publish.enableAfter')}
            description={enabled ? t('triggers.publish.enableAfterOn', { event: eventLabel(t, def.event) }) : t('triggers.publish.enableAfterOff')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
