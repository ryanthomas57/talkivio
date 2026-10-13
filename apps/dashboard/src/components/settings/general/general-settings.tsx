'use client';
import { useState, type ReactNode } from 'react';
import { Banner, Card, CardBody, CardHeader, ConfirmDialog, Field, Input, Page, PageHeader, Select, Skeleton, SwitchField, TimezonePicker } from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { isolate, useT } from '@/i18n';
import { formatNumber } from '@/lib/format';
import type { Tenant } from '@/lib/types';
import { useCan, useSession } from '@/stores/session';
import { ChipsInput, checkInt, ConflictBanner, NumberInput, SaveBar } from '../form-kit';
import { useTenantSection, type TenantPatchBody, type TenantSection } from '../use-tenant-section';

/** Drop empty settings groups so a PATCH only names the sections it changes. */
function body(top: Omit<TenantPatchBody, 'settings'>, settings: Record<string, Record<string, unknown>>): TenantPatchBody {
  const groups = Object.fromEntries(Object.entries(settings).filter(([, v]) => Object.keys(v).length > 0));
  const out: TenantPatchBody = Object.fromEntries(Object.entries(top).filter(([, v]) => v !== undefined));
  if (Object.keys(groups).length) out.settings = groups;
  return out;
}

const pick = <T extends Record<string, unknown>>(changed: Partial<T>, keys: Array<keyof T>) => Object.fromEntries(keys.filter((k) => k in changed).map((k) => [k, changed[k]]));

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;
const IPV6 = /^(?=.*:.*:)[0-9a-f:]{2,39}(\/(\d|[1-9]\d|1[01]\d|12[0-8]))?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PARAM = /^[A-Za-z0-9_.\-[\]]{1,64}$/;

// ───────────────────────── Section definitions ─────────────────────────

type WorkspaceForm = { name: string; timezone: string; weekStartsOn: 0 | 1 };
function useWorkspaceSection() {
  const t = useT();
  return useTenantSection<WorkspaceForm>({
    title: t('settings.general.workspace.title'),
    select: (tn) => ({ name: tn.name, timezone: tn.timezone || tn.settings.locale.timezone, weekStartsOn: tn.settings.locale.weekStartsOn }),
    paths: { name: 'name', timezone: 'timezone', weekStartsOn: 'settings.locale.weekStartsOn' },
    validate: (v) => ({ name: !v.name.trim() ? t('settings.general.workspace.nameRequired') : v.name.trim().length > 120 ? t('settings.general.workspace.nameTooLong', { max: formatNumber(120) }) : null, timezone: v.timezone ? null : t('settings.general.workspace.timezoneRequired') }),
    toPatch: (c, v) =>
      body(
        { name: 'name' in c ? v.name.trim() : undefined, timezone: 'timezone' in c ? v.timezone : undefined },
        { locale: { ...('timezone' in c ? { timezone: v.timezone } : {}), ...pick(c, ['weekStartsOn']) } },
      ),
  });
}

type ChatForm = Pick<Tenant['settings']['chat'], 'idleTimeoutMinutes' | 'reconnectGraceSeconds' | 'offerOfflineAfterSeconds' | 'readReceipts' | 'allowVisitorEndChat' | 'requestRatingOnEnd' | 'maskCreditCards' | 'allowAttachments' | 'maxAttachmentMb'>;
const CHAT_KEYS: Array<keyof ChatForm> = ['idleTimeoutMinutes', 'reconnectGraceSeconds', 'offerOfflineAfterSeconds', 'readReceipts', 'allowVisitorEndChat', 'requestRatingOnEnd', 'maskCreditCards', 'allowAttachments', 'maxAttachmentMb'];
function useChatSection() {
  const t = useT();
  return useTenantSection<ChatForm>({
    title: t('settings.general.chat.title'),
    select: (tn) => Object.fromEntries(CHAT_KEYS.map((k) => [k, tn.settings.chat[k]])) as ChatForm,
    paths: Object.fromEntries(CHAT_KEYS.map((k) => [k, `settings.chat.${k}`])) as Record<keyof ChatForm, string>,
    validate: (v) => ({
      idleTimeoutMinutes: checkInt(v.idleTimeoutMinutes, 1, 1440, 'minutes'),
      reconnectGraceSeconds: checkInt(v.reconnectGraceSeconds, 60, 1800, 'seconds'),
      offerOfflineAfterSeconds: checkInt(v.offerOfflineAfterSeconds, 0, 3600, 'seconds'),
      maxAttachmentMb: checkInt(v.maxAttachmentMb, 1, 10, 'mb'),
    }),
    toPatch: (c) => body({}, { chat: c }),
  });
}

