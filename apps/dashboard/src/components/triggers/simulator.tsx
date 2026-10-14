'use client';
/**
 * Simulator (ch. 21/33): builds a sample snapshot from the allowlisted fields for
 * the event, runs POST /triggers/{id}/simulate (the exact production interpreter,
 * no writes) and renders only what the API returned: the truth trace per
 * condition, collected effects in precedence order and suppressed actions.
 *
 * It simulates what is in the editor: with unsaved edits the current definition is
 * sent as `definition` (validated like a draft save, never stored; the result has
 * `revision: null`); otherwise the saved head revision is simulated by number.
 * Definition errors (422 `definition.*`) are listed here and handed to the editor so
 * the builder marks the same rows as after a failed draft save.
 */
import { CheckCircle2, CircleSlash, MinusCircle, Play, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  DSL_CUSTOM_PREFIX,
  DSL_FIELDS,
  type DslConditionTrace,
  type DslDefinition,
  type DslEvent,
  type DslFieldType,
  type DslIssue,
} from '@talkivio/contracts';
import { richT } from '@/components/integrations/rich';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  Field,
  Input,
  Select,
} from '@/components/ui';
import { isolate, useT, type Translate } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { RefData } from './condition-builder';
import {
  actionLabel,
  conditionText,
  departmentNamer,
  describeAction,
  enumLabel,
  eventLabel,
  fieldLabel,
  findField,
  formatValue,
  issueLocation,
  issuesFromFieldErrors,
  operatorLabel,
  reasonLabel,
  suppressionLabel,
  trustedCustomFields,
  localizeIssues,
  type FieldGroup,
} from './dsl-ui';
import { NumberBox, ValueList } from './inputs';
import {
  customFieldType,
  echoValue,
  fixSimulation,
  type CustomFieldDef,
  type SimulatedTrigger,
  type SimulationResult,
  type TriggerDetail,
} from './triggers-api';

interface SnapField {
  key: string;
  label: string;
  type: DslFieldType;
  enumValues?: readonly string[];
}

interface Entry {
  provided: boolean;
  value: unknown;
}

function emptyFor(f: SnapField): unknown {
  switch (f.type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'list':
      return [];
    case 'enum':
      return f.enumValues?.[0] ?? '';
    default:
      return '';
  }
}

function snapshotFields(
  t: Translate,
  event: DslEvent,
  customDefs: CustomFieldDef[] | undefined,
): SnapField[] {
  const base = DSL_FIELDS.filter((f) => !f.events || f.events.includes(event)).map((f) => ({
    key: f.key,
    label: fieldLabel(t, f.key, f.label),
    type: f.type,
    enumValues: f.enumValues,
  }));
  const custom = trustedCustomFields(customDefs).map((d) => ({
    key: `${DSL_CUSTOM_PREFIX}${d.key}`,
    label: d.label || d.key,
    type: customFieldType(d.dataType) as DslFieldType,
  }));
  return [...base, ...custom];
}

function initialEntries(fields: SnapField[], def: DslDefinition | null): Record<string, Entry> {
  const used = new Set([...(def?.all ?? []), ...(def?.any ?? [])].map((c) => c.field));
  const out: Record<string, Entry> = {};
  for (const f of fields) {
    // Fields the trigger reads start with an empty value; ids have no "empty" value so they start missing.
    const provided = used.has(f.key) && f.type !== 'id';
    out[f.key] = { provided, value: emptyFor(f) };
  }
  return out;
}

