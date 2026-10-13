'use client';
/**
 * Condition builder (ch. 32/33): one ALL group and one ANY group (DSL v1 allows a
 * single nesting level), type-aware operators and value editors. Messages come from
 * the shared validator, keyed by path (`all.0.op`).
 */
import { Plus, Trash2 } from 'lucide-react';
import { DSL_MAX_CONDITIONS, DSL_MAX_STRING, dslOperatorsFor, type DslCondition, type DslDefinition, type DslFieldType, type DslOperator, type DslScalar } from '@talkivio/contracts';
import { Badge, Button, Checkbox, Field, Input, MultiCombobox, Select } from '@/components/ui';
import { useT, type Translate } from '@/i18n';
import { cn } from '@/lib/cn';
import { defaultValue, enumLabel, findField, newCondition, operatorLabel, type FieldGroup, type FieldOption, type IssueIndex } from './dsl-ui';
import { IssueList, NumberBox, ValueList } from './inputs';

export interface RefOption {
  id: string;
  name: string;
}

export interface RefData {
  departments?: RefOption[];
  sites?: RefOption[];
  tags: string[];
}

type GroupKey = 'all' | 'any';

export function ConditionBuilder({
  def,
  onChange,
  groups,
  issues,
  refs,
  disabled,
}: {
  def: DslDefinition;
  onChange: (next: DslDefinition) => void;
  groups: FieldGroup[];
  issues: IssueIndex;
  refs: RefData;
  disabled?: boolean;
}) {
  const t = useT();
  const total = def.all.length + def.any.length;
  const setGroup = (g: GroupKey, list: DslCondition[]) => onChange({ ...def, [g]: list });
  const limitIssue = issues.at('all').find((i) => i.code === 'too_many_conditions')?.message;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2" aria-live="polite">
        <span className={cn('tabular', total > DSL_MAX_CONDITIONS && 'font-medium text-danger')}>
          {t('triggers.conditions.count', { count: total, max: DSL_MAX_CONDITIONS })}
        </span>
        <span aria-hidden>·</span>
        <span>{t('triggers.conditions.missingNote')}</span>
      </div>
      {limitIssue && <IssueList messages={[limitIssue]} />}
      <ConditionGroup
        g="all"
        title={t('triggers.label.matchAll')}
        hint={t('triggers.conditions.allHint')}
        list={def.all}
        onChange={(l) => setGroup('all', l)}
        groups={groups}
        issues={issues}
        refs={refs}
        disabled={disabled}
      />
      <ConditionGroup
        g="any"
        title={t('triggers.label.matchAny')}
        hint={t('triggers.conditions.anyHint')}
        list={def.any}
        onChange={(l) => setGroup('any', l)}
        groups={groups}
        issues={issues}
        refs={refs}
        disabled={disabled}
      />
    </div>
  );
}

