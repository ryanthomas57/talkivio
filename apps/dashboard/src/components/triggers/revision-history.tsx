'use client';
/**
 * Revision history (ch. 33): view any revision read-only (GET /triggers/{id}/revisions/{n})
 * with a summary of what differs from the current draft, and restore an earlier
 * revision as a NEW draft revision.
 */
import { Eye, History, Minus, Plus, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { DslAction, DslCondition, DslDefinition } from '@talkivio/contracts';
import { richT } from '@/components/integrations/rich';
import { Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, DrawerContent, EmptyState, PanelError, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT, type MessageKey, type Translate } from '@/i18n';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useAgents } from '@/lib/queries';
import type { RefData } from './condition-builder';
import { conditionText, departmentNamer, describeAction, eventLabel, fieldGroups, findField, formatValue, operatorLabel, type FieldGroup } from './dsl-ui';
import { restoreTriggerRevision } from './trigger-commands';
import { useRevision, type CustomFieldDef, type RevisionMeta, type TriggerDetail } from './triggers-api';

export function RevisionHistory({
  trigger,
  canManage,
  dirty,
  onRestored,
  refs,
  customDefs,
}: {
  trigger: TriggerDetail;
  canManage: boolean;
  dirty: boolean;
  onRestored: (d: TriggerDetail) => void;
  refs: RefData;
  customDefs: CustomFieldDef[] | undefined;
}) {
  const t = useT();
  const [restoring, setRestoring] = useState<RevisionMeta | null>(null);
  const [viewing, setViewing] = useState<RevisionMeta | null>(null);
  const agents = useAgents();
  const byUser = useMemo(() => new Map((agents.data ?? []).map((a) => [a.userId, a.displayName])), [agents.data]);
  const who = (userId: string | null) => (userId ? (byUser.get(userId) ?? t('triggers.history.formerMember')) : t('triggers.history.system'));

  return (
    <Card>
      <CardHeader title={t('triggers.history.title')} description={t('triggers.history.description')} />
      {trigger.revisions.length === 0 ? (
        <EmptyState icon={<History />} title={t('triggers.history.empty')} />
      ) : (
        <TableScroll>
          <Table className="min-w-[680px]">
            <THead>
              <tr>
                <TH>{t('triggers.history.colRevision')}</TH>
                <TH>{t('triggers.history.colState')}</TH>
                <TH>{t('triggers.history.colSaved')}</TH>
                <TH>{t('triggers.history.colPublished')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {trigger.revisions.map((r) => {
                const isHead = r.revision === trigger.currentRevision;
                return (
                  <TR key={r.revision}>
                    <TD className="font-medium tabular">{t('triggers.rev.short', { n: r.revision })}</TD>
                    <TD>
                      <RevisionState trigger={trigger} r={r} />
                    </TD>
                    <TD className="whitespace-nowrap text-sm">{formatDateTime(r.createdAt)}</TD>
                    <TD className="text-sm">
                      {r.publishedAt ? (
                        <>
                          {formatDateTime(r.publishedAt)}
                          <span className="block text-xs text-fg-2">{t('triggers.history.by', { name: isolate(who(r.publishedBy)) })}</span>
                        </>
                      ) : (
                        <span className="text-fg-2">{t('triggers.history.notPublished')}</span>
                      )}
                    </TD>
                    <TD className="text-end">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setViewing(r)}>
                          <Eye className="size-3.5" aria-hidden />
                          {t('common.view')}
                          <span className="sr-only">{t('triggers.history.viewSr', { n: r.revision })}</span>
                        </Button>
                        {canManage && !isHead && (
                          <Button size="sm" variant="secondary" onClick={() => setRestoring(r)}>
                            <RotateCcw className="size-3.5" aria-hidden />
                            {t('triggers.history.restoreAsDraft')}
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        {viewing && (
          <RevisionDrawer
            trigger={trigger}
            meta={viewing}
            who={who}
            dirty={dirty}
            refs={refs}
            customDefs={customDefs}
            onRestore={
              canManage && viewing.revision !== trigger.currentRevision
                ? () => {
                    setRestoring(viewing);
                    setViewing(null);
                  }
                : undefined
            }
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(o) => !o && setRestoring(null)}
        title={restoring ? t('triggers.history.restoreTitle', { n: restoring.revision }) : ''}
        description={restoring ? t(dirty ? 'triggers.history.restoreBodyDirty' : 'triggers.history.restoreBody', { n: restoring.revision, name: isolate(trigger.name) }) : ''}
        confirmLabel={t('triggers.history.restoreAsDraft')}
        onConfirm={async () => {
          if (!restoring) return;
          const d = await restoreTriggerRevision(trigger.id, restoring.revision);
          toast.success(t('triggers.history.restored', { from: restoring.revision, to: d.currentRevision }));
          onRestored(d);
        }}
      />
    </Card>
  );
}

function RevisionState({ trigger, r }: { trigger: TriggerDetail; r: RevisionMeta }) {
  const t = useT();
  const isHead = r.revision === trigger.currentRevision;
  const isLive = r.revision === trigger.publishedRevision;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {isLive && <Badge tone={trigger.enabled ? 'success' : 'neutral'}>{trigger.enabled ? t('triggers.history.stateRunning') : t('triggers.history.stateDisabled')}</Badge>}
      {isHead && !r.publishedAt && <Badge tone="warning">{t('triggers.history.stateCurrentDraft')}</Badge>}
      {isHead && r.publishedAt && !isLive && <Badge tone="info">{t('triggers.history.stateCurrent')}</Badge>}
      {!isLive && !isHead && r.publishedAt && <Badge tone="neutral">{t('triggers.history.statePreviouslyPublished')}</Badge>}
      {!isLive && !isHead && !r.publishedAt && <span className="text-sm text-fg-2">{t('triggers.status.draft')}</span>}
    </span>
  );
}

// ───────────────────────── Read-only revision view ─────────────────────────

function RevisionDrawer({
  trigger,
  meta,
  who,
  dirty,
  refs,
  customDefs,
  onRestore,
}: {
  trigger: TriggerDetail;
  meta: RevisionMeta;
  who: (userId: string | null) => string;
  dirty: boolean;
  refs: RefData;
  customDefs: CustomFieldDef[] | undefined;
  onRestore?: () => void;
}) {
  const t = useT();
  const q = useRevision(trigger.id, meta.revision);
  const isHead = meta.revision === trigger.currentRevision;
  const current = trigger.draft?.definition ?? trigger.published?.definition ?? null;
  const def = q.data?.definition ?? null;
  const groups = useMemo(() => fieldGroups(t, def?.event ?? trigger.event, customDefs), [t, def?.event, trigger.event, customDefs]);
  const names = useMemo(() => namesFor(t, refs), [t, refs]);

  return (
    <DrawerContent title={t('triggers.history.drawerTitle', { n: meta.revision })} description={t('triggers.history.drawerDescription', { name: isolate(trigger.name), date: formatDateTime(meta.createdAt) })} width={640}>
      <div className="flex flex-col gap-6 p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <RevisionState trigger={trigger} r={meta} />
          {meta.publishedAt && <span className="text-fg-2">{t('triggers.history.publishedBy', { date: formatDateTime(meta.publishedAt), name: isolate(who(meta.publishedBy)) })}</span>}
        </div>
        {q.isPending ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : q.isError || !def ? (
          <PanelError message={t('triggers.history.loadError', { n: meta.revision, error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <section aria-labelledby="rev-diff" className="flex flex-col gap-3">
              <h3 id="rev-diff" className="text-sm font-semibold text-fg">
                {t('triggers.history.compared')}
              </h3>
              {isHead ? (
                <p className="text-sm text-fg-2">{dirty ? t('triggers.history.isCurrentDirty') : t('triggers.history.isCurrent')}</p>
              ) : !current ? (
                <p className="text-sm text-fg-2">{t('triggers.history.noCurrent')}</p>
              ) : (
                <>
                  {dirty && <Banner tone="info">{t('triggers.history.comparedSaved', { n: trigger.currentRevision })}</Banner>}
                  <DiffSummary from={def} to={current} revision={meta.revision} head={trigger.currentRevision} groups={groups} names={names} />
                </>
              )}
            </section>
            <DefinitionView def={def} groups={groups} names={names} />
          </>
        )}
      </div>
      {onRestore && (
        <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-line-subtle bg-surface px-5 py-4">
          <Button variant="secondary" onClick={onRestore} disabled={!def}>
            <RotateCcw className="size-4" aria-hidden />
            {t('triggers.history.restoreAsDraftEllipsis')}
          </Button>
        </div>
      )}
    </DrawerContent>
  );
}

interface Names {
  department: (id: string | null) => string;
  site: (id: string) => string;
}

function namesFor(t: Translate, refs: RefData): Names {
  const dept = new Map((refs.departments ?? []).map((d) => [d.id, d.name]));
  const site = new Map((refs.sites ?? []).map((s) => [s.id, s.name]));
  return {
    department: departmentNamer(t, (id) => dept.get(id)),
    site: (id) => site.get(id) ?? t('triggers.names.unknownWebsite'),
  };
}

/** One condition in words, with department and website ids shown by name. */
function describeCondition(t: Translate, c: DslCondition, groups: FieldGroup[], names: Names): string {
  const f = findField(groups, c.field);
  const op = operatorLabel(t, c.op, f?.type ?? null);
  const named = (v: unknown) => (typeof v === 'string' && c.field === 'department.id' ? names.department(v) : typeof v === 'string' && c.field === 'site.id' ? names.site(v) : v);
  const value = c.value === undefined ? undefined : formatValue(t, Array.isArray(c.value) ? c.value.map(named) : named(c.value));
  const text = conditionText(t, isolate(f?.label ?? c.field), op, value);
  return c.ignore_case ? t('triggers.condition.ignoringCase', { condition: text }) : text;
}

function DefinitionView({ def, groups, names }: { def: DslDefinition; groups: FieldGroup[]; names: Names }) {
  const t = useT();
  return (
    <section aria-labelledby="rev-def" className="flex flex-col gap-4">
      <h3 id="rev-def" className="text-sm font-semibold text-fg">
        {t('triggers.history.definition')}
      </h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-fg-2">{t('triggers.label.event')}</dt>
        <dd className="text-fg">{eventLabel(t, def.event)}</dd>
        <dt className="text-fg-2">{t('triggers.label.priority')}</dt>
        <dd className="tabular text-fg">{def.priority}</dd>
        <dt className="text-fg-2">{t('triggers.label.cooldown')}</dt>
        <dd className="text-fg">{def.cooldown_seconds ? t('triggers.label.cooldownValue', { count: def.cooldown_seconds }) : t('common.none')}</dd>
        <dt className="text-fg-2">{t('triggers.label.afterwards')}</dt>
        <dd className="text-fg">{def.stop_processing ? t('triggers.label.stopsLower') : t('triggers.label.lowerStillRun')}</dd>
      </dl>
      <ConditionList title={t('triggers.label.matchAll')} empty={t('triggers.label.emptyAll')} items={def.all} groups={groups} names={names} />
      <ConditionList title={t('triggers.label.matchAny')} empty={t('triggers.label.emptyAny')} items={def.any} groups={groups} names={names} />
      <div className="flex flex-col gap-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-2">{t('triggers.history.actionsInOrder')}</h4>
        <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-fg">
          {def.actions.map((a, i) => (
            <li key={i} className="break-words">
              {describeAction(t, a, names)}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ConditionList({ title, empty, items, groups, names }: { title: string; empty: string; items: DslCondition[]; groups: FieldGroup[]; names: Names }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-2">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-fg-2">{empty}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-fg">
          {items.map((c, i) => (
            <li key={i} className="break-words">
              {describeCondition(t, c, groups, names)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────── Diff summary ─────────────────────────

/** Key-order independent JSON, so equal conditions/actions compare equal. */
function canonical(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(norm) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v));
}

/** Multiset difference: items of `a` that `b` does not have (duplicates counted). */
function minus<T>(a: T[], b: T[]): T[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(canonical(x), (left.get(canonical(x)) ?? 0) + 1);
  return a.filter((x) => {
    const k = canonical(x);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      return false;
    }
    return true;
  });
}

interface Change {
  kind: 'added' | 'removed' | 'changed';
  text: string;
}

const SR_PREFIX: Record<Change['kind'], MessageKey> = { added: 'triggers.diff.srAdded', removed: 'triggers.diff.srRemoved', changed: 'triggers.diff.srChanged' };

function DiffSummary({ from, to, revision, head, groups, names }: { from: DslDefinition; to: DslDefinition; revision: number; head: number; groups: FieldGroup[]; names: Names }) {
  const t = useT();
  const settings: Change[] = [];
  const setting = (label: MessageKey, a: unknown, b: unknown, fmt: (v: never) => string = (v) => String(v)) => {
    if (canonical(a) !== canonical(b)) settings.push({ kind: 'changed', text: t('triggers.diff.setting', { label: t(label), from: fmt(a as never), revision, to: fmt(b as never) }) });
  };
  setting('triggers.label.event', from.event, to.event, (v: string) => t('triggers.value.quoted', { value: eventLabel(t, v) }));
  setting('triggers.label.priority', from.priority, to.priority);
  setting('triggers.label.cooldown', from.cooldown_seconds, to.cooldown_seconds, (v: number) => (v ? t('triggers.diff.seconds', { count: formatNumber(v) }) : t('triggers.diff.none')));
  setting('triggers.label.stopProcessing', from.stop_processing, to.stop_processing, (v: boolean) => (v ? t('triggers.diff.on') : t('triggers.diff.off')));
  setting('triggers.label.dslVersion', from.dsl_version, to.dsl_version);

  const cond = (g: 'all' | 'any', label: string): Change[] => [
    ...minus(to[g], from[g]).map((c) => ({ kind: 'added' as const, text: `${label}: ${describeCondition(t, c, groups, names)}` })),
    ...minus(from[g], to[g]).map((c) => ({ kind: 'removed' as const, text: `${label}: ${describeCondition(t, c, groups, names)}` })),
  ];
  const conditions = [...cond('all', t('triggers.label.groupAll')), ...cond('any', t('triggers.label.groupAny'))];
  const addedActions = minus<DslAction>(to.actions, from.actions);
  const removedActions = minus<DslAction>(from.actions, to.actions);
  const actions: Change[] = [...addedActions.map((a) => ({ kind: 'added' as const, text: describeAction(t, a, names) })), ...removedActions.map((a) => ({ kind: 'removed' as const, text: describeAction(t, a, names) }))];
  const reordered = !addedActions.length && !removedActions.length && canonical(from.actions) !== canonical(to.actions);
  if (reordered) actions.push({ kind: 'changed', text: t('triggers.diff.reordered') });

  if (!settings.length && !conditions.length && !actions.length) return <p className="text-sm text-fg-2">{t('triggers.diff.same', { n: head })}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-2">
        {richT(t, 'triggers.diff.legend', { plus: <Plus className="inline size-3 text-success" aria-hidden />, minus: <Minus className="inline size-3 text-danger" aria-hidden /> }, { head, revision })}
      </p>
      <ChangeGroup title={t('triggers.diff.settings')} items={settings} />
      <ChangeGroup title={t('triggers.label.conditions')} items={conditions} />
      <ChangeGroup title={t('triggers.label.actions')} items={actions} />
    </div>
  );
}

function ChangeGroup({ title, items }: { title: string; items: Change[] }) {
  const t = useT();
  if (!items.length) return null;
  const added = items.filter((i) => i.kind === 'added').length;
  const removed = items.filter((i) => i.kind === 'removed').length;
  const changed = items.filter((i) => i.kind === 'changed').length;
  const counts = [added && t('triggers.diff.added', { count: added }), removed && t('triggers.diff.removed', { count: removed }), changed && t('triggers.diff.changed', { count: changed })].filter(Boolean).join(t('triggers.listSeparator'));
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-2">
        {title} <span className="font-normal normal-case tracking-normal">· {counts}</span>
      </h4>
      <ul className="flex flex-col gap-1">
        {items.map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {c.kind === 'added' ? (
              <Plus className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            ) : c.kind === 'removed' ? (
              <Minus className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            ) : (
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-fg-2 mx-[5px]" />
            )}
            <span className="min-w-0 break-words text-fg">
              <span className="sr-only">{t(SR_PREFIX[c.kind])} </span>
              {c.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
