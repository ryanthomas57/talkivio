'use client';
/**
 * Ordered action list (≤ 20, ch. 32) with per-type forms. Order matters for
 * precedence (first winning set_department/set_priority, tag actions in order), so
 * rows move with keyboard-accessible Move up / Move down buttons.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { DSL_ACTION_TYPES, DSL_MAX_ACTIONS, DSL_MAX_STRING, type DslAction, type DslActionType, type DslDefinition, type DslEvent } from '@talkivio/contracts';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { TAG_DATALIST_ID, type RefData } from './condition-builder';
import { actionAvailable, actionLabel, newAction, type IssueIndex } from './dsl-ui';
import { CharCount, IssueList, NumberBox } from './inputs';
import { customFieldType, type CustomFieldDef } from './triggers-api';

export function ActionList({
  def,
  onChange,
  issues,
  refs,
  customDefs,
  disabled,
}: {
  def: DslDefinition;
  onChange: (next: DslDefinition) => void;
  issues: IssueIndex;
  refs: RefData;
  customDefs: CustomFieldDef[] | undefined;
  disabled?: boolean;
}) {
  const t = useT();
  const [announce, setAnnounce] = useState('');
  const actions = def.actions;
  const set = (list: DslAction[]) => onChange({ ...def, actions: list });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= actions.length) return;
    const next = [...actions];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set(next);
    setAnnounce(t('triggers.actions.moved', { position: j + 1, count: actions.length }));
    // Keep focus on the same control of the moved row.
    requestAnimationFrame(() => document.getElementById(`action-${j}-${dir < 0 ? 'up' : 'down'}`)?.focus());
  };
  const addType = firstAvailable(def.event);
  const listIssues = issues.at('actions').map((i) => i.message);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn('text-sm tabular text-fg-2', actions.length > DSL_MAX_ACTIONS && 'font-medium text-danger')} aria-live="polite">
          {t('triggers.actions.count', { count: actions.length, max: DSL_MAX_ACTIONS })}
        </p>
        {!disabled && (
          <Button size="sm" variant="secondary" onClick={() => set([...actions, newAction(addType, def.event)])}>
            <Plus className="size-3.5" aria-hidden />
            {t('triggers.actions.add')}
          </Button>
        )}
      </div>
      <IssueList messages={listIssues} />
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {actions.length === 0 ? (
        <p className="rounded-[var(--radius-control)] border border-dashed border-line px-3 py-3 text-sm text-fg-2">{t('triggers.actions.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {actions.map((a, i) => (
            <ActionCard
              key={i}
              index={i}
              count={actions.length}
              action={a}
              event={def.event}
              issues={issues}
              refs={refs}
              customDefs={customDefs}
              disabled={disabled}
              onChange={(next) => set(actions.map((x, j) => (j === i ? next : x)))}
              onRemove={() => {
                set(actions.filter((_, j) => j !== i));
                setAnnounce(t('triggers.actions.removed', { n: i + 1 }));
              }}
              onMove={(dir) => move(i, dir)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function firstAvailable(event: DslEvent): DslActionType {
  return (['add_tag', ...DSL_ACTION_TYPES] as DslActionType[]).find((t) => actionAvailable(t, event)) ?? 'add_tag';
}

function ActionCard({
  index,
  count,
  action,
  event,
  issues,
  refs,
  customDefs,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  count: number;
  action: DslAction;
  event: DslEvent;
  issues: IssueIndex;
  refs: RefData;
  customDefs: CustomFieldDef[] | undefined;
  disabled?: boolean;
  onChange: (a: DslAction) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const t = useT();
  const path = `actions.${index}`;
  const all = issues.under(path);
  const shownKeys = new Set(['type', ...Object.keys(action)]);
  // Messages for keys without their own control (unknown keys, conflicts) render at the bottom.
  const loose = all.filter((i) => {
    const rest = i.path.slice(path.length + 1);
    return !rest || !shownKeys.has(rest.split('.')[0]!);
  });
  const err = (key: string) => issues.first(`${path}.${key}`);
  const n = index + 1;

  return (
    <li className={cn('rounded-[var(--radius-control)] border bg-surface-2 p-3', all.length ? 'border-danger/50' : 'border-line-subtle')} aria-label={t('triggers.actions.cardLabel', { n, type: actionLabel(t, action.type) })}>
      <div className="flex flex-wrap items-end gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center self-center rounded-full bg-surface-3 text-xs font-semibold tabular text-fg-2" aria-hidden>
          {index + 1}
        </span>
        <Field label={t('triggers.actions.typeLabel', { n })} error={err('type')} className="min-w-[200px] flex-1">
          <Select value={action.type} disabled={disabled} onChange={(e) => onChange(newAction(e.target.value as DslActionType, event))}>
            {DSL_ACTION_TYPES.map((type) => (
              <option key={type} value={type} disabled={!actionAvailable(type, event) && type !== action.type}>
                {actionAvailable(type, event) ? actionLabel(t, type) : t('triggers.label.unavailableForEvent', { label: actionLabel(t, type) })}
              </option>
            ))}
          </Select>
        </Field>
        {!disabled && (
          <div className="flex items-center gap-1">
            <Button id={`action-${index}-up`} variant="ghost" size="icon" onClick={() => onMove(-1)} disabled={index === 0} aria-label={t('triggers.actions.moveUp', { n })}>
              <ArrowUp className="size-4" aria-hidden />
            </Button>
            <Button id={`action-${index}-down`} variant="ghost" size="icon" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={t('triggers.actions.moveDown', { n })}>
              <ArrowDown className="size-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t('triggers.actions.remove', { n })}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ActionFields action={action} err={err} refs={refs} customDefs={customDefs} disabled={disabled} onChange={onChange} />
      </div>
      <div className="mt-2">
        <IssueList messages={loose.map((i) => i.message)} />
      </div>
    </li>
  );
}

function DepartmentSelect({ value, onChange, refs, disabled, allowNone }: { value: string | null; onChange: (v: string | null) => void; refs: RefData; disabled?: boolean; allowNone?: string }) {
  const t = useT();
  if (!refs.departments) {
    return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} placeholder={t('triggers.actions.departmentIdPlaceholder')} dir="ltr" />;
  }
  const known = !!value && refs.departments.some((d) => d.id === value);
  return (
    <Select value={known ? value! : ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
      {allowNone ? <option value="">{allowNone}</option> : !known && <option value="">{value ? t('triggers.label.unknownChooseAgain') : t('triggers.actions.chooseDepartment')}</option>}
      {refs.departments.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </Select>
  );
}

/** Sample values (codes, not copy). */
const FIELD_KEY_SAMPLE = 'field_key';
const WEBHOOK_EVENT_SAMPLE = 'lead.qualified';