type TrackingForm = Tenant['settings']['tracking'];
const TRACKING_KEYS: Array<keyof TrackingForm> = ['analyticsConsentRequired', 'queryAllowlist', 'locationEnabled', 'pageEventRetentionDays'];
function useTrackingSection() {
  const t = useT();
  return useTenantSection<TrackingForm>({
    title: t('settings.general.tracking.title'),
    select: (tn) => Object.fromEntries(TRACKING_KEYS.map((k) => [k, tn.settings.tracking[k]])) as TrackingForm,
    paths: Object.fromEntries(TRACKING_KEYS.map((k) => [k, `settings.tracking.${k}`])) as Record<keyof TrackingForm, string>,
    validate: (v) => ({ pageEventRetentionDays: checkInt(v.pageEventRetentionDays, 1, 365, 'days'), queryAllowlist: v.queryAllowlist.length > 20 ? t('settings.general.tracking.paramsLimit', { count: 20 }) : null }),
    toPatch: (c) => body({}, { tracking: c }),
  });
}

type OfflineForm = { rateLimitPerHour: number; emailOfflineMessages: boolean; offlineMessageRecipients: string[] };
function useOfflineSection() {
  const t = useT();
  return useTenantSection<OfflineForm>({
    title: t('settings.general.offline.title'),
    select: (tn) => ({ rateLimitPerHour: tn.settings.offline.rateLimitPerHour, emailOfflineMessages: tn.settings.notifications.emailOfflineMessages, offlineMessageRecipients: tn.settings.notifications.offlineMessageRecipients }),
    paths: { rateLimitPerHour: 'settings.offline.rateLimitPerHour', emailOfflineMessages: 'settings.notifications.emailOfflineMessages', offlineMessageRecipients: 'settings.notifications.offlineMessageRecipients' },
    validate: (v) => ({ rateLimitPerHour: checkInt(v.rateLimitPerHour, 1, 100, 'perHour'), offlineMessageRecipients: v.offlineMessageRecipients.length > 20 ? t('settings.general.offline.recipientsLimit', { count: 20 }) : null }),
    toPatch: (c) => body({}, { offline: pick(c, ['rateLimitPerHour']), notifications: pick(c, ['emailOfflineMessages', 'offlineMessageRecipients']) }),
  });
}

type AnalyticsForm = { excludeQuickCancellations: boolean };
function useAnalyticsSection() {
  const t = useT();
  return useTenantSection<AnalyticsForm>({
    title: t('settings.general.analytics.title'),
    select: (tn) => ({ excludeQuickCancellations: tn.settings.analytics.excludeQuickCancellations }),
    paths: { excludeQuickCancellations: 'settings.analytics.excludeQuickCancellations' },
    toPatch: (c) => body({}, { analytics: c }),
  });
}

type SecurityForm = { requireMfa: boolean; sessionTimeoutHours: number; ipAllowlist: string[] };
function useSecuritySection() {
  const t = useT();
  return useTenantSection<SecurityForm>({
    title: t('settings.general.security.title'),
    select: (tn) => ({ requireMfa: tn.settings.security.requireMfa, sessionTimeoutHours: tn.settings.security.sessionTimeoutHours, ipAllowlist: tn.settings.security.ipAllowlist }),
    paths: { requireMfa: 'settings.security.requireMfa', sessionTimeoutHours: 'settings.security.sessionTimeoutHours', ipAllowlist: 'settings.security.ipAllowlist' },
    validate: (v) => ({ sessionTimeoutHours: checkInt(v.sessionTimeoutHours, 1, 2160, 'hours'), ipAllowlist: v.ipAllowlist.length > 200 ? t('settings.general.security.networksLimit', { count: 200 }) : null }),
    toPatch: (c) => body({}, { security: c }),
  });
}

