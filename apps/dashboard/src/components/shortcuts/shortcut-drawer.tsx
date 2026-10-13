'use client';
/**
 * Create / edit / view drawer for one canned reply (ch. 18). Plain-text body up to
 * 8000 code points with a live counter, placeholder insert menu, quick-reply
 * options, tags, scope picker limited by permissions, live server-rendered preview
 * of the unsaved text, and VERSION_CONFLICT handling with an explicit Reload or
 * Merge choice.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Braces, Copy, GitMerge, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SHORTCUT_NAME_RE } from '@talkivio/contracts';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DrawerContent,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  RadioGroup,
  Select,
  Skeleton,
  SwitchField,
  Textarea,
  PanelError,
} from '@/components/ui';
import { ApiError, api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useDepartments, useTags } from '@/lib/queries';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { formatNumber } from '@/lib/format';
import { intlLocale, isolate, useT, type MessageKey } from '@/i18n';
import { ChipEditor } from './chip-editor';
import { ShortcutPreview } from './shortcut-preview';
import { codePoints, fetchShortcut, MAX_BODY, MAX_OPTIONS, MAX_TAGS, MAX_TITLE, PLACEHOLDERS, SCOPE_LABELS, sk, SLUG_HINT, useScopeAbilities, type ScopeType, type Shortcut } from './shortcuts-api';

interface Form {
  slug: string;
  title: string;
  body: string;
  scopeType: ScopeType;
  scopeId: string | null;
  options: string[];
  tags: string[];
  enabled: boolean;
}

/** Shortcuts are Latin slugs in every language. */
const SLUG_EXAMPLE = 'shortcut'; // i18n-ignore: slug example
const FIELDS: Array<keyof Form> = ['slug', 'title', 'body', 'options', 'tags', 'enabled'];
const FIELD_LABELS: Record<string, MessageKey> = { slug: 'shortcuts.field.slug', title: 'shortcuts.field.title', body: 'shortcuts.field.body', options: 'shortcuts.field.options', tags: 'shortcuts.field.tags', enabled: 'shortcuts.field.enabled' };