function ActionFields({ action, err, refs, customDefs, disabled, onChange }: { action: DslAction; err: (k: string) => string | undefined; refs: RefData; customDefs: CustomFieldDef[] | undefined; disabled?: boolean; onChange: (a: DslAction) => void }) {
  const t = useT();
  switch (action.type) {
    case 'set_department':
      return (
        <Field label={t('triggers.label.department')} error={err('department_id')} className="lg:col-span-2" description={t('triggers.actions.departmentHelp')}>
          <DepartmentSelect value={action.department_id || null} onChange={(v) => onChange({ ...action, department_id: v ?? '' })} refs={refs} disabled={disabled} />
        </Field>
      );
    case 'set_priority':
      return (
        <Field label={t('triggers.actions.queuePriority')} error={err('priority')} description={t('triggers.actions.queuePriorityHelp')}>
          <NumberBox value={action.priority} min={0} max={100} onChange={(v) => onChange({ ...action, priority: v })} disabled={disabled} />
        </Field>
      );
    case 'add_tag':
    case 'remove_tag':
      return (
        <>
          <Field label={t('triggers.actions.tag')} error={err('tag')} description={t('triggers.actions.tagHelp')}>
            <Input value={action.tag} onChange={(e) => onChange({ ...action, tag: e.target.value })} list={TAG_DATALIST_ID} maxLength={80} disabled={disabled} dir="ltr" />
          </Field>
          <Field label={t('triggers.actions.applyTo')} error={err('target')}>
            <Select value={action.target} onChange={(e) => onChange({ ...action, target: e.target.value as 'chat' | 'visitor' })} disabled={disabled}>
              <option value="chat">{t('triggers.actions.theChat')}</option>
              <option value="visitor">{t('triggers.actions.theVisitor')}</option>
            </Select>
          </Field>
        </>
      );
    case 'send_public_message':
      return (
        <>
          <Field label={t('triggers.actions.message')} error={err('text')} className="lg:col-span-2" description={t('triggers.actions.messageHelp')}>
            <div className="flex flex-col gap-1">
              <Textarea value={action.text} onChange={(e) => onChange({ ...action, text: e.target.value })} rows={3} disabled={disabled} dir="auto" />
              <CharCount value={action.text} max={DSL_MAX_STRING} />
            </div>
          </Field>
          <Field label={t('triggers.actions.attribution')} error={err('attribution')} description={t('triggers.actions.attributionHelp')}>
            <Input value={action.attribution} onChange={(e) => onChange({ ...action, attribution: e.target.value })} maxLength={120} disabled={disabled} dir="auto" />
          </Field>
        </>
      );
    case 'display_invitation':
      return (
        <>
          <Field label={t('triggers.actions.invitationMessage')} error={err('message')} className="lg:col-span-2">
            <div className="flex flex-col gap-1">
              <Textarea value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })} rows={2} disabled={disabled} dir="auto" />
              <CharCount value={action.message} max={500} />
            </div>
          </Field>
          <Field label={t('triggers.actions.attribution')} error={err('attribution')} description={t('triggers.actions.invitationAttributionHelp')}>
            <Input value={action.attribution} onChange={(e) => onChange({ ...action, attribution: e.target.value })} maxLength={120} disabled={disabled} dir="auto" />
          </Field>
          <Field label={t('triggers.actions.invitationDepartment')} error={err('department_id')} description={t('triggers.actions.invitationDepartmentHelp')}>
            <DepartmentSelect value={action.department_id} onChange={(v) => onChange({ ...action, department_id: v })} refs={refs} disabled={disabled} allowNone={t('triggers.actions.siteDefault')} />
          </Field>
          <Field label={t('triggers.actions.expiresAfter')} error={err('expires_in_seconds')} description={t('triggers.actions.expiresAfterHelp')}>
            <NumberBox value={action.expires_in_seconds} min={30} max={3600} suffix={t('triggers.label.seconds')} onChange={(v) => onChange({ ...action, expires_in_seconds: v })} disabled={disabled} />
          </Field>
          <Field label={t('triggers.actions.maxPerSession')} error={err('max_per_session')} description={t('triggers.actions.maxPerSessionHelp')}>
            <NumberBox value={action.max_per_session} min={1} max={5} onChange={(v) => onChange({ ...action, max_per_session: v })} disabled={disabled} />
          </Field>
          <Field label={t('triggers.actions.dismissWait')} error={err('dismiss_cooldown_hours')} description={t('triggers.actions.dismissWaitHelp')}>
            <NumberBox value={action.dismiss_cooldown_hours} min={0} max={720} suffix={t('triggers.label.hours')} onChange={(v) => onChange({ ...action, dismiss_cooldown_hours: v })} disabled={disabled} />
          </Field>
        </>
      );
    case 'set_visitor_field': {
      const defs = (customDefs ?? []).filter((d) => !d.archivedAt);
      const def = defs.find((d) => d.key === action.key);
      const ftype = def ? customFieldType(def.dataType) : typeof action.value === 'number' ? 'number' : typeof action.value === 'boolean' ? 'boolean' : 'string';
      const clear = action.value === null;
      return (
        <>
          <Field label={t('triggers.actions.customField')} error={err('key')}>
            {customDefs ? (
              <Select
                value={def ? action.key : ''}
                onChange={(e) => {
                  const next = defs.find((d) => d.key === e.target.value);
                  const nt = next ? customFieldType(next.dataType) : 'string';
                  onChange({ ...action, key: e.target.value, value: nt === 'number' ? 0 : nt === 'boolean' ? true : '' });
                }}
                disabled={disabled}
              >
                <option value="">{defs.length ? t('triggers.actions.chooseField') : t('triggers.actions.noCustomFields')}</option>
                {defs.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label || d.key} ({d.key})
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={action.key} onChange={(e) => onChange({ ...action, key: e.target.value })} disabled={disabled} placeholder={FIELD_KEY_SAMPLE} dir="ltr" />
            )}
          </Field>
          <Field label={t('triggers.actions.newValue')} error={err('value')}>
            <div className="flex flex-col gap-2">
              {!clear &&
                (ftype === 'number' ? (
                  <NumberBox value={typeof action.value === 'number' ? action.value : Number.NaN} step="any" onChange={(v) => onChange({ ...action, value: v })} disabled={disabled} />
                ) : ftype === 'boolean' ? (
                  <Select value={String(action.value === true)} onChange={(e) => onChange({ ...action, value: e.target.value === 'true' })} disabled={disabled}>
                    <option value="true">{t('triggers.label.yesTrue')}</option>
                    <option value="false">{t('triggers.label.noFalse')}</option>
                  </Select>
                ) : (
                  <Input value={typeof action.value === 'string' ? action.value : ''} onChange={(e) => onChange({ ...action, value: e.target.value })} disabled={disabled} dir="auto" />
                ))}
              <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  className="size-[18px] accent-[var(--primary)]"
                  checked={clear}
                  disabled={disabled}
                  onChange={(e) => onChange({ ...action, value: e.target.checked ? null : ftype === 'number' ? 0 : ftype === 'boolean' ? true : '' })}
                />
                {t('triggers.actions.clearField')}
              </label>
            </div>
          </Field>
        </>
      );
    }
    case 'notify_department':
      return (
        <>
          <Field label={t('triggers.label.department')} error={err('department_id')}>
            <DepartmentSelect value={action.department_id || null} onChange={(v) => onChange({ ...action, department_id: v ?? '' })} refs={refs} disabled={disabled} />
          </Field>
          <Field label={t('triggers.actions.notificationText')} error={err('text')} description={t('triggers.actions.notificationTextHelp')}>
            <Input value={action.text} onChange={(e) => onChange({ ...action, text: e.target.value })} maxLength={600} disabled={disabled} dir="auto" />
          </Field>
        </>
      );
    case 'create_webhook_job':
      return (
        <Field label={t('triggers.actions.webhookEventName')} error={err('event_name')} className="lg:col-span-2" description={t('triggers.actions.webhookEventNameHelp', { example: isolate(WEBHOOK_EVENT_SAMPLE) })}>
          <Input value={action.event_name} onChange={(e) => onChange({ ...action, event_name: e.target.value })} maxLength={80} disabled={disabled} dir="ltr" />
        </Field>
      );
    case 'block_admission':
      return (
        <Field label={t('triggers.actions.blockReason')} error={err('reason')} className="lg:col-span-2" description={t('triggers.actions.blockReasonHelp')}>
          <Input value={action.reason} onChange={(e) => onChange({ ...action, reason: e.target.value })} maxLength={240} disabled={disabled} dir="auto" />
        </Field>
      );
  }
}
