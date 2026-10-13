'use client';
/**
 * Per-visitor custom field values (ch. 17/37): typed inputs generated from the
 * active definitions, saved with If-Match so another editor's change is never
 * overwritten silently. Values for archived definitions stay read-only.
 */
import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Banner, Button, EmptyState, Field, Input, Select, Skeleton } from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { useT, type Translate } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/stores/session';
import type { FieldProvenance } from '@/components/visitors/types';
import { describeRules, useCustomFields, type CustomField } from './types';

type Draft = Record<string, string | boolean>;

function toDraft(defs: CustomField[], values: Record<string, unknown>): Draft {
  const d: Draft = {};
  for (const f of defs) {
    const v = values[f.key];
    if (f.dataType === 'boolean') d[f.key] = v === true ? 'true' : v === false ? 'false' : '';
    else d[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return d;
}

function parse(t: Translate, f: CustomField, raw: string | boolean): { ok: true; value: string | number | boolean | null } | { ok: false; error: string } {
  const s = typeof raw === 'boolean' ? String(raw) : raw.trim();
  if (s === '') return { ok: true, value: null };
  switch (f.dataType) {
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: t('customFields.dialog.enterNumber') };
    }
    case 'boolean':
      return { ok: true, value: s === 'true' };
    default:
      return { ok: true, value: s };
  }
}

function display(t: Translate, f: CustomField | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (f?.dataType === 'boolean') return v === true ? t('common.yes') : t('common.no');
  if (f?.dataType === 'enum') return f.validation.options?.find((o) => o.value === v)?.label ?? String(v);
  return String(v);
}

export interface ValuesTarget {
  id: string;
  version: number;
  customFields: Record<string, unknown>;
  customFieldSources?: Record<string, FieldProvenance | undefined>;
  erased: boolean;
}

/** Where a value came from — values from the visitor's page are client-supplied and never treated as verified. */
function SourceNote({ source }: { source: FieldProvenance | undefined }) {
  const t = useT();
  if (!source) return null;
  const label = source.source === 'visitor' ? t('customFields.values.sourceVisitor') : source.source === 'trigger' ? t('customFields.values.sourceTrigger') : t('customFields.values.sourceAgent');
  return (
    <span className="block text-[11px] font-normal text-fg-3" title={formatDateTime(source.at)}>
      {label}
    </span>
  );
}