export function Simulator({
  trigger,
  definition,
  groups,
  refs,
  customDefs,
  canRun,
  onDefinitionIssues,
  onShowBuilder,
}: {
  trigger: TriggerDetail;
  /** The editor's current definition (wire form), saved or not. */
  definition: DslDefinition;
  groups: FieldGroup[];
  refs: RefData;
  customDefs: CustomFieldDef[] | undefined;
  canRun: boolean;
  /** Server-side definition issues, shown inline in the builder like a failed draft save. */
  onDefinitionIssues: (issues: DslIssue[]) => void;
  onShowBuilder: () => void;
}) {
  const t = useT();
  const saved = trigger.draft?.definition ?? trigger.published?.definition ?? null;
  const unsaved = !saved || JSON.stringify(saved) !== JSON.stringify(definition);
  const event = definition.event;
  const fields = useMemo(() => snapshotFields(t, event, customDefs), [t, event, customDefs]);
  const [entries, setEntries] = useState<Record<string, Entry>>(() => initialEntries(fields, definition));
  const [includePublished, setIncludePublished] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [defIssues, setDefIssues] = useState<{ issues: DslIssue[]; definition: DslDefinition } | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);

  const entry = (k: string, f: SnapField): Entry => entries[k] ?? { provided: false, value: emptyFor(f) };
  const setEntry = (k: string, e: Entry) => {
    setEntries((s) => ({ ...s, [k]: e }));
    if (fieldErrors[k]) setFieldErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const usedFields = new Set([...definition.all, ...definition.any].map((c) => c.field));
  const ordered = [...fields].sort((a, b) => Number(usedFields.has(b.key)) - Number(usedFields.has(a.key)));
  // Issues belong to the definition they were reported for; any edit makes them stale.
  const shownIssues = defIssues && defIssues.definition === definition ? defIssues.issues : [];

  const run = async () => {
    const local: Record<string, string> = {};
    const snapshot: Record<string, unknown> = {};
    for (const f of fields) {
      const e = entry(f.key, f);
      if (!e.provided) continue;
      if (f.type === 'number' && !Number.isFinite(e.value as number)) {
        local[f.key] = t('triggers.sim.enterNumber');
        continue;
      }
      if (f.type === 'id' && !e.value) {
        local[f.key] = t('triggers.sim.chooseValue');
        continue;
      }
      snapshot[f.key] = e.value;
    }
    setFieldErrors(local);
    if (Object.keys(local).length) {
      setError(t('triggers.sim.checkValues'));
      return;
    }
    setRunning(true);
    setError(null);
    setDefIssues(null);
    // Unsaved edits are simulated as they are; a clean editor runs the saved head revision.
    const target = unsaved ? { definition } : { revision: trigger.currentRevision };
    try {
      const r = await api.post<SimulationResult>(`/triggers/${trigger.id}/simulate`, {
        event,
        snapshot,
        ...target,
        includePublished,
      });
      setResult(fixSimulation(r));
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        const fe: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.fieldErrors))
          if (k.startsWith('snapshot.'))
            fe[k.slice('snapshot.'.length)] = v[0] ?? t('triggers.sim.invalidValue');
        setFieldErrors(fe);
        const issues = issuesFromFieldErrors(e.fieldErrors);
        if (issues.length) {
          setDefIssues({ issues, definition });
          onDefinitionIssues(issues);
        }
      }
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title={t('triggers.sim.sampleEvent')}
          description={
            unsaved
              ? t('triggers.sim.descUnsaved', { event: eventLabel(t, event) })
              : t('triggers.sim.descSaved', {
                  revision: trigger.currentRevision,
                  event: eventLabel(t, event),
                })
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-2">{t('triggers.sim.simulating')}</span>
            {unsaved ? (
              <Badge tone="warning">{t('triggers.sim.unsavedEdits')}</Badge>
            ) : (
              <Badge tone="neutral">
                {t('triggers.sim.savedRevision', { revision: trigger.currentRevision })}
              </Badge>
            )}
          </div>
          <p className="text-sm text-fg-2">
            {richT(t, 'triggers.sim.missingHelp', {
              missing: <strong className="font-semibold text-fg">{t('triggers.sim.missingWord')}</strong>,
            })}
          </p>
          <ul className="flex flex-col divide-y divide-line-subtle rounded-[var(--radius-control)] border border-line-subtle">
            {ordered.map((f) => (
              <SnapshotRow
                key={f.key}
                f={f}
                e={entry(f.key, f)}
                used={usedFields.has(f.key)}
                error={fieldErrors[f.key]}
                refs={refs}
                onChange={(e) => setEntry(f.key, e)}
              />
            ))}
          </ul>
          <CheckboxField
            label={t('triggers.sim.includeOthers')}
            description={t('triggers.sim.includeOthersHelp')}
            checked={includePublished}
            onCheckedChange={(c) => setIncludePublished(c === true)}
          />
          {shownIssues.length > 0 ? (
            <Banner
              tone="danger"
              title={error ?? t('triggers.sim.invalidDefinition')}
              action={
                <Button size="sm" variant="secondary" onClick={onShowBuilder}>
                  {t('triggers.sim.fixInBuilder')}
                </Button>
              }
            >
              <p className="mb-1.5">{t('triggers.sim.fixProblems')}</p>
              <IssueSummary issues={shownIssues} />
            </Banner>
          ) : (
            error && <Banner tone="danger">{error}</Banner>
          )}
          <div>
            <Button variant="primary" onClick={() => void run()} loading={running} disabled={!canRun}>
              <Play className="size-4" aria-hidden />
              {t('triggers.sim.run')}
            </Button>
          </div>
        </CardBody>
      </Card>
      <div aria-live="polite">
        {result && <SimulationResultView result={result} groups={groups} refs={refs} />}
      </div>
    </div>
  );
}