type RetentionForm = { retentionDays: number };
function useRetentionSection() {
  const t = useT();
  return useTenantSection<RetentionForm>({
    title: t('settings.general.retention.title'),
    select: (tn) => ({ retentionDays: tn.retentionDays }),
    paths: { retentionDays: 'retentionDays' },
    validate: (v) => ({ retentionDays: checkInt(v.retentionDays, 1, 3650, 'days') }),
    toPatch: (_c, v) => ({ retentionDays: v.retentionDays }),
  });
}

// ───────────────────────── Page ─────────────────────────

export function GeneralSettings() {
  const t = useT();
  const tenant = useSession((s) => s.tenant);
  const canManage = useCan('tenant.manage');
  const role = useSession((s) => s.me?.memberships.find((m) => m.tenantId === s.me?.activeTenantId)?.role);
  const mfaEnabled = useSession((s) => !!s.me?.user.mfaEnabled);
  const workspace = useWorkspaceSection();
  const chat = useChatSection();
  const tracking = useTrackingSection();
  const offline = useOfflineSection();
  const analytics = useAnalyticsSection();
  const security = useSecuritySection();
  const retention = useRetentionSection();
  const [retentionConfirm, setRetentionConfirm] = useState(false);

  const retentionLowered = !!tenant && retention.dirty && retention.value.retentionDays < tenant.retentionDays;
  const saveRetention = () => (retentionLowered ? (setRetentionConfirm(true), Promise.resolve(false)) : retention.save());

  const sections: Array<{ dirty: boolean; save: () => Promise<boolean> }> = [workspace, chat, tracking, offline, analytics, security];
  const anyDirty = sections.some((s) => s.dirty) || retention.dirty;
  const guard = useDirtyGuard(anyDirty, {
    what: t('settings.general.dirtyWhat'),
    onSave: async () => {
      let ok = true;
      for (const s of sections) if (s.dirty) ok = (await s.save()) && ok;
      if (retention.dirty) ok = (await saveRetention()) && ok;
      return ok;
    },
  });

  if (!tenant) return <GeneralSkeleton />;
  const ro = !canManage;
  const retentionEditable = canManage && (role === 'owner' || role === 'admin');

  return (
    <Page>
      {guard}
      <PageHeader title={t('settings.general.title')} description={t('settings.general.description')} />
      {ro && <Banner tone="info">{t('settings.general.readOnly')}</Banner>}

      <SectionCard id="workspace" title={t('settings.general.workspace.title')} description={t('settings.general.workspace.description')} section={workspace} readOnly={ro}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('settings.general.workspace.name')} required error={workspace.error('name')} className="sm:col-span-2">
            <Input value={workspace.value.name} maxLength={120} disabled={ro} onChange={(e) => workspace.set({ name: e.target.value })} autoComplete="organization" />
          </Field>
          <Field label={t('common.timezone')} description={t('settings.general.workspace.timezoneHint')} error={workspace.error('timezone')}>
            <TimezonePicker value={workspace.value.timezone} onChange={(tz) => workspace.set({ timezone: tz })} disabled={ro} />
          </Field>
          <Field label={t('settings.general.workspace.weekStart')} error={workspace.error('weekStartsOn')}>
            <Select value={String(workspace.value.weekStartsOn)} disabled={ro} onChange={(e) => workspace.set({ weekStartsOn: Number(e.target.value) as 0 | 1 })}>
              <option value="1">{t('settings.days.long.1')}</option>
              <option value="0">{t('settings.days.long.0')}</option>
            </Select>
          </Field>
        </div>
      </SectionCard>

      <SectionCard id="chat-behaviour" title={t('settings.general.chat.title')} description={t('settings.general.chat.description')} section={chat} readOnly={ro}>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label={t('settings.general.chat.idle')} description={t('settings.general.chat.idleHint', { min: formatNumber(1), max: formatNumber(1440) })} error={chat.error('idleTimeoutMinutes')}>
            <NumberInput value={chat.value.idleTimeoutMinutes} min={1} max={1440} suffix={t('settings.general.unit.minutes')} disabled={ro} onChange={(v) => chat.set({ idleTimeoutMinutes: v })} />
          </Field>
          <Field label={t('settings.general.chat.grace')} description={t('settings.general.chat.graceHint', { min: formatNumber(60), max: formatNumber(1800) })} error={chat.error('reconnectGraceSeconds')}>
            <NumberInput value={chat.value.reconnectGraceSeconds} min={60} max={1800} suffix={t('settings.general.unit.seconds')} disabled={ro} onChange={(v) => chat.set({ reconnectGraceSeconds: v })} />
          </Field>
          <Field label={t('settings.general.chat.offerOffline')} description={t('settings.general.chat.offerOfflineHint')} error={chat.error('offerOfflineAfterSeconds')}>
            <NumberInput value={chat.value.offerOfflineAfterSeconds} min={0} max={3600} suffix={t('settings.general.unit.seconds')} disabled={ro} onChange={(v) => chat.set({ offerOfflineAfterSeconds: v })} />
          </Field>
        </div>
        <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
          <SwitchField label={t('settings.general.chat.readReceipts')} description={t('settings.general.chat.readReceiptsHint')} checked={chat.value.readReceipts} disabled={ro} onCheckedChange={(v) => chat.set({ readReceipts: v })} />
          <SwitchField label={t('settings.general.chat.visitorEnd')} description={t('settings.general.chat.visitorEndHint')} checked={chat.value.allowVisitorEndChat} disabled={ro} onCheckedChange={(v) => chat.set({ allowVisitorEndChat: v })} />
          <SwitchField label={t('settings.general.chat.rating')} checked={chat.value.requestRatingOnEnd} disabled={ro} onCheckedChange={(v) => chat.set({ requestRatingOnEnd: v })} />
          <SwitchField label={t('settings.general.chat.maskCards')} description={t('settings.general.chat.maskCardsHint')} checked={chat.value.maskCreditCards} disabled={ro} onCheckedChange={(v) => chat.set({ maskCreditCards: v })} />
          <SwitchField label={t('settings.general.chat.attachments')} description={t('settings.general.chat.attachmentsHint')} checked={chat.value.allowAttachments} disabled={ro} onCheckedChange={(v) => chat.set({ allowAttachments: v })} />
        </div>
        <Field label={t('settings.general.chat.maxAttachment')} description={chat.value.allowAttachments ? t('settings.general.chat.maxAttachmentHint', { min: formatNumber(1), max: formatNumber(10) }) : t('settings.general.chat.maxAttachmentOff')} error={chat.error('maxAttachmentMb')} className="mt-2 max-w-xs">
          <NumberInput value={chat.value.maxAttachmentMb} min={1} max={10} suffix={t('settings.general.unit.mb')} disabled={ro || !chat.value.allowAttachments} onChange={(v) => chat.set({ maxAttachmentMb: v })} />
        </Field>
      </SectionCard>

      <SectionCard id="tracking-and-consent" title={t('settings.general.tracking.title')} description={t('settings.general.tracking.description')} section={tracking} readOnly={ro}>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <SwitchField
            label={t('settings.general.tracking.consent')}
            description={t('settings.general.tracking.consentHint')}
            checked={tracking.value.analyticsConsentRequired}
            disabled={ro}
            onCheckedChange={(v) => tracking.set({ analyticsConsentRequired: v })}
          />
          <SwitchField label={t('settings.general.tracking.location')} description={t('settings.general.tracking.locationHint')} checked={tracking.value.locationEnabled} disabled={ro} onCheckedChange={(v) => tracking.set({ locationEnabled: v })} />
        </div>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field label={t('settings.general.tracking.params')} description={t('settings.general.tracking.paramsHint', { count: 20 })} error={tracking.error('queryAllowlist')}>
            <ChipsInput
              values={tracking.value.queryAllowlist}
              onChange={(v) => tracking.set({ queryAllowlist: v })}
              disabled={ro}
              max={20}
              listLabel={t('settings.general.tracking.paramsList')}
              limitMessage={t('settings.general.tracking.paramsLimit', { count: 20 })}
              placeholder="utm_source" // i18n-ignore: example parameter name
              validate={(p) => (PARAM.test(p) ? null : t('settings.general.tracking.paramInvalid', { value: isolate(p) }))}
            />
          </Field>
          <Field label={t('settings.general.tracking.retention')} description={t('settings.general.tracking.retentionHint', { min: formatNumber(1), max: formatNumber(365) })} error={tracking.error('pageEventRetentionDays')}>
            <NumberInput value={tracking.value.pageEventRetentionDays} min={1} max={365} suffix={t('settings.general.unit.days')} disabled={ro} onChange={(v) => tracking.set({ pageEventRetentionDays: v })} />
          </Field>
        </div>
      </SectionCard>

      <SectionCard id="offline-messages" title={t('settings.general.offline.title')} description={t('settings.general.offline.description')} section={offline} readOnly={ro}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('settings.general.offline.rate')} description={t('settings.general.offline.rateHint', { min: formatNumber(1), max: formatNumber(100) })} error={offline.error('rateLimitPerHour')}>
            <NumberInput value={offline.value.rateLimitPerHour} min={1} max={100} suffix={t('settings.general.unit.perHour')} disabled={ro} onChange={(v) => offline.set({ rateLimitPerHour: v })} />
          </Field>
          <div>
            <SwitchField label={t('settings.general.offline.email')} description={t('settings.general.offline.emailHint')} checked={offline.value.emailOfflineMessages} disabled={ro} onCheckedChange={(v) => offline.set({ emailOfflineMessages: v })} />
          </div>
          <Field label={t('settings.general.offline.recipients')} description={t('settings.general.offline.recipientsHint', { count: 20 })} error={offline.error('offlineMessageRecipients')} className="sm:col-span-2">
            <ChipsInput
              values={offline.value.offlineMessageRecipients}
              onChange={(v) => offline.set({ offlineMessageRecipients: v })}
              disabled={ro}
              max={20}
              listLabel={t('settings.general.offline.recipientsList')}
              limitMessage={t('settings.general.offline.recipientsLimit', { count: 20 })}
              placeholder="team@example.com" // i18n-ignore: example address
              normalize={(s) => s.trim().toLowerCase()}
              validate={(e) => (EMAIL.test(e) && e.length <= 200 ? null : t('settings.general.offline.emailInvalid', { value: isolate(e) }))}
            />
          </Field>
        </div>
        {offline.value.emailOfflineMessages && offline.value.offlineMessageRecipients.length === 0 && (
          <Banner tone="warning" className="mt-4">
            {t('settings.general.offline.noRecipients')}
          </Banner>
        )}
      </SectionCard>

      <SectionCard id="analytics" title={t('settings.general.analytics.title')} description={t('settings.general.analytics.description')} section={analytics} readOnly={ro}>
        <SwitchField
          label={t('settings.general.analytics.quickCancel')}
          description={t('settings.general.analytics.quickCancelHint')}
          checked={analytics.value.excludeQuickCancellations}
          disabled={ro}
          onCheckedChange={(v) => analytics.set({ excludeQuickCancellations: v })}
        />
      </SectionCard>

      <SectionCard id="security" title={t('settings.general.security.title')} description={t('settings.general.security.description')} section={security} readOnly={ro}>
        <SwitchField
          label={t('settings.general.security.requireMfa')}
          description={t('settings.general.security.requireMfaHint')}
          checked={security.value.requireMfa}
          disabled={ro}
          onCheckedChange={(v) => security.set({ requireMfa: v })}
        />
        {security.value.requireMfa && !mfaEnabled && !ro && <Banner tone="warning">{t('settings.general.security.mfaSelfWarning')}</Banner>}
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field
            label={t('settings.general.security.session')}
            description={
              Number.isFinite(security.value.sessionTimeoutHours)
                ? t('settings.general.security.sessionHintValue', { length: formatHours(t, security.value.sessionTimeoutHours), min: formatNumber(1), max: formatNumber(2160) })
                : t('settings.general.security.sessionHint', { min: formatNumber(1), max: formatNumber(2160) })
            }
            error={security.error('sessionTimeoutHours')}
          >
            <NumberInput value={security.value.sessionTimeoutHours} min={1} max={2160} suffix={t('settings.general.unit.hours')} disabled={ro} onChange={(v) => security.set({ sessionTimeoutHours: v })} />
          </Field>
          <Field label={t('settings.general.security.networks')} description={t('settings.general.security.networksHint')} error={security.error('ipAllowlist')} className="sm:col-span-2">
            <ChipsInput
              values={security.value.ipAllowlist}
              onChange={(v) => security.set({ ipAllowlist: v })}
              disabled={ro}
              max={200}
              listLabel={t('settings.general.security.networksList')}
              limitMessage={t('settings.general.security.networksLimit', { count: 200 })}
              placeholder="203.0.113.0/24" // i18n-ignore: example CIDR
              validate={(ip) => (ip.length <= 64 && (IPV4.test(ip) || IPV6.test(ip)) ? null : t('settings.general.security.networkInvalid', { value: isolate(ip) }))}
            />
          </Field>
        </div>
        {security.value.ipAllowlist.length > 0 && !ro && <Banner tone="warning" className="mt-4">{t('settings.general.security.networksWarning')}</Banner>}
      </SectionCard>

      <SectionCard
        id="data-retention"
        title={t('settings.general.retention.title')}
        description={t('settings.general.retention.description')}
        section={retention}
        readOnly={!retentionEditable}
        onSave={saveRetention}
      >
        <Field
          label={t('settings.general.retention.keep')}
          description={t('settings.general.retention.keepHint', { min: formatNumber(1), max: formatNumber(3650) })}
          error={retention.error('retentionDays')}
          className="max-w-xl"
        >
          <NumberInput value={retention.value.retentionDays} min={1} max={3650} suffix={t('settings.general.unit.days')} disabled={!retentionEditable} onChange={(v) => retention.set({ retentionDays: v })} />
        </Field>
        {!retentionEditable && !ro && <p className="mt-3 text-sm text-fg-2">{t('settings.general.retention.ownersOnly')}</p>}
      </SectionCard>

      <ConfirmDialog
        open={retentionConfirm}
        onOpenChange={setRetentionConfirm}
        title={t('settings.general.retention.confirmTitle')}
        danger
        confirmLabel={t('settings.general.retention.confirmLabel', { count: retention.value.retentionDays })}
        description={t('settings.general.retention.confirmBody', { count: retention.value.retentionDays, current: formatNumber(tenant.retentionDays) })}
        onConfirm={async () => {
          // Failures (validation, conflict) stay visible on the card itself.
          await retention.save();
        }}
      />
    </Page>
  );
}

