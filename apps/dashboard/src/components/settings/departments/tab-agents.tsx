'use client';
/**
 * Department membership (ch. 10): searchable multi-select to add agents, per-agent
 * "can serve" / "can monitor", and every pending change saved together with
 * PUT /departments/{id}/members. Capacity shown is each agent's global capacity
 * (shared across all their departments).
 */
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, Undo2, UserPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Badge, Banner, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, MultiCombobox, PanelError, Skeleton, StatusLabel, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { byId, qk, useAgents } from '@/lib/queries';
import type { Agent, Department } from '@/lib/types';
import { useCan } from '@/stores/session';
import { isEqual, SaveBar } from '../form-kit';
import type { TabProps } from './department-detail';
import { SERVING_ROLES, type DepartmentMember } from './dept-shared';

type Members = Record<string, { canServe: boolean; canMonitor: boolean }>;

const toMap = (list: DepartmentMember[]): Members => Object.fromEntries(list.map((m) => [m.membershipId, { canServe: m.canServe, canMonitor: m.canMonitor }]));

const ROLE_LABEL: Record<Agent['role'], MessageKey> = { owner: 'settings.roles.owner', admin: 'settings.roles.admin', supervisor: 'settings.roles.supervisor', agent: 'settings.roles.agent', analyst: 'settings.roles.analyst' };