/** Server-reported definition problems, each with where it is in the builder. */
function IssueSummary({ issues }: { issues: DslIssue[] }) {
  const t = useT();
  return (
    <ul className="flex flex-col gap-1">
      {localizeIssues(t, issues).map((i, n) => (
        <li key={n} className="flex items-start gap-1.5 text-sm">
          <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-danger" />
          <span className="min-w-0">
            <span className="font-medium">{issueLocation(t, i.path)}:</span>{' '}
            <span dir="auto">{i.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SnapshotRow({
  f,
  e,
  used,
  error,
  refs,
  onChange,
}: {
  f: SnapField;
  e: Entry;
  used: boolean;
  error?: string;
  refs: RefData;
  onChange: (e: Entry) => void;
}) {
  const t = useT();
  const refList = f.key === 'department.id' ? refs.departments : f.key === 'site.id' ? refs.sites : undefined;
  const id = `snap-${f.key.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <li className="grid grid-cols-1 gap-2 px-3 py-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] xl:items-start xl:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{f.label}</span>
          {used && <Badge tone="primary">{t('triggers.sim.usedByTrigger')}</Badge>}
          {!e.provided && <Badge tone="warning">{t('triggers.sim.missingBadge')}</Badge>}
        </div>
        <code className="text-xs text-fg-2" dir="ltr">
          {f.key}
        </code>
        <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-[18px] accent-[var(--primary)]"
            checked={e.provided}
            onChange={(ev) => onChange({ ...e, provided: ev.target.checked })}
          />
          {t('triggers.sim.provideValue')}
        </label>
      </div>
      {e.provided ? (
        <Field label={t('triggers.sim.sampleValueFor', { field: f.label })} hideLabel error={error} id={id}>
          {f.type === 'number' ? (
            <NumberBox
              value={typeof e.value === 'number' ? e.value : Number.NaN}
              step="any"
              onChange={(v) => onChange({ ...e, value: v })}
            />
          ) : f.type === 'boolean' ? (
            <Select
              value={String(e.value === true)}
              onChange={(ev) => onChange({ ...e, value: ev.target.value === 'true' })}
            >
              <option value="true">{t('triggers.label.yesTrue')}</option>
              <option value="false">{t('triggers.label.noFalse')}</option>
            </Select>
          ) : f.type === 'enum' ? (
            <Select value={String(e.value)} onChange={(ev) => onChange({ ...e, value: ev.target.value })}>
              {(f.enumValues ?? []).map((v) => (
                <option key={v} value={v}>
                  {enumLabel(t, v)}
                </option>
              ))}
            </Select>
          ) : f.type === 'list' ? (
            <ValueList
              label={t('triggers.sim.valuesFor', { field: f.label })}
              values={Array.isArray(e.value) ? (e.value as string[]) : []}
              onChange={(v) => onChange({ ...e, value: v.map(String) })}
              placeholder={t('triggers.label.addTag')}
            />
          ) : f.type === 'id' && refList ? (
            <Select
              value={typeof e.value === 'string' ? e.value : ''}
              onChange={(ev) => onChange({ ...e, value: ev.target.value })}
            >
              <option value="">{t('triggers.label.choose')}</option>
              {refList.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={typeof e.value === 'string' ? e.value : ''}
              onChange={(ev) => onChange({ ...e, value: ev.target.value })}
              placeholder={
                f.type === 'id' ? t('triggers.label.idUuid') : t('triggers.sim.emptyTextPlaceholder')
              }
              dir="auto"
            />
          )}
        </Field>
      ) : (
        <p className="flex min-h-10 items-center text-sm text-fg-2">{t('triggers.sim.sentAsMissing')}</p>
      )}
    </li>
  );
}

function ConditionIcon({ t: trace }: { t: DslConditionTrace }) {
  if (trace.result) return <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />;
  if (trace.missing) return <MinusCircle className="size-4 shrink-0 text-warning" aria-hidden />;
  return <XCircle className="size-4 shrink-0 text-danger" aria-hidden />;
}

function conditionWord(t: Translate, trace: DslConditionTrace): string {
  if (trace.result) return t('triggers.sim.wordTrue');
  if (trace.missing) return t('triggers.sim.wordMissing');
  if (trace.error === 'type_mismatch') return t('triggers.sim.wordFalseType');
  return t('triggers.sim.wordFalse');
}

function SimulationResultView({
  result,
  groups,
  refs,
}: {
  result: SimulationResult;
  groups: FieldGroup[];
  refs: RefData;
}) {
  const t = useT();
  const names = new Map(result.triggers.map((tr) => [tr.triggerId, tr.name ?? t('triggers.sim.unnamed')]));
  const candidate = result.triggers.find((tr) => tr.candidate);
  const deptName = departmentNamer(t, (id) => refs.departments?.find((d) => d.id === id)?.name);
  const others = result.triggers.filter((tr) => !tr.candidate);
  const dry = result.writes === false;
  const resultDescription =
    result.revision === null
      ? t(dry ? 'triggers.sim.resultUnsavedDry' : 'triggers.sim.resultUnsaved', {
          event: eventLabel(t, result.event),
        })
      : t(dry ? 'triggers.sim.resultRevisionDry' : 'triggers.sim.resultRevision', {
          revision: result.revision,
          event: eventLabel(t, result.event),
        });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={t('triggers.sim.result')} description={resultDescription} />
        <CardBody className="flex flex-col gap-4">
          {candidate ? (
            <Banner
              tone={candidate.fired ? 'success' : candidate.matched ? 'warning' : 'info'}
              title={
                candidate.fired
                  ? t('triggers.sim.fires')
                  : candidate.matched
                    ? t('triggers.sim.matchesNoFire')
                    : t('triggers.sim.doesNotFire')
              }
            >
              {reasonLabel(t, candidate.reason)}
              {result.stoppedBy &&
                ` · ${t('triggers.sim.stoppedBy', { name: isolate(names.get(result.stoppedBy)) })}`}
              {result.blocked && ` · ${t('triggers.sim.admissionBlocked')}`}
            </Banner>
          ) : (
            <Banner tone="warning">{t('triggers.sim.noTrace')}</Banner>
          )}
          {candidate && <TriggerTrace t={candidate} snapshot={result.snapshot} groups={groups} open />}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('triggers.sim.effects')} description={t('triggers.sim.effectsHelp')} />
        <CardBody>
          {result.effects.length === 0 ? (
            <p className="text-sm text-fg-2">{t('triggers.sim.noEffects')}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {result.effects.map((e, i) => (
                <li
                  key={`${e.triggerId}-${e.actionIndex}`}
                  className="flex items-start gap-3 rounded-[var(--radius-control)] border border-line-subtle px-3 py-2"
                >
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success-tint text-xs font-semibold tabular text-success"
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 text-sm">
                    <p className="text-fg">{describeAction(t, e.action, { department: deptName })}</p>
                    <p className="text-xs text-fg-2">
                      {e.revision
                        ? t('triggers.sim.effectMeta', {
                            trigger: isolate(names.get(e.triggerId)),
                            n: e.actionIndex + 1,
                            revision: e.revision,
                          })
                        : t('triggers.sim.effectMetaUnsaved', {
                            trigger: isolate(names.get(e.triggerId)),
                            n: e.actionIndex + 1,
                          })}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('triggers.sim.suppressed')} description={t('triggers.sim.suppressedHelp')} />
        <CardBody>
          {result.suppressed.length === 0 ? (
            <p className="text-sm text-fg-2">{t('triggers.sim.noSuppressed')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {result.suppressed.map((s) => (
                <li
                  key={`${s.triggerId}-${s.actionIndex}`}
                  className="flex items-start gap-3 rounded-[var(--radius-control)] border border-line-subtle px-3 py-2 text-sm"
                >
                  <CircleSlash className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-fg">
                      {t('triggers.sim.suppressedMeta', {
                        trigger: isolate(names.get(s.triggerId)),
                        n: s.actionIndex + 1,
                        type: actionLabel(t, s.type),
                      })}
                    </p>
                    <p className="text-xs text-fg-2">{suppressionLabel(t, s.reason)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {others.length > 0 && (
        <Card>
          <CardHeader title={t('triggers.sim.others')} description={t('triggers.sim.othersHelp')} />
          <CardBody className="flex flex-col gap-3">
            {others.map((tr) => (
              <TriggerTrace key={tr.triggerId} t={tr} snapshot={result.snapshot} groups={groups} />
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function TriggerTrace({
  t: tr,
  snapshot,
  groups,
  open,
}: {
  t: SimulatedTrigger;
  snapshot: Record<string, unknown>;
  groups: FieldGroup[];
  open?: boolean;
}) {
  const t = useT();
  return (
    <details open={open} className="group rounded-[var(--radius-control)] border border-line-subtle">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="tabular text-fg-2">#{tr.position + 1}</span>
        <span className="font-medium text-fg" dir="auto">
          {tr.name ?? t('triggers.sim.unnamed')}
        </span>
        {tr.candidate && (
          <Badge tone="primary">
            {tr.revision
              ? t('triggers.sim.thisTriggerRev', { revision: tr.revision })
              : t('triggers.sim.thisTriggerUnsaved')}
          </Badge>
        )}
        <Badge tone="neutral">{t('triggers.sim.priorityBadge', { priority: tr.priority })}</Badge>
        <Badge
          tone={tr.fired ? 'success' : tr.matched ? 'warning' : 'neutral'}
          icon={
            tr.fired ? (
              <CheckCircle2 className="size-3.5" aria-hidden />
            ) : (
              <XCircle className="size-3.5" aria-hidden />
            )
          }
        >
          {tr.fired
            ? t('triggers.sim.fired')
            : tr.matched
              ? t('triggers.sim.matchedNotFired')
              : t('triggers.sim.notMatched')}
        </Badge>
        {tr.stopProcessing && <Badge tone="info">{t('triggers.sim.stopsProcessing')}</Badge>}
        <span className="text-xs text-fg-2">{reasonLabel(t, tr.reason)}</span>
      </summary>
      {tr.evaluated ? (
        <div className="flex flex-col gap-4 border-t border-line-subtle px-3 py-3">
          <TraceGroup
            title={t('triggers.label.groupAll')}
            result={tr.allResult}
            traces={tr.all}
            snapshot={snapshot}
            groups={groups}
            emptyText={t('triggers.sim.noAll')}
          />
          <TraceGroup
            title={t('triggers.label.groupAny')}
            result={tr.anyResult}
            traces={tr.any}
            snapshot={snapshot}
            groups={groups}
            emptyText={t('triggers.sim.noAny')}
          />
        </div>
      ) : (
        <p className="border-t border-line-subtle px-3 py-3 text-sm text-fg-2">
          {t('triggers.sim.notEvaluated')}
        </p>
      )}
    </details>
  );
}

function TraceGroup({
  title,
  result,
  traces,
  snapshot,
  groups,
  emptyText,
}: {
  title: string;
  result: boolean;
  traces: DslConditionTrace[];
  snapshot: Record<string, unknown>;
  groups: FieldGroup[];
  emptyText: string;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
        {title}
        <span className={cn('normal-case tracking-normal', result ? 'text-success' : 'text-danger')}>
          {result ? t('triggers.sim.groupTrue') : t('triggers.sim.groupFalse')}
        </span>
      </h4>
      {traces.length === 0 ? (
        <p className="text-sm text-fg-2">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {traces.map((c) => {
            const f = findField(groups, c.field);
            const actual = echoValue(snapshot, c.field);
            return (
              <li key={c.index} className="flex items-start gap-2 text-sm">
                <ConditionIcon t={c} />
                <div className="min-w-0">
                  <p className="text-fg">
                    <span className="font-medium">{conditionWord(t, c)}</span>
                    <span className="text-fg-2">: </span>
                    {conditionText(
                      t,
                      isolate(f?.label ?? c.field),
                      operatorLabel(t, c.op, f?.type ?? null),
                      c.value !== undefined ? formatValue(t, c.value) : undefined,
                    )}
                  </p>
                  <p className="text-xs text-fg-2">
                    {t('triggers.sim.actualValue', {
                      value: c.missing ? t('triggers.sim.actualMissing') : formatValue(t, actual),
                    })}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