function ConditionGroup({
  g,
  title,
  hint,
  list,
  onChange,
  groups,
  issues,
  refs,
  disabled,
}: {
  g: GroupKey;
  title: string;
  hint: string;
  list: DslCondition[];
  onChange: (l: DslCondition[]) => void;
  groups: FieldGroup[];
  issues: IssueIndex;
  refs: RefData;
  disabled?: boolean;
}) {
  const t = useT();
  const headingId = `cond-${g}-heading`;
  const groupIssue = issues.at(g).filter((i) => i.code !== 'too_many_conditions');
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Badge tone={g === 'all' ? 'primary' : 'info'}>{g === 'all' ? t('triggers.label.groupAll') : t('triggers.label.groupAny')}</Badge>
            {title}
          </h3>
          <p className="text-xs text-fg-2">{hint}</p>
        </div>
        {!disabled && (
          <Button size="sm" variant="secondary" onClick={() => onChange([...list, newCondition(groups)])}>
            <Plus className="size-3.5" aria-hidden />
            {t('triggers.conditions.add')}
          </Button>
        )}
      </div>
      <IssueList messages={groupIssue.map((i) => i.message)} />
      {list.length === 0 ? (
        <p className="rounded-[var(--radius-control)] border border-dashed border-line px-3 py-3 text-sm text-fg-2">{g === 'all' ? t('triggers.label.emptyAll') : t('triggers.label.emptyAny')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {list.map((c, i) => (
            <ConditionRow
              key={i}
              path={`${g}.${i}`}
              label={t('triggers.conditions.rowLabel', { group: g, n: i + 1 })}
              cond={c}
              groups={groups}
              issues={issues}
              refs={refs}
              disabled={disabled}
              onChange={(next) => onChange(list.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(list.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function ConditionRow({
  path,
  label,
  cond,
  groups,
  issues,
  refs,
  disabled,
  onChange,
  onRemove,
}: {
  path: string;
  label: string;
  cond: DslCondition;
  groups: FieldGroup[];
  issues: IssueIndex;
  refs: RefData;
  disabled?: boolean;
  onChange: (c: DslCondition) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const field = findField(groups, cond.field);
  const type: DslFieldType | null = field?.type ?? null;
  const ops: readonly DslOperator[] = type ? dslOperatorsFor(type) : [];
  const opAllowed = ops.includes(cond.op);
  const rowIssues = issues.under(path).map((i) => i.message);
  const fieldErr = issues.first(`${path}.field`);
  const opErr = issues.first(`${path}.op`);
  const valueErr = issues.firstUnder(`${path}.value`);
  const icErr = issues.first(`${path}.ignore_case`);
  const noValue = cond.op === 'exists' || cond.op === 'missing';
  const textual = type === 'string' || type === 'list';

  const setField = (key: string) => {
    const next = findField(groups, key);
    if (!next) return onChange({ field: key, op: cond.op });
    // Keep the chosen operator: if it is illegal for the new type the validator says so next to the row.
    const op = cond.op;
    const out: DslCondition = { field: key, op };
    const v = defaultValue(next.type, op, next.enumValues);
    if (v !== undefined) out.value = v;
    if (cond.ignore_case && (next.type === 'string' || next.type === 'list')) out.ignore_case = true;
    onChange(out);
  };

  const setOp = (op: DslOperator) => {
    const out: DslCondition = { field: cond.field, op };
    const wasList = cond.op === 'in' || cond.op === 'not_in';
    const isList = op === 'in' || op === 'not_in';
    const numericOp = ['gt', 'gte', 'lt', 'lte'].includes(op);
    if (op !== 'exists' && op !== 'missing') {
      // Carry the operand over when its shape still fits; otherwise start from the type's default.
      const keep = cond.value !== undefined && wasList === isList && (!numericOp || typeof cond.value === 'number');
      out.value = keep ? cond.value : type ? defaultValue(type, op, field?.enumValues) : '';
      if (isList && !wasList && cond.value !== undefined && cond.value !== '' && !Array.isArray(cond.value)) out.value = [cond.value as DslScalar];
    }
    if (cond.ignore_case) out.ignore_case = true;
    onChange(out);
  };

  return (
    <li className={cn('rounded-[var(--radius-control)] border bg-surface-2 p-3', rowIssues.length ? 'border-danger/50' : 'border-line-subtle')} aria-label={label}>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_auto] xl:items-start">
        <Field label={t('triggers.conditions.field')} error={fieldErr}>
          <Select value={cond.field} onChange={(e) => setField(e.target.value)} disabled={disabled}>
            {!field && <option value={cond.field}>{t('triggers.conditions.unknownField', { field: cond.field })}</option>}
            {groups.map((g) => (
              <optgroup key={g.id} label={g.label}>
                {g.fields.map((f) => (
                  <option key={f.key} value={f.key} disabled={f.unavailable && f.key !== cond.field}>
                    {f.unavailable ? t('triggers.label.unavailableForEvent', { label: f.label }) : f.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label={t('triggers.conditions.operator')} error={opErr}>
          <Select value={cond.op} onChange={(e) => setOp(e.target.value as DslOperator)} disabled={disabled}>
            {!opAllowed && <option value={cond.op}>{t('triggers.conditions.opNotAllowed', { op: operatorLabel(t, cond.op, type) })}</option>}
            {ops.map((op) => (
              <option key={op} value={op}>
                {operatorLabel(t, op, type)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('triggers.conditions.value')} error={valueErr}>
          {noValue ? (
            <p className="flex h-10 items-center text-sm text-fg-2">{t('triggers.conditions.noValue')}</p>
          ) : (
            <ValueEditor cond={cond} field={field} refs={refs} disabled={disabled} onChange={(value) => onChange({ ...cond, value })} />
          )}
        </Field>
        <div className="flex items-end justify-end gap-2 xl:h-full xl:flex-col xl:items-end xl:justify-start xl:pt-6">
          {!disabled && (
            <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t('triggers.conditions.remove', { label })}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {textual && !noValue && (
        <div className="mt-2 flex min-h-11 items-center gap-2">
          <Checkbox
            id={`${path}-ic`}
            checked={!!cond.ignore_case}
            disabled={disabled}
            aria-invalid={!!icErr || undefined}
            onCheckedChange={(c) => {
              const { ignore_case: _drop, ...rest } = cond;
              onChange(c === true ? { ...rest, ignore_case: true } : rest);
            }}
          />
          <label htmlFor={`${path}-ic`} className="text-sm text-fg">
            {t('triggers.conditions.ignoreCase')}
          </label>
        </div>
      )}
      {/* Messages not already shown under a specific control (e.g. unknown keys). */}
      <IssueList messages={rowIssues.filter((m) => m !== fieldErr && m !== opErr && m !== valueErr)} />
    </li>
  );
}

function ValueEditor({ cond, field, refs, disabled, onChange }: { cond: DslCondition; field: FieldOption | null; refs: RefData; disabled?: boolean; onChange: (v: DslCondition['value']) => void }) {
  const t = useT();
  const type = field?.type ?? 'string';
  const isList = cond.op === 'in' || cond.op === 'not_in';
  const numericOp = ['gt', 'gte', 'lt', 'lte'].includes(cond.op);
  const refList = cond.field === 'department.id' ? refs.departments : cond.field === 'site.id' ? refs.sites : undefined;

  if (numericOp || (type === 'number' && !isList)) {
    return <NumberBox value={typeof cond.value === 'number' ? cond.value : Number.NaN} onChange={onChange} step="any" disabled={disabled} inputClassName="w-full" className="w-full" />;
  }
  if (isList) {
    const values = Array.isArray(cond.value) ? cond.value : [];
    if (type === 'id' && refList) {
      return (
        <MultiCombobox
          values={values.map(String)}
          onChange={(v) => onChange(v)}
          options={refList.map((r) => ({ value: r.id, label: r.name }))}
          placeholder={cond.field === 'site.id' ? t('triggers.conditions.chooseWebsites') : t('triggers.conditions.chooseDepartments')}
          searchPlaceholder={t('triggers.combo.search')}
          emptyText={t('triggers.combo.empty')}
          disabled={disabled}
        />
      );
    }
    if (type === 'enum') {
      return (
        <MultiCombobox
          values={values.map(String)}
          onChange={(v) => onChange(v)}
          options={(field?.enumValues ?? []).map((e) => ({ value: e, label: enumLabel(t, e), keywords: [e] }))}
          placeholder={t('triggers.conditions.chooseValues')}
          searchPlaceholder={t('triggers.combo.search')}
          emptyText={t('triggers.combo.empty')}
          disabled={disabled}
        />
      );
    }
    return <ValueList label={t('triggers.conditions.values')} values={values} numeric={type === 'number'} onChange={(v) => onChange(v)} disabled={disabled} placeholder={cond.field === 'visitor.tags' ? t('triggers.label.addTag') : undefined} />;
  }
  if (type === 'boolean') {
    return (
      <Select value={typeof cond.value === 'boolean' ? String(cond.value) : ''} onChange={(e) => onChange(e.target.value === 'true')} disabled={disabled}>
        {typeof cond.value !== 'boolean' && <option value="">{t('triggers.label.choose')}</option>}
        <option value="true">{t('triggers.label.yesTrue')}</option>
        <option value="false">{t('triggers.label.noFalse')}</option>
      </Select>
    );
  }
  if (type === 'enum') {
    return (
      <Select value={typeof cond.value === 'string' ? cond.value : ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {!(field?.enumValues ?? []).includes(String(cond.value)) && <option value="">{t('triggers.label.choose')}</option>}
        {(field?.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {enumLabel(t, v)}
          </option>
        ))}
      </Select>
    );
  }
  if (type === 'id' && refList) {
    const known = refList.some((r) => r.id === cond.value);
    return (
      <Select value={known ? String(cond.value) : ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {!known && <option value="">{cond.value ? t('triggers.label.unknownChooseAgain') : t('triggers.label.choose')}</option>}
        {refList.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      value={typeof cond.value === 'string' ? cond.value : cond.value === undefined ? '' : String(cond.value)}
      onChange={(e) => onChange(e.target.value)}
      maxLength={DSL_MAX_STRING + 100}
      disabled={disabled}
      list={cond.field === 'visitor.tags' ? TAG_DATALIST_ID : undefined}
      placeholder={placeholderFor(t, cond.field)}
      dir="auto"
    />
  );
}

/** One shared <datalist> of existing tag slugs, rendered once by the editor. */
export const TAG_DATALIST_ID = 'trigger-tag-options';

export function TagDatalist({ tags }: { tags: string[] }) {
  return (
    <datalist id={TAG_DATALIST_ID}>
      {tags.map((tag) => (
        <option key={tag} value={tag} />
      ))}
    </datalist>
  );
}

/** Sample operands (codes, not copy) shown as placeholders. */
const SAMPLE_PATH = '/pricing';
const SAMPLE_ORIGIN = 'https://www.google.com';
const SAMPLE_COUNTRY = 'DE';
const SAMPLE_TAG = 'tag-slug';

function placeholderFor(t: Translate, field: string): string | undefined {
  switch (field) {
    case 'page.path':
      return SAMPLE_PATH;
    case 'referrer.origin':
      return SAMPLE_ORIGIN;
    case 'visitor.country':
      return t('triggers.conditions.countryPlaceholder', { example: SAMPLE_COUNTRY });
    case 'visitor.tags':
      return SAMPLE_TAG;
    case 'site.id':
    case 'department.id':
      return t('triggers.label.idUuid');
    default:
      return undefined;
  }
}
