'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Crown, Minus, Plus, ShieldAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DrawerContent,
  Field,
  Input,
  Select,
} from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { qk } from '@/lib/queries';
import type { Agent, Department, Role } from '@/lib/types';
import { AgentStatus, LastSeen } from './agent-status';
import {
  CAPACITY_MAX,
  CAPACITY_MIN,
  diffDraft,
  isDirty,
  conflictVersion,
  saveDraft,
  validateDraft,
  type AgentDraft,
} from './agent-draft';
import { ASSIGNABLE_ROLES, ROLE_LABEL, ROLE_SUMMARY } from './roles';

export interface DrawerViewer {
  membershipId: string | null;
  role: Role | null;
  canManage: boolean;
}

/**
 * Agent drawer (ch. 09): Profile, Membership, Departments and Capacity are
 * separate sections. Edits accumulate in a page-level draft that survives closing
 * the drawer until saved or discarded; suspension is an immediate, confirmed action.
 */
export function AgentDrawer({
  agent,
  departments,
  base,
  draft,
  onDraft,
  viewer,
  open,
  onOpenChange,
  onTransfer,
}: {
  agent: Agent;
  departments: Department[] | undefined;
  base: AgentDraft;
  draft: AgentDraft | undefined;
  onDraft: (d: AgentDraft | null) => void;
  viewer: DrawerViewer;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Opens the ownership transfer dialog (owner only). */
  onTransfer: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const value = draft ?? base;
  const dirty = isDirty(base, draft);
  const errors = validateDraft(value);
  const invalid = Object.keys(errors).length > 0;
  const isSelf = viewer.membershipId === agent.id;
  const isOwner = agent.role === 'owner';
  const canEditProfile = viewer.canManage || isSelf;
  const adminLocked = agent.role === 'admin' && viewer.role !== 'owner';
  const canEditRole = viewer.canManage && !isOwner && !adminLocked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const [confirm, setConfirm] = useState<'suspend' | 'restore' | null>(null);

  const set = (patch: Partial<AgentDraft>) => onDraft({ ...value, ...patch });
  const diff = useMemo(() => diffDraft(base, value), [base, value]);

  const ownerExplanation = (msg: string) => (
    <div className="flex flex-col gap-1">
      <span>{msg}</span>
      <span>
        {t('team.drawer.ownerRule')}{' '}
        {viewer.role === 'owner' ? (
          <Button variant="link" onClick={onTransfer} className="font-medium underline">
            {t('team.transfer.title')}
          </Button>
        ) : (
          t('team.drawer.askOwner')
        )}
      </span>
    </div>
  );

  const describe = (e: unknown): ReactNode => {
    if (isApiError(e, 'CONFLICT') && isOwner) return ownerExplanation(errorMessage(e));
    if (isApiError(e, 'PERMISSION_DENIED')) return t('team.drawer.errPermission', { error: errorMessage(e) });
    if (isApiError(e, 'VERSION_CONFLICT')) return t('team.drawer.errVersion', { name: isolate(agent.displayName) });
    if (isApiError(e, 'NOT_FOUND')) return t('team.drawer.errNotFound');
    return errorMessage(e);
  };

  const save = async () => {
    if (!draft || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await saveDraft(agent.id, base, draft);
      onDraft(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.agents }),
        diff.departments ? qc.invalidateQueries({ queryKey: qk.departments }) : null,
      ]);
      toast.success(t('team.drawer.savedToast', { name: isolate(agent.displayName) }));
    } catch (e) {
      setError(describe(e));
      // After the conflict is shown, a second save deliberately applies the edits on top.
      if (isApiError(e, 'VERSION_CONFLICT')) onDraft({ ...draft, baseVersion: conflictVersion(e.details) });
      void qc.invalidateQueries({ queryKey: qk.agents });
    } finally {
      setBusy(false);
    }
  };

  /** Errors surface inside the ConfirmDialog (the server message names the owner rule). */
  const setEnabled = async (enabled: boolean) => {
    try {
      await api.patch(`/agents/${agent.id}`, { enabled });
    } finally {
      void qc.invalidateQueries({ queryKey: qk.agents });
    }
    toast.success(enabled ? t('team.drawer.restoredToast', { name: isolate(agent.displayName) }) : t('team.drawer.suspendedToast', { name: isolate(agent.displayName) }));
  };

  const deptList = (departments ?? []).filter((d) => !d.archivedAt || value.departments[d.id]);
  // Link text is marked in the message so the translation decides where the button sits in the sentence.
  const handOver = t('team.drawer.handOver').split(/<link>|<\/link>/);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          width={520}
          title={agent.displayName}
          description={agent.email}
          footer={
            canEditProfile || viewer.canManage ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-fg-2" role="status" aria-live="polite">
                  {dirty ? t('team.drawer.unsavedChanges') : t('team.drawer.noChanges')}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={!dirty || busy}
                    onClick={() => {
                      onDraft(null);
                      setError(null);
                    }}
                  >
                    {t('team.drawer.discard')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!dirty || invalid}
                    loading={busy}
                    onClick={() => void save()}
                  >
                    {t('common.saveChanges')}
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-6 px-5 py-5">
            <div className="flex items-center gap-3">
              <Avatar name={agent.displayName} src={agent.avatarUrl} size="lg" />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={isOwner ? 'primary' : 'neutral'}
                    icon={isOwner ? <Crown className="size-3" aria-hidden /> : undefined}
                  >
                    {t(ROLE_LABEL[agent.role])}
                  </Badge>
                  {isSelf && <Badge tone="info">{t('team.drawer.you')}</Badge>}
                </div>
                <AgentStatus agent={agent} />
                <span className="text-xs text-fg-2">
                  {t('team.drawer.lastSeen')} <LastSeen agent={agent} />
                </span>
              </div>
            </div>

            {error && (
              <Banner tone="danger" title={t('team.drawer.notSavedTitle')}>
                {error}
              </Banner>
            )}

            <Section
              title={t('team.drawer.profile')}
              description={t('team.drawer.profileHint')}
            >
              <Field
                label={t('team.drawer.displayName')}
                description={t('team.drawer.displayNameHint')}
                error={errors.displayName}
              >
                <Input
                  value={value.displayName}
                  onChange={(e) => set({ displayName: e.target.value })}
                  maxLength={120}
                  dir="auto"
                  disabled={!canEditProfile}
                />
              </Field>
              <Field label={t('team.drawer.title')} description={t('team.drawer.titleHint')} error={errors.title}>
                <Input
                  value={value.title}
                  onChange={(e) => set({ title: e.target.value })}
                  maxLength={80}
                  dir="auto"
                  disabled={!canEditProfile}
                />
              </Field>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-2">{t('common.email')}</dt>
                <dd className="min-w-0 truncate" dir="auto">
                  {agent.email}
                </dd>
                {agent.lastSeenAt && (
                  <>
                    <dt className="text-fg-2">{t('team.drawer.lastActivity')}</dt>
                    <dd>{formatDateTime(agent.lastSeenAt)}</dd>
                  </>
                )}
              </dl>
            </Section>

            <Section title={t('team.drawer.membership')} description={t('team.drawer.membershipHint')}>
              <Field
                label={t('team.invite.role')}
                description={
                  isOwner
                    ? t('team.drawer.roleOwnerHint')
                    : adminLocked && viewer.canManage
                      ? t('team.drawer.roleAdminLocked')
                      : !viewer.canManage
                        ? t('team.drawer.roleNoPermission')
                        : undefined
                }
              >
                <Select
                  value={value.role}
                  onChange={(e) => set({ role: e.target.value as Role })}
                  disabled={!canEditRole}
                >
                  {isOwner && <option value="owner">{t('team.role.owner')}</option>}
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(ROLE_LABEL[r])}
                    </option>
                  ))}
                </Select>
              </Field>
              <RoleSummary role={value.role} />
              {value.role !== base.role && (
                <Banner tone="info">
                  {isSelf ? t('team.drawer.roleChangeSelf') : t('team.drawer.roleChangeOther', { name: isolate(agent.displayName) })}
                </Banner>
              )}
              {isOwner && viewer.role === 'owner' && (
                <p className="text-sm text-fg-2">
                  {handOver[0]}
                  <Button variant="link" onClick={onTransfer} className="font-medium underline">
                    {handOver[1]}
                  </Button>
                  {handOver[2]}
                </p>
              )}
              <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line-subtle p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{t('team.drawer.access')}</span>
                    <span className="text-xs text-fg-2">
                      {agent.enabled ? t('team.drawer.accessActive') : t('team.drawer.accessSuspended')}
                    </span>
                  </div>
                  {viewer.canManage &&
                    (agent.enabled ? (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        onClick={() => setConfirm('suspend')}
                        disabled={isOwner}
                      >
                        <ShieldAlert className="size-4" aria-hidden />
                        {t('team.drawer.suspend')}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => setConfirm('restore')}>
                        {t('team.drawer.restore')}
                      </Button>
                    ))}
                </div>
                {isOwner && viewer.canManage && (
                  <p className="text-xs text-fg-2">{t('team.drawer.ownerNoSuspend')}</p>
                )}
              </div>
            </Section>

            <Section
              title={t('common.departments')}
              description={t('team.drawer.departmentsHint')}
            >
              {!departments ? (
                <p className="text-sm text-fg-2">{t('team.drawer.departmentsUnavailable')}</p>
              ) : deptList.length === 0 ? (
                <p className="text-sm text-fg-2">{t('team.drawer.noDepartments')}</p>
              ) : (
                <fieldset disabled={!viewer.canManage} className="flex flex-col">
                  <legend className="sr-only">{t('team.drawer.departmentAccessFor', { name: isolate(agent.displayName) })}</legend>
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-line-subtle pb-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
                    <span>{t('common.department')}</span>
                    <span className="w-16 text-center">{t('team.drawer.serve')}</span>
                    <span className="w-16 text-center">{t('team.drawer.monitor')}</span>
                  </div>
                  {deptList.map((d) => {
                    const f = value.departments[d.id] ?? { serve: false, monitor: false };
                    const setFlag = (k: 'serve' | 'monitor', v: boolean) =>
                      set({ departments: { ...value.departments, [d.id]: { ...f, [k]: v } } });
                    return (
                      <div
                        key={d.id}
                        className="grid min-h-11 grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-line-subtle last:border-b-0"
                      >
                        <span className="min-w-0 truncate text-sm">
                          <bdi>{d.name}</bdi>
                          {d.archivedAt && <span className="ms-1 text-xs text-fg-2">{t('team.drawer.archived')}</span>}
                          {!d.enabled && !d.archivedAt && (
                            <span className="ms-1 text-xs text-fg-2">{t('team.drawer.disabled')}</span>
                          )}
                        </span>
                        <span className="flex w-16 justify-center">
                          <Checkbox
                            checked={f.serve}
                            onCheckedChange={(c) => setFlag('serve', c === true)}
                            aria-label={t('team.drawer.serveAria', { name: isolate(d.name) })}
                            className="relative after:absolute after:-inset-[13px] after:content-['']"
                          />
                        </span>
                        <span className="flex w-16 justify-center">
                          <Checkbox
                            checked={f.monitor}
                            onCheckedChange={(c) => setFlag('monitor', c === true)}
                            aria-label={t('team.drawer.monitorAria', { name: isolate(d.name) })}
                            className="relative after:absolute after:-inset-[13px] after:content-['']"
                          />
                        </span>
                      </div>
                    );
                  })}
                </fieldset>
              )}
              {diff.departments && (
                <Banner tone="info">
                  {isSelf
                    ? t('team.drawer.deptChangeSelf')
                    : t('team.drawer.deptChangeOther', { name: isolate(agent.displayName) })}
                </Banner>
              )}
            </Section>

            <Section
              title={t('team.drawer.capacity')}
              description={t('team.drawer.capacityHint', { min: CAPACITY_MIN, max: CAPACITY_MAX })}
            >
              <Field
                label={t('team.invite.capacity')}
                error={errors.capacity}
                description={t('team.drawer.currentLoad', { count: agent.activeChats })}
              >
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label={t('team.drawer.decrease')}
                    disabled={!viewer.canManage || value.capacity <= CAPACITY_MIN}
                    onClick={() =>
                      set({
                        capacity: Math.max(
                          CAPACITY_MIN,
                          (Number.isFinite(value.capacity) ? value.capacity : CAPACITY_MIN) - 1,
                        ),
                      })
                    }
                  >
                    <Minus className="size-4" />
                  </Button>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={CAPACITY_MIN}
                    max={CAPACITY_MAX}
                    step={1}
                    className="w-20 text-center tabular"
                    value={Number.isFinite(value.capacity) ? value.capacity : ''}
                    disabled={!viewer.canManage}
                    onChange={(e) =>
                      set({ capacity: e.target.value === '' ? Number.NaN : Number(e.target.value) })
                    }
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label={t('team.drawer.increase')}
                    disabled={!viewer.canManage || value.capacity >= CAPACITY_MAX}
                    onClick={() =>
                      set({
                        capacity: Math.min(
                          CAPACITY_MAX,
                          (Number.isFinite(value.capacity) ? value.capacity : 0) + 1,
                        ),
                      })
                    }
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
              </Field>
              {Number.isFinite(value.capacity) && value.capacity < agent.activeChats && (
                <Banner tone="warning">{t('team.drawer.belowLoad', { capacity: value.capacity })}</Banner>
              )}
            </Section>
          </div>
        </DrawerContent>
      </Dialog>

      <ConfirmDialog
        open={confirm === 'suspend'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('team.drawer.suspendTitle', { name: isolate(agent.displayName) })}
        danger
        confirmLabel={t('team.drawer.suspend')}
        description={t('team.drawer.suspendBody', { email: isolate(agent.email) })}
        onConfirm={() => setEnabled(false)}
      >
        {agent.activeChats > 0 && (
          <Banner tone="warning">{t('team.drawer.suspendOwnsChats', { name: isolate(agent.displayName), count: agent.activeChats })}</Banner>
        )}
        {isSelf && (
          <Banner tone="warning">{t('team.drawer.suspendSelf')}</Banner>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'restore'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('team.drawer.restoreTitle', { name: isolate(agent.displayName) })}
        confirmLabel={t('team.drawer.restore')}
        description={t('team.drawer.restoreBody')}
        onConfirm={() => setEnabled(true)}
      />
    </>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 border-t border-line-subtle pt-5 first:border-t-0 first:pt-0"
      aria-label={title}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && <p className="text-xs text-fg-2">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function RoleSummary({ role }: { role: Role }) {
  const t = useT();
  const s = ROLE_SUMMARY[role];
  return (
    <div className="rounded-[var(--radius-control)] bg-surface-2 p-3 text-sm" aria-live="polite">
      <p className="font-medium">
        {t(ROLE_LABEL[role])}: <span className="font-normal text-fg-2">{t(s.summary)}</span>
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {s.can.map((c) => (
          <li key={c} className="flex gap-2">
            <span className="text-success" aria-hidden>
              ✓
            </span>
            <span>
              <span className="sr-only">{t('team.roleSummary.srCan')} </span>
              {t(c)}
            </span>
          </li>
        ))}
        {s.cannot.map((c) => (
          <li key={c} className="flex gap-2 text-fg-2">
            <span aria-hidden>✕</span>
            <span>
              <span className="sr-only">{t('team.roleSummary.srCannot')} </span>
              {t(c)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