export function AgentsTab({ dept, canManage, onDirtyChange, registerSave }: TabProps) {
  const t = useT();
  const qc = useQueryClient();
  const canView = useCan('agents.view');
  const agents = useAgents();
  const agentMap = useMemo(() => byId(agents.data), [agents.data]);
  const server = useMemo(() => toMap(dept.members), [dept.members]);
  const [draft, setDraft] = useState<{ base: Members; value: Members } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const value = draft?.value ?? server;
  const dirty = !!draft && !isEqual(draft.value, draft.base);
  const remoteChanged = !!draft && dirty && !isEqual(draft.base, server);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const update = (fn: (m: Members) => Members) => setDraft((d) => ({ base: d?.base ?? server, value: fn({ ...(d?.value ?? server) }) }));

  const setMember = (id: string, patch: Partial<{ canServe: boolean; canMonitor: boolean }> | null) =>
    update((m) => {
      if (patch === null) delete m[id];
      else m[id] = { ...(m[id] ?? { canServe: true, canMonitor: false }), ...patch };
      return m;
    });

  const restore = (id: string) => update((m) => ({ ...m, [id]: server[id] }));

  const save = async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    setSaving(true);
    setMessage(null);
    try {
      const members = Object.entries(draft.value).map(([membershipId, p]) => ({ membershipId, canServe: p.canServe, canMonitor: p.canMonitor }));
      const next = await api.put<Department>(`/departments/${dept.id}/members`, { members });
      qc.setQueryData<Department[]>(qk.departments, (list) => list?.map((d) => (d.id === next.id ? next : d)));
      void qc.invalidateQueries({ queryKey: qk.agents });
      setDraft(null);
      toast.success(t('settings.departments.agents.saved'));
      return true;
    } catch (e) {
      setMessage(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    registerSave(save);
  });

  const memberIds = Object.keys(value);
  const rows = memberIds.map((id) => ({ id, perms: value[id], agent: agentMap.get(id) })).sort((a, b) => (a.agent?.displayName ?? '').localeCompare(b.agent?.displayName ?? ''));
  const removed = Object.keys(server).filter((id) => !(id in value));
  const added = memberIds.filter((id) => !(id in server));
  const changed = memberIds.filter((id) => id in server && !isEqual(server[id], value[id]));
  const pendingCount = removed.length + added.length + changed.length;
  const servingCount = rows.filter((r) => r.perms.canServe && (!r.agent || (r.agent.enabled && SERVING_ROLES.has(r.agent.role)))).length;

  const options = useMemo(
    () =>
      (agents.data ?? []).map((a) => ({
        value: a.id,
        label: a.displayName,
        hint: !a.enabled ? t('settings.departments.agents.suspended') : t(ROLE_LABEL[a.role]),
        keywords: [a.email],
      })),
    [agents.data, t],
  );

  if (!canView)
    return (
      <Card>
        <CardHeader title={t('settings.departments.tabs.agents')} description={t('settings.departments.agents.memberCount', { count: dept.members.length })} />
        <CardBody>
          <Banner tone="info">{t('settings.departments.agents.noAccess')}</Banner>
        </CardBody>
      </Card>
    );

  return (
    <Card>
      <CardHeader title={t('settings.departments.tabs.agents')} description={t('settings.departments.agents.description')} />
      <CardBody className="flex flex-col gap-4">
        {remoteChanged && (
          <Banner
            tone="warning"
            action={
              <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                {t('settings.hours.loadLatest')}
              </Button>
            }
          >
            {t('settings.departments.agents.remoteChanged')}
          </Banner>
        )}
        {message && <Banner tone="danger">{message}</Banner>}
        {canManage && (
          <Field label={t('settings.departments.agents.pickerLabel')} description={t('settings.departments.agents.pickerHint')}>
            <MultiCombobox
              values={memberIds}
              onChange={(ids) => {
                const next = new Set(ids);
                update((m) => {
                  for (const id of Object.keys(m)) if (!next.has(id)) delete m[id];
                  for (const id of ids) if (!m[id]) m[id] = server[id] ?? { canServe: SERVING_ROLES.has(agentMap.get(id)?.role ?? 'agent'), canMonitor: false };
                  return m;
                });
              }}
              options={options}
              placeholder={t('settings.departments.agents.pickerPlaceholder')}
              searchPlaceholder={t('settings.departments.agents.pickerSearch')}
              emptyText={t('settings.departments.agents.pickerEmpty')}
            />
          </Field>
        )}
        {!agents.isPending && servingCount === 0 && dept.enabled && !dept.archivedAt && <Banner tone="warning">{t('settings.departments.agents.nobodyServes')}</Banner>}
      </CardBody>
      {agents.isPending ? (
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-6">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : agents.isError ? (
        <PanelError message={errorMessage(agents.error)} onRetry={() => void agents.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Users />} title={t('settings.departments.agents.emptyTitle')} description={canManage ? t('settings.departments.agents.emptyManage') : t('settings.departments.agents.emptyView')} />
      ) : (
        <TableScroll>
          <Table className="min-w-[760px]">
            <THead>
              <tr>
                <TH>{t('common.agent')}</TH>
                <TH>{t('common.status')}</TH>
                <TH className="text-end">{t('settings.departments.agents.colLoad')}</TH>
                <TH className="text-center">{t('settings.departments.agents.colServe')}</TH>
                <TH className="text-center">{t('settings.departments.agents.colMonitor')}</TH>
                {canManage && (
                  <TH className="w-12">
                    <span className="sr-only">{t('common.remove')}</span>
                  </TH>
                )}
              </tr>
            </THead>
            <tbody>
              {rows.map(({ id, perms, agent }) => {
                const name = agent?.displayName ?? t('settings.departments.agents.formerMember');
                const cannotServe = !!agent && !SERVING_ROLES.has(agent.role);
                return (
                  <TR key={id}>
                    <TD>
                      <div className="flex items-center gap-3">
                        <Avatar name={name} src={agent?.avatarUrl} size="sm" />
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            <bdi>{name}</bdi>
                            {added.includes(id) && <Badge tone="info">{t('settings.departments.agents.new')}</Badge>}
                            {changed.includes(id) && <Badge tone="info">{t('settings.departments.agents.changed')}</Badge>}
                            {agent && !agent.enabled && <Badge tone="warning">{t('settings.departments.agents.suspended')}</Badge>}
                          </p>
                          <p className="truncate text-xs text-fg-2">
                            {agent ? (
                              <>
                                {t(ROLE_LABEL[agent.role])} · <bdi>{agent.email}</bdi>
                              </>
                            ) : (
                              t('settings.departments.agents.noLongerOnTeam')
                            )}
                          </p>
                        </div>
                      </div>
                    </TD>
                    <TD>{agent ? <StatusLabel status={agent.effectiveStatus} /> : '—'}</TD>
                    <TD className="text-end tabular">
                      {agent ? (
                        <span>
                          <span aria-hidden>
                            <span className={agent.activeChats >= agent.capacity ? 'font-semibold text-warning' : ''}>{formatNumber(agent.activeChats)}</span> / {formatNumber(agent.capacity)}
                          </span>
                          <span className="sr-only">{t('settings.departments.agents.loadSr', { active: agent.activeChats, capacity: agent.capacity })}</span>
                          {agent.departmentIds.length > 1 && <span className="block text-xs text-fg-2">{t('settings.departments.agents.across', { count: agent.departmentIds.length })}</span>}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="text-center">
                      <Checkbox
                        checked={perms.canServe}
                        disabled={!canManage || cannotServe}
                        onCheckedChange={(c) => setMember(id, { canServe: c === true })}
                        aria-label={t('settings.departments.agents.serveLabel', { name, department: dept.name })}
                        title={cannotServe ? t('settings.departments.agents.analystCannotServe') : undefined}
                      />
                    </TD>
                    <TD className="text-center">
                      <Checkbox checked={perms.canMonitor} disabled={!canManage} onCheckedChange={(c) => setMember(id, { canMonitor: c === true })} aria-label={t('settings.departments.agents.monitorLabel', { name, department: dept.name })} />
                    </TD>
                    {canManage && (
                      <TD>
                        <Button size="icon" variant="ghost" className="size-11 sm:size-10" onClick={() => setMember(id, null)} aria-label={t('settings.departments.agents.removeLabel', { name, department: dept.name })}>
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </TD>
                    )}
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
      {removed.length > 0 && (
        <div className="border-t border-line-subtle px-4 py-3 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-2">{t('settings.departments.agents.willBeRemoved')}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {removed.map((id) => {
              const name = agentMap.get(id)?.displayName ?? t('settings.departments.agents.formerMember');
              return (
                <li key={id} className="inline-flex h-9 items-center gap-1 rounded-full border border-line bg-surface-2 ps-3 pe-1 text-sm">
                  <span className="line-through decoration-fg-3" dir="auto">
                    {name}
                  </span>
                  <Button size="icon-sm" variant="ghost" className="size-11 sm:size-8" onClick={() => restore(id)} aria-label={t('settings.departments.agents.keepLabel', { name, department: dept.name })}>
                    <Undo2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {canManage && (
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onDiscard={() => (setDraft(null), setMessage(null))}
          label={t('settings.departments.agents.saveMembers')}
          note={dirty ? t('settings.departments.agents.pending', { count: pendingCount }) : undefined}
        />
      )}
      {!canManage && rows.length > 0 && (
        <p className="flex items-center gap-2 border-t border-line-subtle px-4 py-3 text-xs text-fg-2 sm:px-6">
          <UserPlus className="size-3.5" aria-hidden />
          {t('settings.departments.agents.adminsOnly')}
        </p>
      )}
    </Card>
  );
}
