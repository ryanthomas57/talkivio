'use client';
/**
 * Settings → Audit log (ch. 54). Filters live in the URL; the table pages by
 * cursor; the CSV export link uses exactly the same filters (and the export itself
 * is audited server side). Safe diffs render as key/value rows, never raw JSON.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleCheck, CircleX, ClipboardList, Download, Filter, ShieldAlert, ShieldOff } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, Banner, Button, Card, Combobox, EmptyState, Field, Input, Page, PageHeader, PanelError, Select, Skeleton, Table, TableScroll, TD, TH, THead, TR, type BadgeTone, type ComboOption } from '@/components/ui';
import { isolate, useT, type MessageKey, type Translate } from '@/i18n';
import { api, errorMessage, type Query } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useAgents } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { DiffView, fieldLabel } from './diff-view';

interface AuditEvent {
  id: string;
  occurredAt: string;
  actor: { type: string; id: string | null; name: string | null };
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  safeDiff: unknown;
  requestId: string | null;
}

interface TokenRef {
  id: string;
  name: string;
  prefix: string;
}

/** Object types Talkivio records (from the API's audit call sites). Unknown values from the URL are kept. */
const OBJECT_TYPES = [
  'attachment',
  'audit_log',
  'ban',
  'canned_reply',
  'chat',
  'connector',
  'custom_field',
  'department',
  'emergency_closure',
  'export',
  'integration_token',
  'invitation',
  'job',
  'membership',
  'offline_submission',
  'privacy_request',
  'retention',
  'schedule',
  'site',
  'tag',
  'tenant',
  'trigger',
  'visitor',
  'webhook_delivery',
  'webhook_endpoint',
];
const ACTION_PREFIXES = ['agent', 'analytics', 'attachment', 'audit', 'authorization', 'ban', 'chat', 'custom_field', 'department', 'emergency_closure', 'export', 'integration_token', 'offline_submission', 'privacy', 'retention', 'schedule', 'shortcut', 'site', 'tag', 'tenant', 'transcript', 'trigger', 'visitor', 'webhook', 'widget'];
const ACTION_RE = /^[a-z0-9_.]+(\.\*)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const OUTCOME: Record<string, { label: MessageKey; tone: BadgeTone; Icon: typeof CircleCheck }> = {
  success: { label: 'audit.outcome.success', tone: 'success', Icon: CircleCheck },
  failure: { label: 'audit.outcome.failure', tone: 'danger', Icon: CircleX },
  denied: { label: 'audit.outcome.denied', tone: 'warning', Icon: ShieldAlert },
};

const OBJECT_TYPE_LABEL: Record<string, MessageKey> = {
  attachment: 'audit.objectType.attachment',
  audit_log: 'audit.objectType.auditLog',
  ban: 'audit.objectType.ban',
  canned_reply: 'audit.objectType.cannedReply',
  chat: 'audit.objectType.chat',
  connector: 'audit.objectType.connector',
  custom_field: 'audit.objectType.customField',
  department: 'audit.objectType.department',
  emergency_closure: 'audit.objectType.emergencyClosure',
  export: 'audit.objectType.export',
  integration_token: 'audit.objectType.integrationToken',
  invitation: 'audit.objectType.invitation',
  job: 'audit.objectType.job',
  membership: 'audit.objectType.membership',
  offline_submission: 'audit.objectType.offlineSubmission',
  privacy_request: 'audit.objectType.privacyRequest',
  retention: 'audit.objectType.retention',
  schedule: 'audit.objectType.schedule',
  site: 'audit.objectType.site',
  tag: 'audit.objectType.tag',
  tenant: 'audit.objectType.tenant',
  trigger: 'audit.objectType.trigger',
  user: 'audit.objectType.user',
  visitor: 'audit.objectType.visitor',
  webhook_delivery: 'audit.objectType.webhookDelivery',
  webhook_endpoint: 'audit.objectType.webhookEndpoint',
};

const ROLE_LABEL: Record<string, MessageKey> = {
  owner: 'audit.role.owner',
  admin: 'audit.role.admin',
  supervisor: 'audit.role.supervisor',
  agent: 'audit.role.agent',
  analyst: 'audit.role.analyst',
};

/** Known object types are translated; unknown codes from the server fall back to a humanized key. */
function objectTypeLabel(t: Translate, type: string): string {
  const key = OBJECT_TYPE_LABEL[type];
  return key ? t(key) : fieldLabel(type);
}

