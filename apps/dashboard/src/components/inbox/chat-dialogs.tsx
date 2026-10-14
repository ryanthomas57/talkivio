'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Avatar,
  Banner,
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  Field,
  RadioGroup,
  Select,
  StatusIcon,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { uuid } from '@/lib/ids';
import { qk, useAgents, useDepartments } from '@/lib/queries';
import { realtime } from '@/lib/realtime';
import type { EffectiveStatus, StaffChat } from '@/lib/types';
import { useInbox } from '@/stores/inbox';
import { useSession } from '@/stores/session';

const STATUS_LABEL: Record<EffectiveStatus, MessageKey> = {
  online: 'inbox.dialogs.status.online',
  away: 'inbox.dialogs.status.away',
  invisible: 'inbox.dialogs.status.invisible',
  offline: 'inbox.dialogs.status.offline',
};

/** Seconds an agent has to accept a transfer offer (ch. 15). */
const TRANSFER_OFFER_SECONDS = 30;

/**
 * Transfer (ch. 15): to an eligible agent (30 s offer; ownership unchanged until
 * accepted) or to a department (requeues with the original request time). The
 * dialog shows load and availability; supervisors may force with a reason.
 */
export function TransferDialog({
  chat,
  open,
  onOpenChange,
}: {
  chat: StaffChat;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const me = useSession((s) => s.agent?.agent.id);
  const canForce = useSession((s) => s.permissions.has('chats.force_transfer'));
  const agents = useAgents(open);
  const departments = useDepartments(open);
  const qc = useQueryClient();
  const [tab, setTab] = useState<'agent' | 'department'>('agent');
  const [agentId, setAgentId] = useState<string>('');
  const [deptId, setDeptId] = useState<string>('');
  const [note, setNote] = useState('');
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => uuid());

  const notOwner = chat.ownerMembershipId !== me;
  const candidates = useMemo(
    () =>
      (agents.data ?? [])
        .filter((a) => a.id !== chat.ownerMembershipId && a.enabled)
        .map((a) => ({
          a,
          eligible: a.effectiveStatus === 'online' && a.connected && a.activeChats < a.capacity,
        }))
        .sort(
          (x, y) =>
            Number(y.eligible) - Number(x.eligible) ||
            x.a.activeChats / x.a.capacity - y.a.activeChats / y.a.capacity,
        ),
    [agents.data, chat.ownerMembershipId],
  );
  const depts = (departments.data ?? []).filter((d) => !d.archivedAt);
  const target =
    tab === 'agent'
      ? candidates.find((c) => c.a.id === agentId)?.a.displayName
      : depts.find((d) => d.id === deptId)?.name;

  const submit = async () => {
    setError(null);
    if (tab === 'agent' && !agentId) return setError(t('inbox.dialogs.chooseAgentError'));
    if (tab === 'department' && !deptId) return setError(t('inbox.transfer.chooseDepartmentError'));
    if ((force || notOwner) && !reason.trim()) return setError(t('inbox.transfer.reasonRequired'));
    setBusy(true);
    try {
      await api.post(
        `/chats/${chat.id}/transfers`,
        {
          targetAgentId: tab === 'agent' ? agentId : null,
          targetDepartmentId: tab === 'department' ? deptId : null,
          note: note.trim() || null,
          expectedVersion: chat.version,
          force: force || notOwner || undefined,
          reason: force || notOwner ? reason.trim() : null,
        },
        { idempotencyKey: key },
      );
      void useInbox.getState().loadChat(chat.id);
      void qc.invalidateQueries({ queryKey: qk.agents });
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) {
        void useInbox.getState().loadChat(chat.id);
        setError(t('inbox.transfer.conflict'));
      } else if (isApiError(e, 'CAPACITY_EXCEEDED'))
        setError(
          target
            ? t('inbox.transfer.targetAtCapacity', { name: isolate(target) })
            : t('inbox.transfer.agentAtCapacity'),
        );
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title={t('inbox.transfer.title', { name: isolate(chat.visitor.displayName) })}
        description={
          tab === 'agent'
            ? t('inbox.transfer.agentDescription', { seconds: TRANSFER_OFFER_SECONDS })
            : t('inbox.transfer.departmentDescription')
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              loading={busy}
              disabled={tab === 'agent' ? !agentId : !deptId}
            >
              {target
                ? t('inbox.transfer.submitTo', { target: isolate(target) })
                : t('inbox.transfer.submit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error}</Banner>}
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'agent' | 'department')}>
            <TabsList>
              <TabsTrigger value="agent">{t('common.agent')}</TabsTrigger>
              <TabsTrigger value="department">{t('common.department')}</TabsTrigger>
            </TabsList>
            <TabsContent value="agent" className="pt-3">
              {agents.isLoading ? (
                <p className="text-sm text-fg-2">{t('inbox.transfer.loadingAgents')}</p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-fg-2">{t('inbox.transfer.noAgents')}</p>
              ) : (
                <fieldset>
                  <legend className="sr-only">{t('inbox.dialogs.chooseAgent')}</legend>
                  <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto scroll-thin">
                    {candidates.map(({ a, eligible }) => (
                      <li key={a.id}>
                        <label
                          className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 ${agentId === a.id ? 'border-primary bg-primary-tint/50' : 'border-line hover:bg-surface-2'} ${!eligible ? 'opacity-70' : ''}`}
                        >
                          <input
                            type="radio"
                            name="transfer-agent"
                            value={a.id}
                            checked={agentId === a.id}
                            onChange={() => setAgentId(a.id)}
                            disabled={!eligible && !canForce}
                            className="size-4 accent-[var(--primary)]"
                          />
                          <Avatar name={a.displayName} src={a.avatarUrl} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium" dir="auto">
                              {a.displayName}
                            </span>
                            <span className="flex items-center gap-1.5 text-xs text-fg-2">
                              <StatusIcon status={a.effectiveStatus} />{' '}
                              {a.effectiveStatus === 'online' && !eligible
                                ? t('inbox.transfer.atCapacity')
                                : t(STATUS_LABEL[a.effectiveStatus])}
                            </span>
                          </span>
                          <span className="text-xs tabular text-fg-2">
                            {t('inbox.transfer.load', { active: a.activeChats, capacity: a.capacity })}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
            </TabsContent>
            <TabsContent value="department" className="pt-3">
              <Field label={t('common.department')}>
                <Select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
                  <option value="">{t('inbox.transfer.chooseDepartment')}</option>
                  {depts.map((d) => (
                    <option key={d.id} value={d.id} disabled={!d.enabled}>
                      {typeof d.queued === 'number'
                        ? t(d.enabled ? 'inbox.transfer.deptWaiting' : 'inbox.transfer.deptDisabledWaiting', {
                            name: isolate(d.name),
                            count: d.queued,
                          })
                        : d.enabled
                          ? d.name
                          : t('inbox.transfer.deptDisabled', { name: isolate(d.name) })}
                    </option>
                  ))}
                </Select>
              </Field>
            </TabsContent>
          </Tabs>
          <Field label={t('inbox.transfer.handoffNote')} description={t('inbox.transfer.handoffNoteHelp')}>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              className="min-h-20"
              dir="auto"
            />
          </Field>
          {canForce && !notOwner && (
            <CheckboxField
              label={t('inbox.transfer.force')}
              description={t('inbox.transfer.forceHelp')}
              checked={force}
              onCheckedChange={(v) => setForce(v === true)}
            />
          )}
          {(force || notOwner) && (
            <Field label={t('inbox.dialogs.reason')} description={t('inbox.transfer.reasonHelp')} required>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                className="min-h-16"
                dir="auto"
              />
            </Field>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Invite a collaborator (consumes one capacity slot on their side by default). */
export function InviteDialog({
  chat,
  open,
  onOpenChange,
}: {
  chat: StaffChat;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const agents = useAgents(open);
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = (agents.data ?? []).filter(
    (a) => a.enabled && a.id !== chat.ownerMembershipId && !chat.collaboratorIds.includes(a.id),
  );
  const submit = async () => {
    if (!agentId) return setError(t('inbox.dialogs.chooseAgentError'));
    setBusy(true);
    setError(null);
    try {
      await api.post(`/chats/${chat.id}/collaborators`, { membershipId: agentId });
      void useInbox.getState().loadChat(chat.id);
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e, 'CAPACITY_EXCEEDED') ? t('inbox.invite.noCapacity') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={t('inbox.invite.title')}
        description={t('inbox.invite.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} loading={busy} disabled={!agentId}>
              {t('inbox.invite.submit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error}</Banner>}
          <Field label={t('common.agent')}>
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">{t('inbox.dialogs.chooseAgent')}</option>
              {options.map((a) => (
                <option key={a.id} value={a.id} disabled={a.effectiveStatus === 'offline'}>
                  {t('inbox.invite.option', {
                    name: isolate(a.displayName),
                    status: t(STATUS_LABEL[a.effectiveStatus]),
                    active: a.activeChats,
                    capacity: a.capacity,
                  })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const END_REASONS = [
  { value: 'resolved', label: 'inbox.end.resolved', description: 'inbox.end.resolvedHelp' },
  {
    value: 'visitor_unresponsive',
    label: 'inbox.end.unresponsive',
    description: 'inbox.end.unresponsiveHelp',
  },
  { value: 'spam', label: 'inbox.end.spam', description: 'inbox.end.spamHelp' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey; description: MessageKey }>;

/** End chat: confirmation names the visitor and the consequence (ch. 16). */
export function EndChatDialog({
  chat,
  open,
  onOpenChange,
}: {
  chat: StaffChat;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState<(typeof END_REASONS)[number]['value']>('resolved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = realtime.connected
        ? await realtime.command<StaffChat>(
            'chat.close',
            { chatId: chat.id, reason },
            { expectedVersion: chat.version },
          )
        : (
            await api.post<{ chat: StaffChat }>(`/chats/${chat.id}/close`, {
              reason,
              expectedVersion: chat.version,
            })
          ).chat;
      if (res && 'id' in res) useInbox.getState().upsertChat(res as StaffChat);
      else void useInbox.getState().loadChat(chat.id);
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) {
        void useInbox.getState().loadChat(chat.id);
        setError(t('inbox.end.conflict'));
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        title={t('inbox.end.title', { name: isolate(chat.visitor.displayName) })}
        description={
          chat.visitor.online ? t('inbox.end.onlineDescription') : t('inbox.end.offlineDescription')
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={submit} loading={busy}>
              {t('inbox.end.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Banner tone="danger">{error}</Banner>}
          <RadioGroup
            legend={t('inbox.dialogs.reason')}
            name={`end-${chat.id}`}
            value={reason}
            onChange={setReason}
            options={END_REASONS.map((r) => ({
              value: r.value,
              label: t(r.label),
              description: t(r.description),
            }))}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
