'use client';
/**
 * Create / edit a custom field definition (ch. 37). The key is immutable after
 * creation; the type can change only while no visitor or offline message holds a
 * value (the API rejects it otherwise). Saves use If-Match.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Banner, Button, CheckboxField, Dialog, DialogContent, Field, Input, Select, SwitchField } from '@/components/ui';
import { isolate, useT, type Translate } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { customFieldKeys, FIELD_TYPES, TYPE_LABEL, type CustomField, type EnumOption, type FieldType, type FieldValidation } from './types';

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED = new Set(['id', 'name', 'email', 'phone', 'display_name', 'verified', 'vip', 'priority', 'role', 'visibility', 'internal', 'tenant_id', 'site_id', 'visitor_id', 'department_id', 'owner', 'tags']);

interface Draft {
  key: string;
  label: string;
  dataType: FieldType;
  minLength: string;
  maxLength: string;
  format: '' | 'email' | 'url' | 'phone';
  min: string;
  max: string;
  integer: boolean;
  options: EnumOption[];
  publicWritable: boolean;
  visibleToVisitor: boolean;
}

function toDraft(f: CustomField | null): Draft {
  const v = f?.validation ?? {};
  return {
    key: f?.key ?? '',
    label: f?.label ?? '',
    dataType: f?.dataType ?? 'string',
    minLength: v.minLength !== undefined ? String(v.minLength) : '',
    maxLength: v.maxLength !== undefined ? String(v.maxLength) : '',
    format: v.format ?? '',
    min: v.min !== undefined ? String(v.min) : '',
    max: v.max !== undefined ? String(v.max) : '',
    integer: !!v.integer,
    options: v.options?.length ? v.options : [{ value: '', label: '' }],
    publicWritable: f?.publicWritable ?? false,
    visibleToVisitor: f?.visibleToVisitor ?? false,
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 64);

function buildValidation(t: Translate, d: Draft, errs: Record<string, string>): FieldValidation {
  const v: FieldValidation = {};
  const int = (s: string, key: string, min: number, max: number) => {
    if (!s.trim()) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n) || n < min || n > max) {
      errs[key] = t('customFields.dialog.wholeNumber', { min, max });
      return undefined;
    }
    return n;
  };
  if (d.dataType === 'string') {
    const a = int(d.minLength, 'minLength', 0, 2000);
    const b = int(d.maxLength, 'maxLength', 1, 2000);
    if (a !== undefined) v.minLength = a;
    if (b !== undefined) v.maxLength = b;
    if (a !== undefined && b !== undefined && a > b) errs.minLength = t('customFields.dialog.minExceedsMax');
    if (d.format) v.format = d.format;
  } else if (d.dataType === 'number') {
    const num = (s: string, key: string) => {
      if (!s.trim()) return undefined;
      const n = Number(s);
      if (!Number.isFinite(n)) {
        errs[key] = t('customFields.dialog.enterNumber');
        return undefined;
      }
      return n;
    };
    const a = num(d.min, 'min');
    const b = num(d.max, 'max');
    if (a !== undefined) v.min = a;
    if (b !== undefined) v.max = b;
    if (a !== undefined && b !== undefined && a > b) errs.min = t('customFields.dialog.minExceedsMax');
    if (d.integer) v.integer = true;
  } else if (d.dataType === 'date') {
    if (d.min) v.min = d.min;
    if (d.max) v.max = d.max;
    if (d.min && d.max && d.min > d.max) errs.min = t('customFields.dialog.startAfterEnd');
  } else if (d.dataType === 'enum') {
    const opts = d.options.map((o) => ({ value: o.value.trim(), label: o.label.trim() || o.value.trim() })).filter((o) => o.value);
    if (!opts.length) errs.options = t('customFields.dialog.needOption');
    else if (new Set(opts.map((o) => o.value)).size !== opts.length) errs.options = t('customFields.dialog.uniqueOptions');
    else if (opts.some((o) => o.value.length > 100 || o.label.length > 100)) errs.options = t('customFields.dialog.optionTooLong', { max: 100 });
    v.options = opts;
  }
  return v;
}

export function FieldDialog({ open, onOpenChange, field }: { open: boolean; onOpenChange: (o: boolean) => void; field: CustomField | null }) {
  const t = useT();
  const qc = useQueryClient();
  const editing = !!field;
  const [d, setD] = useState<Draft>(() => toDraft(field));
  const [keyTouched, setKeyTouched] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setD(toDraft(field));
    setKeyTouched(!!field);
    setErrs({});
    setError(null);
    setConflict(false);
  }, [open, field]);

  const up = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const typeChanged = editing && d.dataType !== field!.dataType;

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!editing) {
      if (!KEY_RE.test(d.key)) e.key = t('customFields.dialog.keyInvalid', { max: 64 });
      else if (RESERVED.has(d.key)) e.key = t('customFields.dialog.keyReserved');
    }
    if (!d.label.trim()) e.label = t('customFields.dialog.labelRequired');
    const validation = buildValidation(t, d, e);
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const body = { label: d.label.trim(), dataType: d.dataType, validation, publicWritable: d.publicWritable, visibleToVisitor: d.visibleToVisitor };
      if (editing) await api.patch<CustomField>(`/custom-fields/${field!.id}`, body, { ifMatch: field!.version });
      else await api.post<CustomField>('/custom-fields', { key: d.key, ...body });
      await qc.invalidateQueries({ queryKey: customFieldKeys.root });
      toast.success(editing ? t('customFields.dialog.saved') : t('customFields.dialog.created'));
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err, 'VERSION_CONFLICT')) setConflict(true);
      else {
        if (err instanceof ApiError) {
          const fe: Record<string, string> = {};
          for (const [k, msgs] of Object.entries(err.fieldErrors)) {
            const key = k.replace(/^validation\./, '').replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
            fe[key === 'validation' ? 'options' : key] = msgs[0] ?? t('customFields.dialog.invalid');
          }
          setErrs(fe);
        }
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title={editing ? t('customFields.dialog.editTitle', { label: isolate(field!.label) }) : t('customFields.dialog.newTitle')}
        description={t('customFields.dialog.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void submit()} loading={busy}>
              {editing ? t('customFields.dialog.save') : t('customFields.dialog.create')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('customFields.col.label')} required error={errs.label}>
              <Input
                dir="auto"
                value={d.label}
                maxLength={80}
                onChange={(e) => {
                  const label = e.target.value;
                  up(editing || keyTouched ? { label } : { label, key: slug(label) });
                }}
              />
            </Field>
            <Field label={t('customFields.col.key')} required={!editing} description={editing ? t('customFields.dialog.keyLocked') : t('customFields.dialog.keyHint')} error={errs.key}>
              <Input
                dir="ltr"
                value={d.key}
                readOnly={editing}
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                onChange={(e) => {
                  setKeyTouched(true);
                  up({ key: e.target.value.toLowerCase() });
                }}
              />
            </Field>
          </div>

          <Field label={t('customFields.col.type')} description={editing ? t('customFields.dialog.typeHint') : undefined}>
            <Select value={d.dataType} onChange={(e) => up({ dataType: e.target.value as FieldType })}>
              {FIELD_TYPES.map((ft) => (
                <option key={ft} value={ft}>
                  {t(TYPE_LABEL[ft])}
                </option>
              ))}
            </Select>
          </Field>
          {typeChanged && <Banner tone="warning">{t('customFields.dialog.typeChange', { from: t(TYPE_LABEL[field!.dataType]), to: t(TYPE_LABEL[d.dataType]) })}</Banner>}

          <fieldset className="flex flex-col gap-4 rounded-[var(--radius-control)] border border-line-subtle p-4">
            <legend className="px-1 text-sm font-medium">{t('customFields.dialog.validation')}</legend>
            {d.dataType === 'string' && (
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t('customFields.dialog.format')}>
                  <Select value={d.format} onChange={(e) => up({ format: e.target.value as Draft['format'] })}>
                    <option value="">{t('customFields.dialog.formatAny')}</option>
                    <option value="email">{t('customFields.dialog.formatEmail')}</option>
                    <option value="url">{t('customFields.dialog.formatUrl')}</option>
                    <option value="phone">{t('customFields.dialog.formatPhone')}</option>
                  </Select>
                </Field>
                <Field label={t('customFields.dialog.minLength')} error={errs.minLength}>
                  <Input type="number" inputMode="numeric" min={0} max={2000} value={d.minLength} onChange={(e) => up({ minLength: e.target.value })} />
                </Field>
                <Field label={t('customFields.dialog.maxLength')} description={t('customFields.dialog.maxLengthHint', { n: 500 })} error={errs.maxLength}>
                  <Input type="number" inputMode="numeric" min={1} max={2000} value={d.maxLength} onChange={(e) => up({ maxLength: e.target.value })} />
                </Field>
              </div>
            )}
            {d.dataType === 'number' && (
              <div className="grid items-end gap-4 sm:grid-cols-3">
                <Field label={t('customFields.dialog.minimum')} error={errs.min}>
                  <Input type="number" inputMode="decimal" step="any" value={d.min} onChange={(e) => up({ min: e.target.value })} />
                </Field>
                <Field label={t('customFields.dialog.maximum')} error={errs.max}>
                  <Input type="number" inputMode="decimal" step="any" value={d.max} onChange={(e) => up({ max: e.target.value })} />
                </Field>
                <CheckboxField checked={d.integer} onCheckedChange={(c) => up({ integer: c === true })} label={t('customFields.dialog.integer')} />
              </div>
            )}
            {d.dataType === 'date' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('customFields.dialog.earliest')} error={errs.min}>
                  <Input type="date" value={d.min} onChange={(e) => up({ min: e.target.value })} />
                </Field>
                <Field label={t('customFields.dialog.latest')} error={errs.max}>
                  <Input type="date" value={d.max} onChange={(e) => up({ max: e.target.value })} />
                </Field>
              </div>
            )}
            {d.dataType === 'boolean' && <p className="text-sm text-fg-2">{t('customFields.dialog.booleanNoRules')}</p>}
            {d.dataType === 'enum' && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-fg-2">{t('customFields.dialog.optionsHint', { min: 1, max: 100 })}</p>
                <ul className="flex flex-col gap-2">
                  {d.options.map((o, i) => (
                    <li key={i} className="flex items-end gap-2">
                      <Field label={t('customFields.dialog.optionValue', { n: i + 1 })} className="flex-1" hideLabel={i > 0}>
                        <Input value={o.value} maxLength={100} placeholder={t('customFields.dialog.valuePlaceholder')} className="font-mono" dir="ltr" onChange={(e) => up({ options: d.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                      </Field>
                      <Field label={t('customFields.dialog.optionLabel', { n: i + 1 })} className="flex-1" hideLabel={i > 0}>
                        <Input value={o.label} maxLength={100} placeholder={t('customFields.col.label')} dir="auto" onChange={(e) => up({ options: d.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                      </Field>
                      <Button variant="ghost" size="icon" aria-label={t('customFields.dialog.removeOption', { n: i + 1 })} disabled={d.options.length === 1} onClick={() => up({ options: d.options.filter((_, j) => j !== i) })}>
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
                {errs.options && (
                  <p className="text-xs font-medium text-danger" role="alert">
                    {errs.options}
                  </p>
                )}
                <div>
                  <Button size="sm" variant="secondary" disabled={d.options.length >= 100} onClick={() => up({ options: [...d.options, { value: '', label: '' }] })}>
                    <Plus className="size-3.5" aria-hidden /> {t('customFields.dialog.addOption')}
                  </Button>
                </div>
              </div>
            )}
          </fieldset>

          <div className="flex flex-col divide-y divide-line-subtle">
            <SwitchField checked={d.publicWritable} onCheckedChange={(c) => up({ publicWritable: c })} label={t('customFields.dialog.writable')} description={t('customFields.dialog.writableHint')} />
            <SwitchField checked={d.visibleToVisitor} onCheckedChange={(c) => up({ visibleToVisitor: c })} label={t('customFields.dialog.visible')} description={t('customFields.dialog.visibleHint')} />
          </div>

          {conflict && (
            <Banner
              tone="warning"
              title={t('customFields.dialog.conflictTitle')}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void qc.invalidateQueries({ queryKey: customFieldKeys.root });
                    onOpenChange(false);
                  }}
                >
                  {t('common.reload')}
                </Button>
              }
            >
              {t('customFields.dialog.conflictBody')}
            </Banner>
          )}
          {error && !conflict && <Banner tone="danger">{error}</Banner>}
        </form>
      </DialogContent>
    </Dialog>
  );
}