function actorTypeLabel(t: Translate, type: string): string {
  if (type === 'integration_token') return t('audit.actorType.apiToken');
  if (type === 'system') return t('audit.actorType.system');
  if (type === 'anonymous') return t('audit.actorType.anonymous');
  return objectTypeLabel(t, type);
}

/** Local calendar day → instant at local midnight (optionally the next day, for an exclusive upper bound). */
function dayStart(day: string, plusDays = 0): string | undefined {
  if (!DAY_RE.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + plusDays).toISOString();
}

/** "webhook" → "webhook.*", "webhook." → "webhook.*"; exact names stay exact. */
function normalizeAction(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v) return '';
  if (v.endsWith('.*')) return v;
  if (v.endsWith('.')) return `${v}*`;
  if (!v.includes('.')) return `${v}.*`;
  return v;
}

export function AuditLog() {
  const t = useT();
  const canView = useCan('audit.view');
  const canTokens = useCan('integrations.manage');
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const from = DAY_RE.test(sp.get('from') ?? '') ? sp.get('from')! : '';
  const to = DAY_RE.test(sp.get('to') ?? '') ? sp.get('to')! : '';
  const actor = UUID_RE.test(sp.get('actor') ?? '') ? sp.get('actor')! : '';
  const actionParam = sp.get('action') ?? '';
  const action = ACTION_RE.test(actionParam) ? actionParam : '';
  const objectType = /^[a-z0-9_]+$/.test(sp.get('type') ?? '') ? sp.get('type')! : '';
  const outcome = OUTCOME[sp.get('outcome') ?? ''] ? sp.get('outcome')! : '';
  const rangeInvalid = !!from && !!to && from > to;

  const [actionDraft, setActionDraft] = useState(action);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => setActionDraft(action), [action]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [seenActors, setSeenActors] = useState<Map<string, string>>(new Map());

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
  };

  const query: Query = useMemo(
    () => ({ from: from ? dayStart(from) : undefined, to: to ? dayStart(to, 1) : undefined, actorId: actor || undefined, action: action || undefined, objectType: objectType || undefined, outcome: outcome || undefined }),
    [from, to, actor, action, objectType, outcome],
  );

  const agents = useAgents(canView);
  const tokens = useQuery({ queryKey: ['integration-tokens', { includeRevoked: true }], queryFn: () => api.get<TokenRef[]>('/integration-tokens', { includeRevoked: 'true' }), enabled: canView && canTokens, staleTime: 60_000 });

  const q = useInfiniteQuery({
    queryKey: ['audit-events', query],
    queryFn: ({ pageParam }) => api.page<AuditEvent>('/audit-events', { ...query, cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: canView && !rangeInvalid,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  // Remember actor names seen in results so the actor filter can label them (e.g. former members).
  useEffect(() => {
    if (!items.length) return;
    setSeenActors((cur) => {
      let changed = false;
      const next = new Map(cur);
      for (const e of items)
        if (e.actor.id && e.actor.name && !next.has(e.actor.id)) {
          next.set(e.actor.id, e.actor.name);
          changed = true;
        }
      return changed ? next : cur;
    });
  }, [items]);

  const actorOptions: ComboOption[] = useMemo(() => {
    const opts = new Map<string, ComboOption>();
    for (const a of agents.data ?? []) opts.set(a.userId, { value: a.userId, label: a.displayName, hint: ROLE_LABEL[a.role] ? t(ROLE_LABEL[a.role]!) : a.role, keywords: [a.email] });
    for (const tok of tokens.data ?? []) opts.set(tok.id, { value: tok.id, label: `${tok.name}`, hint: t('audit.actorType.apiToken'), keywords: [tok.prefix] });
    for (const [id, name] of seenActors) if (!opts.has(id)) opts.set(id, { value: id, label: name, hint: t('audit.log.actorFormer') });
    if (actor && !opts.has(actor)) opts.set(actor, { value: actor, label: t('audit.log.actorFallback', { id: isolate(actor.slice(0, 8)) }) });
    return [...opts.values()].sort((x, y) => x.label.localeCompare(y.label));
  }, [agents.data, tokens.data, seenActors, actor, t]);

  const typeOptions = objectType && !OBJECT_TYPES.includes(objectType) ? [...OBJECT_TYPES, objectType] : OBJECT_TYPES;
  const filtered = !!(from || to || actor || action || objectType || outcome);
  const csvHref = api.url('/audit-events/export.csv', query);

  const applyAction = (e?: FormEvent) => {
    e?.preventDefault();
    const v = normalizeAction(actionDraft);
    if (v && !ACTION_RE.test(v)) {
      setActionError(t('audit.log.actionInvalid'));
      return;
    }
    setActionError(null);
    if (v !== action) setParams({ action: v || null });
    else setActionDraft(v);
  };

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!canView) {
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('audit.log.noAccessTitle')} description={t('audit.log.noAccessBody')} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={t('audit.log.title')}
        description={t('audit.log.description')}
        actions={
          <Button asChild variant="secondary">
            <a href={csvHref} download aria-disabled={rangeInvalid || undefined} onClick={(e) => rangeInvalid && e.preventDefault()}>
              <Download className="size-4" aria-hidden />
              {t('audit.log.exportCsv')}
            </a>
          </Button>
        }
      />

      <Card>
        <form onSubmit={applyAction} className="grid gap-4 border-b border-line-subtle px-4 py-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 xl:grid-cols-6" aria-label={t('audit.log.filtersLabel')} noValidate>
          <Field label={t('common.from')} error={rangeInvalid ? t('audit.log.rangeFieldError') : undefined}>
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setParams({ from: e.target.value || null })} />
          </Field>
          <Field label={t('common.to')}>
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setParams({ to: e.target.value || null })} />
          </Field>
          <Field label={t('audit.log.actor')}>
            <Combobox value={actor || null} onChange={(v) => setParams({ actor: v === actor ? null : v })} options={actorOptions} 
              placeholder={t('audit.log.actorAnyone')}
              searchPlaceholder={t('audit.log.actorSearch')}
              emptyText={t('audit.log.actorEmpty')}
              footer={
                actor ? (
                  <Button size="sm" variant="ghost" className="w-full" onClick={() => setParams({ actor: null })}>
                    {t('audit.log.showEveryone')}
                  </Button>
                ) : undefined
              }
            />
          </Field>
          <Field label={t('audit.log.action')} description={t('audit.log.actionHelp')} error={actionError}>
            <Input value={actionDraft} onChange={(e) => setActionDraft(e.target.value)} onBlur={() => applyAction()} list="audit-action-prefixes" placeholder={t('audit.log.actionPlaceholder')} autoComplete="off" spellCheck={false} dir="ltr" className="font-mono" />
          </Field>
          <datalist id="audit-action-prefixes">
            {ACTION_PREFIXES.map((p) => (
              <option key={p} value={`${p}.*`} />
            ))}
          </datalist>
          <Field label={t('audit.log.objectType')}>
            <Select value={objectType} onChange={(e) => setParams({ type: e.target.value || null })}>
              <option value="">{t('audit.log.anyType')}</option>
              {typeOptions.map((ty) => (
                <option key={ty} value={ty}>
                  {objectTypeLabel(t, ty)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('audit.log.outcome')}>
            <Select value={outcome} onChange={(e) => setParams({ outcome: e.target.value || null })}>
              <option value="">{t('audit.log.anyOutcome')}</option>
              {Object.entries(OUTCOME).map(([k, m]) => (
                <option key={k} value={k}>
                  {t(m.label)}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className="sr-only">
            {t('audit.log.applyFilters')}
          </button>
        </form>
        {filtered && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle px-4 py-2 text-sm text-fg-2 sm:px-6">
            <span className="inline-flex items-center gap-1.5">
              <Filter className="size-4" aria-hidden />
              {t('audit.log.filteredNote')}
            </span>
            <Button size="sm" variant="ghost" onClick={() => router.replace(pathname, { scroll: false })}>
              {t('audit.log.clearFilters')}
            </Button>
          </div>
        )}

        {rangeInvalid ? (
          <div className="p-4 sm:p-6">
            <Banner tone="warning">{t('audit.log.rangeInvalid')}</Banner>
          </div>
        ) : q.isPending ? (
          <div className="flex flex-col gap-3 p-4 sm:p-6" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : q.error && !items.length ? (
          <PanelError message={t('audit.log.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ClipboardList />}
            title={filtered ? t('audit.log.emptyFilteredTitle') : t('audit.log.emptyTitle')}
            description={filtered ? t('audit.log.emptyFilteredBody') : t('audit.log.emptyBody')}
            action={
              filtered ? (
                <Button variant="secondary" onClick={() => router.replace(pathname, { scroll: false })}>
                  {t('audit.log.clearFilters')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {q.error && (
              <div className="px-4 pt-4 sm:px-6">
                <Banner tone="danger">{t('audit.log.refreshFailed', { error: errorMessage(q.error) })}</Banner>
              </div>
            )}
            <TableScroll>
              <Table className="min-w-[900px]">
                <THead>
                  <tr>
                    <TH className="w-10">
                      <span className="sr-only">{t('common.details')}</span>
                    </TH>
                    <TH>{t('common.time')}</TH>
                    <TH>{t('audit.log.actor')}</TH>
                    <TH>{t('audit.log.action')}</TH>
                    <TH>{t('audit.log.colObject')}</TH>
                    <TH>{t('audit.log.outcome')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {items.map((e) => {
                    const expanded = open.has(e.id);
                    const known = OUTCOME[e.outcome];
                    const o = known ? { label: t(known.label), tone: known.tone, Icon: known.Icon } : { label: e.outcome, tone: 'neutral' as const, Icon: CircleCheck };
                    return (
                      <Fragment key={e.id}>
                        <TR className={expanded ? 'border-b-0' : undefined}>
                          <TD className="pe-0">
                            <Button variant="ghost" size="icon-sm" aria-expanded={expanded} aria-controls={`audit-${e.id}`} aria-label={t(expanded ? 'audit.log.hideDetailsFor' : 'audit.log.showDetailsFor', { action: isolate(e.action) })} onClick={() => toggle(e.id)}>
                              {expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />}
                            </Button>
                          </TD>
                          <TD className="whitespace-nowrap">
                            <time dateTime={e.occurredAt} title={formatRelative(e.occurredAt)}>
                              {formatDateTime(e.occurredAt)}
                            </time>
                          </TD>
                          <TD className="max-w-[220px]">
                            <span className="block truncate font-medium" dir="auto">{e.actor.name ?? (e.actor.type === 'system' || e.actor.type === 'anonymous' ? actorTypeLabel(t, e.actor.type) : t('common.unknown'))}</span>
                            {e.actor.type !== 'user' && (e.actor.name || (e.actor.type !== 'system' && e.actor.type !== 'anonymous')) && <span className="text-xs text-fg-2">{actorTypeLabel(t, e.actor.type)}</span>}
                          </TD>
                          <TD>
                            <code className="font-mono text-xs" dir="ltr">{e.action}</code>
                          </TD>
                          <TD className="max-w-[240px]">
                            <span className="block">{objectTypeLabel(t, e.objectType)}</span>
                            {e.objectId && (
                              <code className="block truncate font-mono text-xs text-fg-2" title={e.objectId} dir="ltr">
                                {e.objectId.slice(0, 8)}…
                              </code>
                            )}
                          </TD>
                          <TD>
                            <Badge tone={o.tone} icon={<o.Icon className="size-3.5" aria-hidden />}>
                              {o.label}
                            </Badge>
                          </TD>
                        </TR>
                        {expanded && (
                          <tr id={`audit-${e.id}`} className="border-b border-line-subtle bg-surface-2">
                            <td colSpan={6} className="px-4 py-4 sm:px-6">
                              <div className="flex flex-col gap-4">
                                <DiffView diff={e.safeDiff} />
                                <dl className="grid gap-x-6 gap-y-1 text-xs text-fg-2 sm:grid-cols-[max-content_1fr]">
                                  {e.objectId && (
                                    <>
                                      <dt className="font-medium">{t('audit.log.objectId')}</dt>
                                      <dd className="break-all font-mono" dir="ltr">{e.objectId}</dd>
                                    </>
                                  )}
                                  {e.actor.id && (
                                    <>
                                      <dt className="font-medium">{t('audit.log.actorId')}</dt>
                                      <dd className="flex flex-wrap items-center gap-2">
                                        <span className="break-all font-mono" dir="ltr">{e.actor.id}</span>
                                        {e.actor.id !== actor && (
                                          <Button variant="link" className="text-xs" onClick={() => setParams({ actor: e.actor.id })}>
                                            {t('audit.log.showOnlyActor')}
                                          </Button>
                                        )}
                                      </dd>
                                    </>
                                  )}
                                  {e.requestId && (
                                    <>
                                      <dt className="font-medium">{t('audit.log.requestId')}</dt>
                                      <dd className="break-all font-mono" dir="ltr">{e.requestId}</dd>
                                    </>
                                  )}
                                </dl>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            </TableScroll>
            {q.hasNextPage && (
              <div className="border-t border-line-subtle p-3 text-center">
                <Button variant="secondary" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
      <p className="text-xs text-fg-2">{t('audit.log.footnote', { max: 50_000 })}</p>
    </Page>
  );
}
