'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, Search, UserPlus, Users } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Page,
  PanelError,
  Select,
  Skeleton,
  Table,
  TableScroll,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { useEphemeralEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { intlLocale, isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { byId, qk, useDepartments } from '@/lib/queries';
import type { Agent, AgentStatus as DesiredStatus, EffectiveStatus, Role } from '@/lib/types';
import { useSession } from '@/stores/session';
import { baselineFor, isDirty, saveDraft, validateDraft, type AgentDraft } from './agent-draft';
import { AgentDrawer } from './agent-drawer';
import { AgentStatus, LastSeen, LoadCell, transportInterrupted } from './agent-status';
import { Invitations } from './invitations';
import { InviteDialog, invitationsKey, type Invitation } from './invite-dialog';
import { OwnershipTransferDialog } from './ownership-transfer-dialog';
import { ALL_ROLES, ROLE_LABEL } from './roles';

type StatusFilter = EffectiveStatus | 'suspended' | 'interrupted';
const STATUS_FILTERS: Array<{ value: StatusFilter; label: MessageKey }> = [
  { value: 'online', label: 'team.statusFilter.online' },
  { value: 'away', label: 'team.statusFilter.away' },
  { value: 'invisible', label: 'team.statusFilter.invisible' },
  { value: 'offline', label: 'team.statusFilter.offline' },
  { value: 'interrupted', label: 'team.statusFilter.interrupted' },
  { value: 'suspended', label: 'team.statusFilter.suspended' },
];

/** A count sentence whose number is marked <b>…</b> in the message, so the emphasis follows the translation's word order. */
function Count({
  text,
  className,
  numClassName = 'text-fg',
}: {
  text: string;
  className?: string;
  numClassName?: string;
}) {
  const [before, num, after] = text.split(/<b>|<\/b>/);
  return (
    <span className={className}>
      {before}
      <span className={`font-semibold tabular ${numClassName}`}>{num}</span>
      {after}
    </span>
  );
}

interface PresencePayload {
  membershipId: string;
  effectiveStatus: EffectiveStatus;
  desiredStatus: DesiredStatus;
  connected: boolean;
  activeCount: number;
  capacity: number;
}

function matchesStatus(a: Agent, s: StatusFilter): boolean {
  if (s === 'suspended') return !a.enabled;
  if (!a.enabled) return false;
  if (s === 'interrupted') return transportInterrupted(a);
  return a.effectiveStatus === s;
}

/**
 * Team roster (ch. 09): filters live in the URL, the drawer is addressable by
 * `?agent=`, presence and load update live from the team scope, and edits are kept
 * as drafts until saved.
 */
export function TeamPage() {
  const t = useT();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const canManage = useSession((s) => s.permissions.has('agents.manage'));
  const isOwner = useSession((s) => s.permissions.has('tenant.owner'));
  const viewerRole = useSession((s) => (s.agent?.agent.role ?? null) as Role | null);
  const viewerId = useSession((s) => s.agent?.agent.id ?? null);

  const view = params.get('view') === 'invitations' && canManage ? 'invitations' : 'members';
  const q = params.get('q') ?? '';
  const role = (params.get('role') ?? '') as Role | '';
  const status = (params.get('status') ?? '') as StatusFilter | '';
  const dept = params.get('dept') ?? '';
  const selectedId = params.get('agent');
  const transferOpen = params.get('transfer') === '1' && isOwner;

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const s = next.toString();
      // Shallow URL update: Next syncs history.replaceState with useSearchParams, so
      // filters, tabs and the selected row change instantly without a server round-trip.
      window.history.replaceState(null, '', s ? `${pathname}?${s}` : pathname);
    },
    [params, pathname],
  );

  const agentsQ = useQuery({
    queryKey: qk.agents,
    queryFn: () => api.get<Agent[]>('/agents'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const departments = useDepartments();
  const invitationsQ = useQuery({
    queryKey: invitationsKey,
    queryFn: () => api.get<Invitation[]>('/agents/invitations'),
    enabled: canManage,
    staleTime: 15_000,
  });
  const deptMap = byId(departments.data);

  // Live presence/load from the team scope; REST stays the source of truth on resync.
  useScopes([{ kind: 'team', id: 'all' }]);
  useEphemeralEvent<PresencePayload>('presence.updated', (e) => {
    const p = e.payload;
    let known = false;
    qc.setQueryData<Agent[]>(qk.agents, (list) =>
      list?.map((a) => {
        if (a.id !== p.membershipId) return a;
        known = true;
        return {
          ...a,
          effectiveStatus: p.effectiveStatus,
          desiredStatus: p.desiredStatus,
          connected: p.connected,
          activeChats: p.activeCount,
          capacity: p.capacity,
          lastSeenAt: p.connected ? a.lastSeenAt : new Date().toISOString(),
        };
      }),
    );
    if (!known) void qc.invalidateQueries({ queryKey: qk.agents });
  });
  useResync(() => {
    void qc.invalidateQueries({ queryKey: qk.agents });
    void qc.invalidateQueries({ queryKey: qk.departments });
  });

  // Drafts survive closing the drawer until saved or discarded.
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const agents = agentsQ.data;
  const baseFor = useCallback((a: Agent) => baselineFor(a, departments.data), [departments.data]);
  const dirtyIds = useMemo(
    () => (agents ?? []).filter((a) => isDirty(baseFor(a), drafts[a.id])).map((a) => a.id),
    [agents, drafts, baseFor],
  );
  const dirtySet = new Set(dirtyIds);

  const guard = useDirtyGuard(dirtyIds.length > 0, {
    what: t('team.page.dirtyWhat', { count: dirtyIds.length }),
    onSave: async () => {
      for (const id of dirtyIds) {
        const a = agents?.find((x) => x.id === id);
        const d = drafts[id];
        if (!a || !d) continue;
        if (Object.keys(validateDraft(d)).length)
          throw new Error(t('team.page.fixFields', { name: isolate(a.displayName) }));
        await saveDraft(id, baseFor(a), d);
        setDrafts((all) => {
          const { [id]: _, ...rest } = all;
          return rest;
        });
      }
      await qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(t('team.page.savedToast'));
      return true;
    },
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (agents ?? [])
      .filter(
        (a) =>
          !needle ||
          a.displayName.toLowerCase().includes(needle) ||
          a.email.toLowerCase().includes(needle) ||
          (a.title ?? '').toLowerCase().includes(needle),
      )
      .filter((a) => !role || a.role === role)
      .filter((a) => !status || matchesStatus(a, status))
      .filter((a) => !dept || a.departmentIds.includes(dept))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [agents, q, role, status, dept]);

  const counts = useMemo(() => {
    const c = { online: 0, away: 0, interrupted: 0, suspended: 0 };
    for (const a of agents ?? []) {
      if (!a.enabled) c.suspended++;
      else if (a.effectiveStatus === 'online') c.online++;
      else if (a.effectiveStatus === 'away') c.away++;
      if (transportInterrupted(a)) c.interrupted++;
    }
    return c;
  }, [agents]);

  const selected = agents?.find((a) => a.id === selectedId) ?? null;
  const [inviteOpen, setInviteOpen] = useState(false);
  const filtersActive = !!(q || role || status || dept);

  const deptNames = (a: Agent) =>
    a.departmentIds.map((id) => deptMap.get(id)?.name).filter(Boolean) as string[];

  // Active filters for the empty state, as a locale-joined list of short clauses.
  const statusLabel = STATUS_FILTERS.find((s) => s.value === status)?.label;
  const activeFilterList = new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(
    [
      q ? t('team.page.filterQuery', { q: isolate(q) }) : null,
      role
        ? t('team.page.filterRole', { role: ROLE_LABEL[role] ? t(ROLE_LABEL[role]) : isolate(role) })
        : null,
      statusLabel ? t('team.page.filterStatus', { status: t(statusLabel) }) : null,
      dept
        ? t('team.page.filterDept', {
            department: deptMap.get(dept)?.name
              ? isolate(deptMap.get(dept)!.name)
              : t('team.page.thisDepartment'),
          })
        : null,
    ].filter((x): x is string => !!x),
  );

  return (
    <Page>
      <PageHeader
        title={t('team.page.title')}
        description={t('team.page.description')}
        actions={
          <>
            {isOwner && (
              <Button variant="secondary" onClick={() => setParams({ transfer: '1' })}>
                <Crown className="size-4" aria-hidden />
                {t('team.transfer.title')}
              </Button>
            )}
            {canManage && (
              <Button variant="primary" onClick={() => setInviteOpen(true)}>
                <UserPlus className="size-4" aria-hidden />
                {t('team.page.invite')}
              </Button>
            )}
          </>
        }
      />

      {agents && (
        <p className="-mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-2" aria-live="polite">
          <Count text={t('team.page.countOnline', { count: counts.online })} />
          <Count text={t('team.page.countAway', { count: counts.away })} />
          {counts.interrupted > 0 && (
            <Count
              className="text-warning"
              numClassName=""
              text={t('team.page.countNotConnected', { count: counts.interrupted })}
            />
          )}
          {counts.suspended > 0 && (
            <Count text={t('team.page.countSuspended', { count: counts.suspended })} />
          )}
        </p>
      )}

      <Tabs value={view} onValueChange={(v) => setParams({ view: v === 'members' ? null : v })}>
        <TabsList aria-label={t('team.page.sections')}>
          <TabsTrigger value="members">
            {t('team.page.members')}
            {agents && <Badge>{agents.length}</Badge>}
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="invitations">
              {t('team.page.pendingInvitations')}
              {!!invitationsQ.data?.length && <Badge tone="primary">{invitationsQ.data.length}</Badge>}
            </TabsTrigger>
          )}
        </TabsList>

        {canManage && (
          <TabsContent value="invitations" className="mt-6">
            <Invitations onInvite={() => setInviteOpen(true)} />
          </TabsContent>
        )}
        <TabsContent value="members" className="mt-6">
          <Card>
            <div className="flex flex-col gap-3 border-b border-line-subtle p-4 lg:flex-row lg:items-end">
              <Field label={t('common.search')} hideLabel className="lg:max-w-xs lg:flex-1">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    value={q}
                    onChange={(e) => setParams({ q: e.target.value })}
                    placeholder={t('team.page.searchPlaceholder')}
                    className="ps-9"
                  />
                </div>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:flex lg:flex-1">
                <Field label={t('team.page.role')} hideLabel className="lg:w-40">
                  <Select value={role} onChange={(e) => setParams({ role: e.target.value })}>
                    <option value="">{t('team.page.allRoles')}</option>
                    {ALL_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(ROLE_LABEL[r])}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('common.status')} hideLabel className="lg:w-56">
                  <Select value={status} onChange={(e) => setParams({ status: e.target.value })}>
                    <option value="">{t('team.page.allStatuses')}</option>
                    {STATUS_FILTERS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {t(s.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('common.department')} hideLabel className="lg:w-48">
                  <Select
                    value={dept}
                    onChange={(e) => setParams({ dept: e.target.value })}
                    disabled={!departments.data}
                  >
                    <option value="">{t('team.page.allDepartments')}</option>
                    {(departments.data ?? [])
                      .filter((d) => !d.archivedAt)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
              {filtersActive && (
                <Button
                  variant="ghost"
                  className="self-start lg:self-auto"
                  onClick={() => setParams({ q: null, role: null, status: null, dept: null })}
                >
                  {t('team.page.clearFilters')}
                </Button>
              )}
            </div>

            {agentsQ.isLoading ? (
              <RosterSkeleton />
            ) : agentsQ.isError ? (
              <PanelError message={errorMessage(agentsQ.error)} onRetry={() => void agentsQ.refetch()} />
            ) : !filtered.length ? (
              <EmptyState
                icon={<Users />}
                title={filtersActive ? t('team.page.emptyFilteredTitle') : t('team.page.emptyTitle')}
                description={
                  filtersActive
                    ? t('team.page.emptyFilteredBody', { filters: activeFilterList })
                    : t('team.page.emptyBody')
                }
                action={
                  filtersActive ? (
                    <Button onClick={() => setParams({ q: null, role: null, status: null, dept: null })}>
                      {t('team.page.clearFilters')}
                    </Button>
                  ) : canManage ? (
                    <Button variant="primary" onClick={() => setInviteOpen(true)}>
                      {t('team.page.invite')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <p className="sr-only" role="status">
                  {t('team.page.showing', { shown: filtered.length, total: agents?.length ?? 0 })}
                </p>
                <TableScroll className="hidden sm:block">
                  <Table>
                    <THead>
                      <tr>
                        <TH>{t('common.name')}</TH>
                        <TH>{t('team.page.role')}</TH>
                        <TH>{t('common.departments')}</TH>
                        <TH>{t('common.status')}</TH>
                        <TH>{t('team.page.activeChats')}</TH>
                        <TH>{t('team.page.lastSeen')}</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {filtered.map((a) => {
                        const names = deptNames(a);
                        return (
                          <TR
                            key={a.id}
                            interactive
                            selected={a.id === selectedId}
                            onClick={() => setParams({ agent: a.id })}
                          >
                            <TD className="max-w-[280px]">
                              <button
                                type="button"
                                className="flex w-full min-w-0 items-center gap-3 rounded-md py-1 text-start"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setParams({ agent: a.id });
                                }}
                                aria-label={t('team.page.openAgent', { name: isolate(a.displayName) })}
                              >
                                <Avatar name={a.displayName} src={a.avatarUrl} />
                                <span className="flex min-w-0 flex-col">
                                  <span className="flex items-center gap-2">
                                    <span className="truncate font-medium" dir="auto">
                                      {a.displayName}
                                    </span>
                                    {a.id === viewerId && (
                                      <span className="text-xs text-fg-2">{t('team.page.you')}</span>
                                    )}
                                    {dirtySet.has(a.id) && (
                                      <Badge tone="warning">{t('team.page.unsaved')}</Badge>
                                    )}
                                  </span>
                                  <span className="truncate text-xs text-fg-2" dir="auto">
                                    {a.email}
                                  </span>
                                </span>
                              </button>
                            </TD>
                            <TD>
                              <span className="inline-flex items-center gap-1">
                                {a.role === 'owner' && (
                                  <Crown className="size-3.5 text-primary" aria-hidden />
                                )}
                                {t(ROLE_LABEL[a.role])}
                              </span>
                            </TD>
                            <TD className="max-w-[220px]">
                              <span className="line-clamp-2 text-fg-2" title={names.join(', ')} dir="auto">
                                {names.length ? names.join(', ') : ''}
                              </span>
                            </TD>
                            <TD>
                              <AgentStatus agent={a} />
                            </TD>
                            <TD>
                              <LoadCell agent={a} />
                            </TD>
                            <TD>
                              <LastSeen agent={a} />
                            </TD>
                          </TR>
                        );
                      })}
                    </tbody>
                  </Table>
                </TableScroll>
                <ul className="flex flex-col sm:hidden" aria-label={t('team.page.teammates')}>
                  {filtered.map((a) => {
                    const names = deptNames(a);
                    return (
                      <li key={a.id} className="border-b border-line-subtle last:border-b-0">
                        <button
                          type="button"
                          onClick={() => setParams({ agent: a.id })}
                          className="flex w-full flex-col gap-2 px-4 py-3 text-start hover:bg-surface-2"
                        >
                          <span className="flex w-full items-center gap-3">
                            <Avatar name={a.displayName} src={a.avatarUrl} size="md" />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="flex items-center gap-2">
                                <span className="truncate font-medium" dir="auto">
                                  {a.displayName}
                                </span>
                                {a.id === viewerId && (
                                  <span className="text-xs text-fg-2">{t('team.page.you')}</span>
                                )}
                              </span>
                              <span className="truncate text-xs text-fg-2" dir="auto">
                                {a.email}
                              </span>
                            </span>
                            <Badge tone={a.role === 'owner' ? 'primary' : 'neutral'}>
                              {t(ROLE_LABEL[a.role])}
                            </Badge>
                          </span>
                          <AgentStatus agent={a} />
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
                            <LoadCell agent={a} />
                            <span>
                              {t('team.page.lastSeen')} <LastSeen agent={a} />
                            </span>
                          </span>
                          {names.length > 0 && (
                            <span className="text-xs text-fg-2" dir="auto">
                              {names.join(', ')}
                            </span>
                          )}
                          {dirtySet.has(a.id) && (
                            <Badge tone="warning">{t('team.drawer.unsavedChanges')}</Badge>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {selected && (
        <AgentDrawer
          key={selected.id}
          agent={selected}
          departments={departments.data}
          base={baseFor(selected)}
          draft={drafts[selected.id]}
          onDraft={(d) =>
            setDrafts((all) => {
              if (d) return { ...all, [selected.id]: d };
              const { [selected.id]: _, ...rest } = all;
              return rest;
            })
          }
          viewer={{ membershipId: viewerId, role: viewerRole, canManage }}
          open={!!selected}
          onOpenChange={(o) => !o && setParams({ agent: null })}
          onTransfer={() => setParams({ agent: null, transfer: '1' })}
        />
      )}
      {canManage && <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />}
      {isOwner && agents && (
        <OwnershipTransferDialog
          open={transferOpen}
          onOpenChange={(o) => setParams({ transfer: o ? '1' : null })}
          agents={agents}
        />
      )}
      {guard}
    </Page>
  );
}

function RosterSkeleton() {
  return (
    <div className="flex flex-col" aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-line-subtle px-4 py-3 last:border-b-0"
        >
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="hidden h-3.5 w-20 sm:block" />
          <Skeleton className="hidden h-3.5 w-24 md:block" />
          <Skeleton className="hidden h-3.5 w-16 md:block" />
        </div>
      ))}
    </div>
  );
}