function formatHours(t: ReturnType<typeof useT>, h: number): string {
  if (h % 24 === 0) return t('settings.general.security.sessionDays', { count: h / 24 });
  return t('settings.general.security.sessionHours', { count: h });
}

function SectionCard<T extends Record<string, unknown>>({
  id,
  title,
  description,
  section,
  readOnly,
  onSave,
  children,
}: {
  /** Stable DOM id prefix (titles are translated, so they cannot be slugged). */
  id: string;
  title: string;
  description: string;
  section: TenantSection<T>;
  readOnly: boolean;
  onSave?: () => Promise<boolean>;
  children: ReactNode;
}) {
  const t = useT();
  const slug = id;
  return (
    <Card role="region" aria-labelledby={`${slug}-title`}>
      <CardHeader title={<span id={`${slug}-title`}>{title}</span>} description={description} />
      <CardBody className="flex flex-col gap-1">
        {section.conflict && <ConflictBanner onReload={section.reload} message={t('settings.general.conflict', { section: isolate(title) })} className="mb-3" />}
        {section.stale && (
          <Banner tone="info" className="mb-3">
            {t('settings.general.stale')}
          </Banner>
        )}
        {section.message && !section.conflict && (
          <Banner tone="danger" className="mb-3">
            {section.message}
          </Banner>
        )}
        {children}
      </CardBody>
      {!readOnly && <SaveBar dirty={section.dirty} saving={section.saving} onSave={() => void (onSave ?? section.save)()} onDiscard={section.discard} />}
    </Card>
  );
}

function GeneralSkeleton() {
  return (
    <Page aria-busy>
      <Skeleton className="h-9 w-48" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </div>
      ))}
    </Page>
  );
}
