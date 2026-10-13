'use client';
import { ChevronDown, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, STATUS_META, StatusIcon, Tooltip } from '@/components/ui';
import { useConnectionState } from '@/hooks/use-realtime';
import { api, errorMessage } from '@/lib/api';
import type { AgentMe, AgentStatus } from '@/lib/types';
import { useT } from '@/i18n';
import { useCan, useSession } from '@/stores/session';

const CHOICES: AgentStatus[] = ['online', 'away', 'invisible'];

/**
 * Declared status (online / away / invisible) with its meaning explained; the
 * transport state is shown separately because "connected" is not a status (ch. 09).
 */
export function StatusMenu() {
  const t = useT();
  const canServe = useCan('chats.serve');
  const agent = useSession((s) => s.agent);
  const setAgent = useSession((s) => s.setAgent);
  const conn = useConnectionState();
  const [busy, setBusy] = useState(false);
  if (!agent || !canServe) return null;
  const status = agent.agent.desiredStatus;
  const interrupted = conn === 'reconnecting' || conn === 'offline';

  const change = async (next: string) => {
    if (next === status || busy) return;
    setBusy(true);
    try {
      await api.put('/agents/me/presence', { status: next });
      setAgent({ ...agent, agent: { ...agent.agent, desiredStatus: next as AgentStatus } } satisfies AgentMe);
    } catch (e) {
      toast.error(t('shell.status.changeFailed', { error: errorMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {interrupted && (
        <Tooltip content={t('shell.status.interruptedHelp')}>
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-tint px-2 py-1 text-xs font-medium text-warning" role="status">
            <WifiOff className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{t('shell.status.notConnected')}</span>
          </span>
        </Tooltip>
      )}
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-3"
            aria-label={t('shell.status.triggerLabel', { status: t(STATUS_META[status].label) })}
            disabled={busy}
          >
            <StatusIcon status={status} />
            <span className="hidden sm:inline">{t(STATUS_META[status].label)}</span>
            <ChevronDown className="size-4 text-fg-2" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent className="w-72">
          <MenuLabel>{t('shell.status.menuLabel')}</MenuLabel>
          <MenuRadioGroup value={status} onValueChange={(v) => void change(v)}>
            {CHOICES.map((s) => (
              <MenuRadioItem key={s} value={s} className="min-h-14 items-start py-2">
                <span className="flex gap-2.5">
                  <StatusIcon status={s} className="mt-1" />
                  <span className="flex flex-col">
                    <span className="font-medium">{t(STATUS_META[s].label)}</span>
                    <span className="text-xs text-fg-2">{t(STATUS_META[s].description)}</span>
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  );
}