function formOf(s: Shortcut): Form {
  return { slug: s.slug, title: s.title, body: s.body, scopeType: s.scopeType, scopeId: s.scopeId, options: s.options, tags: s.tags, enabled: s.enabled };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type DrawerTarget = { mode: 'edit'; id: string } | { mode: 'new'; from?: string | null };

export function ShortcutDrawer({ target, onClose, onCreated, onDuplicate }: { target: DrawerTarget; onClose: () => void; onCreated: (s: Shortcut) => void; onDuplicate: (id: string) => void }) {
  const t = useT();
  /** The editor registers a close handler that asks before discarding unsaved edits (Escape, overlay, X). */
  const requestClose = useRef<(() => void) | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; item: Shortcut | null; source: Shortcut | null }>({ loading: true, error: null, item: null, source: null });
  const [reloadKey, setReloadKey] = useState(0);
  const sourceId = target.mode === 'edit' ? target.id : (target.from ?? null);

  useEffect(() => {
    let alive = true;
    if (!sourceId) {
      setState({ loading: false, error: null, item: null, source: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchShortcut(sourceId)
      .then((r) => alive && setState({ loading: false, error: null, item: target.mode === 'edit' ? r : null, source: target.mode === 'new' ? r : null }))
      .catch((e) => alive && setState({ loading: false, error: isApiError(e, 'NOT_FOUND') ? t('shortcuts.drawer.notFound') : errorMessage(e), item: null, source: null }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, target.mode, reloadKey]);

  const title = target.mode === 'edit' ? (state.item ? `/${state.item.slug}` : t('shortcuts.drawer.titleReply')) : target.from ? t('shortcuts.drawer.titleDuplicate') : t('shortcuts.page.newReply');
  return (
    <Dialog open onOpenChange={(o) => !o && (requestClose.current ? requestClose.current() : onClose())}>
      <DrawerContent title={title} description={target.mode === 'edit' ? state.item?.title : t('shortcuts.drawer.description')} width={680}>
        {state.loading ? (
          <div className="flex flex-col gap-4 p-5" aria-busy>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-40" />
          </div>
        ) : state.error ? (
          <PanelError message={state.error} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : (
          <Editor key={`${target.mode}:${state.item?.id ?? 'new'}`} item={state.item} source={state.source} onClose={onClose} onCreated={onCreated} onDuplicate={onDuplicate} registerClose={(fn) => (requestClose.current = fn)} />
        )}
      </DrawerContent>
    </Dialog>
  );
}

function Editor({
  item,
  source,
  onClose,
  onCreated,
  onDuplicate,
  registerClose,
}: {
  item: Shortcut | null;
  source: Shortcut | null;
  onClose: () => void;
  onCreated: (s: Shortcut) => void;
  onDuplicate: (id: string) => void;
  registerClose: (fn: (() => void) | null) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const abilities = useScopeAbilities();
  const depts = useDepartments();
  const tags = useTags();
  const isNew = !item;
  const editable = isNew ? abilities.manageable.length > 0 : item.editable && !item.archivedAt;

  const initial: Form = useMemo(() => {
    if (item) return formOf(item);
    const s = source;
    const scope: ScopeType = s && abilities.manageable.includes(s.scopeType) ? s.scopeType : (abilities.manageable[0] ?? 'personal');
    return {
      slug: s ? `${s.slug}-copy`.slice(0, 40) : '',
      title: s ? t('shortcuts.drawer.copyTitle', { title: s.title }).slice(0, MAX_TITLE) : '',
      body: s?.body ?? '',
      scopeType: scope,
      scopeId: scope === 'department' ? (s?.scopeType === 'department' ? s.scopeId : null) : scope === 'personal' ? abilities.membershipId : null,
      options: s?.options ?? [],
      tags: s?.tags ?? [],
      enabled: s?.enabled ?? true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [current, setCurrent] = useState<Shortcut | null>(item);
  const [base, setBase] = useState<Form>(initial);
  const [form, setForm] = useState<Form>(initial);
  const [baseVersion, setBaseVersion] = useState(item?.version ?? 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Shortcut | null>(null);
  const [mergeNote, setMergeNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const idemKey = useRef(uuid());
  const dirty = !same(form, base);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k as string]) setErrors(({ [k as string]: _drop, ...rest }) => rest);
  };

  const bodyLen = codePoints(form.body);
  const slugProblem = form.slug && !SHORTCUT_NAME_RE.test(form.slug) ? t('shortcuts.drawer.slugInvalid') : null;
  const localErrors: Record<string, string> = {
    ...(slugProblem ? { slug: slugProblem } : {}),
    ...(bodyLen > MAX_BODY ? { body: t('shortcuts.drawer.bodyOver', { over: formatNumber(bodyLen - MAX_BODY), max: formatNumber(MAX_BODY) }) } : {}),
    ...([...form.title].length > MAX_TITLE ? { title: t('shortcuts.chips.tooLong', { max: MAX_TITLE }) } : {}),
  };
  const err = (k: string) => errors[k] ?? localErrors[k];
  const missingRequired = !form.slug.trim() || !form.title.trim() || !form.body.trim() || (form.scopeType === 'department' && !form.scopeId);

  const deptOptions = useMemo(() => {
    const list = (depts.data ?? []).filter((d) => !d.archivedAt);
    return abilities.manageableDepartments === 'all' ? list : list.filter((d) => (abilities.manageableDepartments as string[]).includes(d.id));
  }, [depts.data, abilities.manageableDepartments]);
  const deptName = (id: string | null) => (id ? ((depts.data ?? []).find((d) => d.id === id)?.name ?? t('shortcuts.drawer.unknownDepartment')) : '');

  const insertPlaceholder = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    const start = el?.selectionStart ?? form.body.length;
    const end = el?.selectionEnd ?? start;
    const next = form.body.slice(0, start) + token + form.body.slice(end);
    set('body', next);
    // Restored when the menu closes (instead of Radix returning focus to the menu button).
    caretAfterInsert.current = start + token.length;
  };
  const caretAfterInsert = useRef<number | null>(null);
  const restoreCaret = (e: Event) => {
    const pos = caretAfterInsert.current;
    if (pos === null) return;
    e.preventDefault();
    caretAfterInsert.current = null;
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
  };

  const applyFailure = (e: unknown) => {
    if (isApiError(e, 'VERSION_CONFLICT')) {
      const cur = (e as ApiError).details.current as Shortcut | undefined;
      setConflict(cur ?? null);
      if (!cur) setMessage(t('common.conflictReload'));
      return;
    }
    if (e instanceof ApiError) {
      const fe: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.fieldErrors)) {
        const top = k.split('.')[0]!;
        const key = top === 'scope_id' ? 'scopeId' : top === 'scope_type' ? 'scopeType' : top;
        fe[key] ??= v[0] ?? t('shortcuts.drawer.invalidValue');
      }
      if (e.code === 'CONFLICT' && e.details.field === 'slug') fe.slug = e.message;
      setErrors(fe);
      setMessage(Object.keys(fe).length ? t('shortcuts.drawer.checkFields') : errorMessage(e));
      return;
    }
    setMessage(errorMessage(e));
  };

  const save = async (): Promise<boolean> => {
    setMessage(null);
    setMergeNote(null);
    if (missingRequired || Object.keys(localErrors).length) {
      const req: Record<string, string> = {};
      if (!form.slug.trim()) req.slug = t('shortcuts.drawer.slugRequired');
      if (!form.title.trim()) req.title = t('shortcuts.drawer.titleRequired');
      if (!form.body.trim()) req.body = t('shortcuts.drawer.bodyRequired');
      if (form.scopeType === 'department' && !form.scopeId) req.scopeId = t('shortcuts.drawer.departmentRequired');
      setErrors((e) => ({ ...e, ...req }));
      setMessage(t('shortcuts.drawer.checkFields'));
      return false;
    }
    setSaving(true);
    try {
      if (isNew && !current) {
        const created = await api.post<Shortcut>(
          '/shortcuts',
          {
            slug: form.slug.trim(),
            title: form.title.trim(),
            body: form.body,
            scopeType: form.scopeType,
            scopeId: form.scopeType === 'tenant' ? null : form.scopeId,
            options: form.options,
            tags: form.tags,
            enabled: form.enabled,
          },
          { idempotencyKey: idemKey.current },
        );
        toast.success(t('shortcuts.drawer.created', { slug: isolate(`/${created.slug}`) }));
        void qc.invalidateQueries({ queryKey: sk.root });
        onCreated(created);
        return true;
      }
      const patch: Record<string, unknown> = {};
      for (const k of FIELDS) if (!same(form[k], base[k])) patch[k] = k === 'slug' || k === 'title' ? (form[k] as string).trim() : form[k];
      if (!Object.keys(patch).length) return true;
      const updated = await api.patch<Shortcut>(`/shortcuts/${current!.id}`, patch, { ifMatch: baseVersion });
      setCurrent(updated);
      setBase(formOf(updated));
      setForm(formOf(updated));
      setBaseVersion(updated.version);
      setConflict(null);
      setErrors({});
      qc.setQueryData(sk.detail(updated.id), updated);
      void qc.invalidateQueries({ queryKey: sk.root });
      toast.success(t('shortcuts.drawer.saved'));
      return true;
    } catch (e) {
      applyFailure(e);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Reload: discard my edits and take the other editor's version. */
  const reloadTheirs = async () => {
    const latest = conflict ?? (current ? await fetchShortcut(current.id) : null);
    if (!latest) return;
    setCurrent(latest);
    setBase(formOf(latest));
    setForm(formOf(latest));
    setBaseVersion(latest.version);
    setConflict(null);
    setMergeNote(null);
    setMessage(null);
    setErrors({});
  };

  /** Merge: keep my changed fields on top of the latest version; untouched fields take theirs. */
  const merge = () => {
    if (!conflict) return;
    const theirs = formOf(conflict);
    const next = { ...theirs };
    const both: string[] = [];
    for (const k of FIELDS) {
      const mine = !same(form[k], base[k]);
      const changedTheirs = !same(theirs[k], base[k]);
      if (mine) (next as Record<string, unknown>)[k] = form[k];
      if (mine && changedTheirs && !same(form[k], theirs[k])) both.push(FIELD_LABELS[k] ? t(FIELD_LABELS[k]!) : k);
    }
    setCurrent(conflict);
    setBase(theirs);
    setForm(next);
    setBaseVersion(conflict.version);
    setConflict(null);
    setMessage(null);
    setMergeNote(
      both.length
        ? t('shortcuts.drawer.mergedBoth', { fields: new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(both) })
        : t('shortcuts.drawer.merged'),
    );
  };

  const archive = async () => {
    if (!current) return;
    try {
      await api.post<Shortcut>(`/shortcuts/${current.id}/archive`, {}, { ifMatch: baseVersion });
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) throw new Error(t('shortcuts.drawer.archiveChanged'));
      throw e;
    }
    toast.success(t('shortcuts.archive.done', { slug: isolate(`/${current.slug}`) }));
    void qc.invalidateQueries({ queryKey: sk.root });
    onClose();
  };

  const close = () => (dirty && editable ? setDiscardOpen(true) : onClose());
  useEffect(() => {
    registerClose(close);
    return () => registerClose(null);
  });
  const guard = useDirtyGuard(dirty && editable, { what: t('shortcuts.drawer.dirtyWhat'), onSave: async () => (await save()) === true });

  const scopeOptions = (isNew ? abilities.manageable : [form.scopeType]).map((s) => ({
    value: s,
    label: t(SCOPE_LABELS[s]),
    description: s === 'tenant' ? t('shortcuts.drawer.scopeTenantHelp') : s === 'department' ? t('shortcuts.drawer.scopeDepartmentHelp') : t('shortcuts.drawer.scopePersonalHelp'),
  }));

  return (
    <div className="flex flex-col">
      {guard}
      <div className="flex flex-col gap-5 p-5">
        {!editable && !isNew && (
          <Banner tone="info">{item?.archivedAt ? t('shortcuts.drawer.archived') : t('shortcuts.drawer.readOnly')}</Banner>
        )}
        {conflict && (
          <Banner
            tone="warning"
            title={t('shortcuts.drawer.conflictTitle')}
            action={
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button size="sm" variant="secondary" onClick={() => void reloadTheirs()}>
                  <RotateCw className="size-3.5" aria-hidden />
                  {t('common.reload')}
                </Button>
                <Button size="sm" variant="secondary" onClick={merge}>
                  <GitMerge className="size-3.5" aria-hidden />
                  {t('shortcuts.drawer.merge')}
                </Button>
              </div>
            }
          >
            {t('shortcuts.drawer.conflictBody', { time: formatDateTime(conflict.updatedAt) })}
          </Banner>
        )}
        {mergeNote && <Banner tone="info">{mergeNote}</Banner>}
        {message && !conflict && <Banner tone="danger">{message}</Banner>}

        <div className="grid gap-5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <Field label={t('shortcuts.page.colShortcut')} required error={err('slug')} description={`${t('shortcuts.drawer.slugHelp', { slug: isolate(`/${form.slug || SLUG_EXAMPLE}`) })} ${t(SLUG_HINT)}`}>
            <div className="relative" dir="ltr">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-2" aria-hidden>
                /
              </span>
              <Input value={form.slug} onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/^[/#]/, ''))} maxLength={40} disabled={!editable} className="pl-6 font-mono" autoComplete="off" spellCheck={false} />
            </div>
          </Field>
          <Field label={t('shortcuts.page.colTitle')} required error={err('title')}>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={MAX_TITLE + 20} disabled={!editable} dir="auto" />
          </Field>
        </div>

        <Field
          label={t('shortcuts.drawer.bodyLabel')}
          required
          error={err('body')}
          description={t('shortcuts.drawer.bodyHelp', { example: '{{visitor.name|there}}' })}
          action={
            editable && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm" variant="ghost">
                    <Braces className="size-3.5" aria-hidden />
                    {t('shortcuts.drawer.insertPlaceholder')}
                  </Button>
                </MenuTrigger>
                <MenuContent onCloseAutoFocus={restoreCaret}>
                  <MenuLabel>{t('shortcuts.drawer.insertedAtCursor')}</MenuLabel>
                  {PLACEHOLDERS.map((p) => (
                    <MenuItem key={p.key} onSelect={() => insertPlaceholder(p.key)}>
                      <span className="flex flex-col">
                        <span>{t(p.label)}</span>
                        <code className="text-xs text-fg-2" dir="ltr">{`{{${p.key}}}`}</code>
                      </span>
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )
          }
        >
          <Textarea ref={bodyRef} value={form.body} onChange={(e) => set('body', e.target.value)} rows={7} disabled={!editable} className="min-h-40" dir="auto" />
        </Field>
        <p className={`-mt-3 text-end text-xs tabular ${bodyLen > MAX_BODY ? 'font-medium text-danger' : 'text-fg-2'}`} aria-live={bodyLen > MAX_BODY ? 'polite' : 'off'}>
          {t('common.characterCount', { count: formatNumber(bodyLen), max: formatNumber(MAX_BODY) })}
        </p>

        {isNew ? (
          <div className="flex flex-col gap-3">
            {scopeOptions.length ? (
              <RadioGroup
                legend={t('shortcuts.drawer.whoCanUse')}
                name="reply-scope"
                value={form.scopeType}
                onChange={(v) => {
                  setForm((f) => ({ ...f, scopeType: v, scopeId: v === 'personal' ? abilities.membershipId : v === 'department' ? (deptOptions[0]?.id ?? null) : null }));
                }}
                options={scopeOptions}
              />
            ) : (
              <Banner tone="info">{t('shortcuts.drawer.noPermission')}</Banner>
            )}
            {form.scopeType === 'department' && (
              <Field label={t('common.department')} required error={err('scopeId')}>
                <Select value={form.scopeId ?? ''} onChange={(e) => set('scopeId', e.target.value || null)}>
                  <option value="">{t('shortcuts.drawer.chooseDepartment')}</option>
                  {deptOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-fg">{t('shortcuts.drawer.whoCanUseLabel')}</span>
            <Badge tone={form.scopeType === 'personal' ? 'note' : form.scopeType === 'department' ? 'info' : 'primary'}>
              {t(SCOPE_LABELS[form.scopeType])}
              {form.scopeType === 'department' && form.scopeId ? <> · <bdi>{deptName(form.scopeId)}</bdi></> : ''}
            </Badge>
            <span className="text-xs text-fg-2">{t('shortcuts.drawer.scopeLocked')}</span>
          </div>
        )}

        <Field label={t('shortcuts.drawer.optionsLabel')} error={err('options')} description={t('shortcuts.drawer.optionsHelp', { max: MAX_OPTIONS, length: 60 })}>
          <ChipEditor
            values={form.options}
            onChange={(v) => set('options', v)}
            max={MAX_OPTIONS}
            maxLength={60}
            labels={{ list: t('shortcuts.drawer.optionsList'), remove: (v) => t('shortcuts.drawer.removeOption', { value: v }), atMost: (max) => t('shortcuts.drawer.optionsMax', { max }) }}
            placeholder={t('shortcuts.drawer.addOption')}
            disabled={!editable}
          />
        </Field>

        <Field label={t('shortcuts.drawer.tagsLabel')} error={err('tags')} description={t('shortcuts.drawer.tagsHelp', { max: MAX_TAGS })}>
          <ChipEditor
            values={form.tags}
            onChange={(v) => set('tags', v)}
            max={MAX_TAGS}
            maxLength={64}
            labels={{ list: t('shortcuts.drawer.tagsList'), remove: (v) => t('shortcuts.drawer.removeTag', { value: v }), atMost: (max) => t('shortcuts.drawer.tagsMax', { max }) }}
            placeholder={t('shortcuts.drawer.addTag')}
            normalize={(s) => s.trim().toLowerCase()}
            check={(v) => (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? null : t('shortcuts.drawer.tagInvalid'))}
            listId="reply-tag-options"
            disabled={!editable}
          />
          <datalist id="reply-tag-options">
            {(tags.data ?? []).filter((tag) => !tag.archivedAt).map((tag) => (
              <option key={tag.id} value={tag.slug} />
            ))}
          </datalist>
        </Field>

        <SwitchField label={t('common.enabled')} description={t('shortcuts.drawer.enabledHelp')} checked={form.enabled} onCheckedChange={(c) => set('enabled', c)} disabled={!editable} />

        <div className="border-t border-line-subtle pt-5">
          <ShortcutPreview body={form.body} options={form.options} />
        </div>

        {current && (
          <p className="text-xs text-fg-2">
            {t('shortcuts.drawer.usage', { count: current.usageCount, time: formatDateTime(current.updatedAt) })}
          </p>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-line-subtle bg-surface px-5 py-4">
        {current && editable && (
          <Button variant="danger-ghost" className="me-auto" onClick={() => setArchiveOpen(true)}>
            <Trash2 className="size-4" aria-hidden />
            {t('common.archive')}
          </Button>
        )}
        {current && !editable && abilities.manageable.length > 0 && (
          <Button variant="secondary" className="me-auto" onClick={() => onDuplicate(current.id)}>
            <Copy className="size-4" aria-hidden />
            {t('shortcuts.page.duplicate')}
          </Button>
        )}
        <Button variant="secondary" onClick={close}>
          {editable ? t('common.cancel') : t('common.close')}
        </Button>
        {editable && (
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!!current && !dirty}>
            {current ? t('common.saveChanges') : t('shortcuts.drawer.create')}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={current ? t('shortcuts.archive.title', { slug: isolate(`/${current.slug}`) }) : ''}
        description={t('shortcuts.archive.body')}
        confirmLabel={t('shortcuts.archive.confirm')}
        danger
        onConfirm={archive}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('shortcuts.drawer.discardTitle')}
        description={t('shortcuts.drawer.discardBody')}
        confirmLabel={t('common.dirty.discard')}
        danger
        onConfirm={() => onClose()}
      />
    </div>
  );
}