export function CustomFieldValues({ visitor, onSaved, onReload, compact }: { visitor: ValuesTarget; onSaved: (next: unknown) => void; onReload: () => void; compact?: boolean }) {
  const t = useT();
  const defsQ = useCustomFields(false);
  const canEdit = useCan('visitors.edit') && !visitor.erased;
  const canManage = useCan('custom_fields.manage');
  const defs = useMemo(() => defsQ.data ?? [], [defsQ.data]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const baseline = useMemo(() => toDraft(defs, visitor.customFields), [defs, visitor.customFields]);
  const dirty = editing && defs.some((f) => (draft[f.key] ?? '') !== (baseline[f.key] ?? ''));
  const extra = Object.entries(visitor.customFields).filter(([k]) => !defs.some((f) => f.key === k));

  const save = async (): Promise<boolean> => {
    const patch: Record<string, unknown> = {};
    const local: Record<string, string> = {};
    for (const f of defs) {
      if ((draft[f.key] ?? '') === (baseline[f.key] ?? '')) continue;
      const r = parse(t, f, draft[f.key] ?? '');
      if (!r.ok) local[f.key] = r.error;
      else patch[f.key] = r.value;
    }
    setErrors(local);
    if (Object.keys(local).length) return false;
    if (!Object.keys(patch).length) {
      setEditing(false);
      return true;
    }
    setSaving(true);
    setFailure(null);
    setConflict(false);
    try {
      const next = await api.patch(`/visitors/${visitor.id}`, { customFields: patch }, { ifMatch: visitor.version });
      onSaved(next);
      setEditing(false);
      toast.success(t('customFields.values.saved'));
      return true;
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) setConflict(true);
      else if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        const fe: Record<string, string> = {};
        for (const [k, msgs] of Object.entries(e.fieldErrors)) fe[k.replace(/^custom_fields\./, '')] = msgs[0] ?? t('customFields.values.invalid');
        setErrors(fe);
        setFailure(e.message);
      } else setFailure(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const guard = useDirtyGuard(dirty, { what: t('customFields.values.dirtyWhat'), onSave: save });

  if (defsQ.isLoading) return <Skeleton className="h-20 w-full" />;
  if (defsQ.isError) return <Banner tone="danger">{t('customFields.values.loadFailed', { error: errorMessage(defsQ.error) })}</Banner>;
  if (!defs.length && !extra.length)
    return compact ? (
      <p className="text-sm text-fg-2">
        {t('customFields.values.noneDefined')}
        {canManage ? ' ' : ''}
        {canManage && (
          <Link href="/settings/custom-fields" className="font-medium text-primary hover:underline">
            {t('customFields.values.defineFields')}
          </Link>
        )}
      </p>
    ) : (
      <EmptyState
        title={t('customFields.values.emptyTitle')}
        description={t('customFields.values.emptyBody')}
        action={
          canManage ? (
            <Button asChild variant="secondary">
              <Link href="/settings/custom-fields">{t('customFields.values.defineCustomFields')}</Link>
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <div className="flex flex-col gap-3">
      {guard}
      {conflict && (
        <Banner
          tone="warning"
          title={t('customFields.values.conflictTitle')}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConflict(false);
                setEditing(false);
                onReload();
              }}
            >
              {t('common.reload')}
            </Button>
          }
        >
          {t('customFields.values.conflictBody')}
        </Banner>
      )}
      {failure && !conflict && <Banner tone="danger">{failure}</Banner>}
      {!editing ? (
        <>
          <dl className="flex flex-col gap-2">
            {defs.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-3 text-sm">
                <dt className="min-w-0 text-fg-2">
                  <bdi>{f.label}</bdi>
                  <span className="ms-1 font-mono text-[11px] text-fg-3" dir="ltr">
                    {f.key}
                  </span>
                </dt>
                <dd className="min-w-0 text-end font-medium text-fg break-anywhere" dir="auto">
                  {display(t, f, visitor.customFields[f.key])}
                  {f.key in visitor.customFields && <SourceNote source={visitor.customFieldSources?.[f.key]} />}
                </dd>
              </div>
            ))}
            {extra.map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3 text-sm">
                <dt className="min-w-0 text-fg-2">
                  <span className="font-mono text-xs" dir="ltr">
                    {k}
                  </span>{' '}
                  <span className="text-xs">{t('customFields.values.archivedReadOnly')}</span>
                </dt>
                <dd className="min-w-0 text-end text-fg break-anywhere" dir="auto">
                  {display(t, undefined, v)}
                </dd>
              </div>
            ))}
          </dl>
          {canEdit && defs.length > 0 && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(baseline);
                  setErrors({});
                  setFailure(null);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden /> {t('customFields.values.edit')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {defs.map((f) => (
            <ValueInput key={f.id} field={f} value={draft[f.key] ?? ''} error={errors[f.key]} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
              {t('customFields.values.save')}
            </Button>
            <Button type="button" variant="secondary" disabled={saving} onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ValueInput({ field: f, value, error, onChange }: { field: CustomField; value: string | boolean; error?: string; onChange: (v: string) => void }) {
  const t = useT();
  const v = typeof value === 'boolean' ? String(value) : value;
  const description = t('customFields.values.ruleHint', { rules: describeRules(f) });
  if (f.dataType === 'boolean')
    return (
      <Field label={f.label} description={t('customFields.values.booleanHint')} error={error}>
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('customFields.values.notSet')}</option>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </Select>
      </Field>
    );
  if (f.dataType === 'enum')
    return (
      <Field label={f.label} description={t('customFields.values.enumHint')} error={error}>
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('customFields.values.notSet')}</option>
          {(f.validation.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  const val = f.validation;
  return (
    <Field label={f.label} description={description} error={error}>
      <Input
        value={v}
        onChange={(e) => onChange(e.target.value)}
        type={f.dataType === 'number' ? 'number' : f.dataType === 'date' ? 'date' : val.format === 'email' ? 'email' : val.format === 'url' ? 'url' : val.format === 'phone' ? 'tel' : 'text'}
        inputMode={f.dataType === 'number' ? 'decimal' : undefined}
        step={f.dataType === 'number' ? (val.integer ? 1 : 'any') : undefined}
        min={f.dataType === 'number' || f.dataType === 'date' ? (val.min as string | number | undefined) : undefined}
        max={f.dataType === 'number' || f.dataType === 'date' ? (val.max as string | number | undefined) : undefined}
        maxLength={f.dataType === 'string' ? (val.maxLength ?? 500) : undefined}
        dir={f.dataType === 'string' && !val.format ? 'auto' : undefined}
      />
    </Field>
  );
}

