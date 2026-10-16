'use client';
import { BellRing, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BRAND_NAME } from '@/components/brand';
import { enableDesktopNotifications, playChime } from '@/components/inbox/attention';
import { Badge, Banner, Button, Card, CardBody, CardHeader, RadioGroup, SwitchField } from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import type { AgentMe } from '@/lib/types';
import { useSession } from '@/stores/session';
import { isEqual, SaveBar } from '../form-kit';

interface PrefsForm {
  sound: boolean;
  desktopNotifications: boolean;
  visitorAlerts: boolean;
  privacyMode: boolean;
  theme: 'light' | 'dark' | 'system';
  sendOnEnter: boolean;
}

type Permission = NotificationPermission | 'unsupported';

function currentPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

const PERMISSION_LABEL: Record<
  Permission,
  { text: MessageKey; tone: 'success' | 'danger' | 'neutral' | 'warning' }
> = {
  granted: { text: 'settings.prefs.permission.granted', tone: 'success' },
  denied: { text: 'settings.prefs.permission.denied', tone: 'danger' },
  default: { text: 'settings.prefs.permission.default', tone: 'warning' },
  unsupported: { text: 'settings.prefs.permission.unsupported', tone: 'neutral' },
};

/** Notification and workspace preferences (ch. 14); saved per membership. */
export function PreferencesCard({
  onDirtyChange,
  registerSave,
}: {
  onDirtyChange: (d: boolean) => void;
  registerSave: (fn: () => Promise<boolean>) => void;
}) {
  const t = useT();
  const agent = useSession((s) => s.agent);
  const setAgent = useSession((s) => s.setAgent);
  const baseline = useMemo<PrefsForm | null>(() => {
    if (!agent) return null;
    const p = agent.preferences;
    return {
      sound: !!p.sound,
      desktopNotifications: !!p.desktopNotifications,
      visitorAlerts: p.visitorAlerts !== false,
      privacyMode: !!p.privacyMode,
      theme: (p.theme as PrefsForm['theme']) ?? 'system',
      sendOnEnter: p.sendOnEnter !== false,
    };
  }, [agent]);
  const [draft, setDraft] = useState<PrefsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [permission, setPermission] = useState<Permission>('default');
  const [asking, setAsking] = useState(false);
  const value = draft ?? baseline;
  const dirty = !!draft && !!baseline && !isEqual(draft, baseline);

  useEffect(() => setPermission(currentPermission()), []);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const set = (patch: Partial<PrefsForm>) => value && setDraft({ ...value, ...patch });

  const save = async (): Promise<boolean> => {
    if (!draft || !baseline || !dirty) return true;
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([k, v]) => baseline[k as keyof PrefsForm] !== v),
    );
    setSaving(true);
    setMessage(null);
    try {
      const next = await api.patch<AgentMe>('/agents/me/preferences', changed);
      setAgent(next);
      setDraft(null);
      toast.success(t('settings.prefs.saved'));
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

  const askPermission = async () => {
    setAsking(true);
    try {
      const p = await enableDesktopNotifications();
      setPermission(p);
      if (p === 'granted' && value && !value.desktopNotifications) set({ desktopNotifications: true });
    } finally {
      setAsking(false);
    }
  };

  if (!value) return null;
  const perm = PERMISSION_LABEL[permission];

  return (
    <Card>
      <CardHeader title={t('settings.prefs.title')} description={t('settings.prefs.description')} />
      <CardBody className="flex flex-col gap-2">
        {message && <Banner tone="danger">{message}</Banner>}
        <div className="flex flex-col gap-1 border-b border-line-subtle pb-3">
          <SwitchField
            label={t('settings.prefs.sound')}
            description={t('settings.prefs.soundHint')}
            checked={value.sound}
            onCheckedChange={(v) => set({ sound: v })}
          />
          <div>
            <Button size="sm" variant="secondary" onClick={() => playChime('queue')}>
              <Volume2 className="size-3.5" aria-hidden />
              {t('settings.prefs.playPreview')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-b border-line-subtle pb-3">
          <SwitchField
            label={t('settings.prefs.desktop')}
            description={t('settings.prefs.desktopHint', { brand: BRAND_NAME })}
            checked={value.desktopNotifications}
            onCheckedChange={(v) => set({ desktopNotifications: v })}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={perm.tone}>{t(perm.text)}</Badge>
            {permission === 'default' && (
              <Button size="sm" variant="secondary" onClick={() => void askPermission()} loading={asking}>
                <BellRing className="size-3.5" aria-hidden />
                {t('settings.prefs.enable')}
              </Button>
            )}
          </div>
          {permission === 'denied' && value.desktopNotifications && (
            <p className="text-xs text-fg-2">{t('settings.prefs.blocked')}</p>
          )}
          {permission === 'default' && value.desktopNotifications && (
            <p className="text-xs text-fg-2">{t('settings.prefs.notYetAllowed')}</p>
          )}
        </div>
        <div className="flex flex-col gap-1 border-b border-line-subtle pb-3">
          <SwitchField
            label={t('settings.prefs.visitorAlerts')}
            description={t('settings.prefs.visitorAlertsHint', { brand: BRAND_NAME })}
            checked={value.visitorAlerts}
            onCheckedChange={(v) => set({ visitorAlerts: v })}
          />
          <div>
            <Button size="sm" variant="secondary" onClick={() => playChime('visitor')}>
              <Volume2 className="size-3.5" aria-hidden />
              {t('settings.prefs.playVisitorPreview')}
            </Button>
          </div>
        </div>
        <div className="border-b border-line-subtle pb-3">
          <SwitchField
            label={t('settings.prefs.privacy')}
            description={t('settings.prefs.privacyHint')}
            checked={value.privacyMode}
            onCheckedChange={(v) => set({ privacyMode: v })}
          />
        </div>
        <div className="border-b border-line-subtle pb-3">
          <SwitchField
            label={t('settings.prefs.sendOnEnter')}
            description={
              value.sendOnEnter ? t('settings.prefs.sendOnEnterOn') : t('settings.prefs.sendOnEnterOff')
            }
            checked={value.sendOnEnter}
            onCheckedChange={(v) => set({ sendOnEnter: v })}
          />
        </div>
        <RadioGroup
          legend={t('settings.prefs.theme')}
          name="theme"
          value={value.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'light', label: t('settings.prefs.themeLight') },
            { value: 'dark', label: t('settings.prefs.themeDark') },
            {
              value: 'system',
              label: t('settings.prefs.themeSystem'),
              description: t('settings.prefs.themeSystemHint'),
            },
          ]}
          className="pt-2"
        />
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => (setDraft(null), setMessage(null))}
      />
    </Card>
  );
}
