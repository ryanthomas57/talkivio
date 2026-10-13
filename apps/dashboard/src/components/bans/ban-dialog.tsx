'use client';
/**
 * Create a ban (ch. 24): scope (visitor identity or exact IP, shown masked),
 * site scope, expiry, a staff-only reason, and whether to end an open chat.
 * Visitors only ever see a neutral "Service unavailable" message.
 */
import { useQueryClient } from '@tanstack/react-query';
import { ShieldBan } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Banner, Button, CheckboxField, Dialog, DialogContent, Field, Input, RadioGroup, Select, Textarea } from '@/components/ui';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useSites } from '@/lib/queries';
import { useSession } from '@/stores/session';
import { VisitorPicker } from '../visitors/visitor-picker';
import type { VisitorListItem } from '../visitors/types';
import { maskIp, type Ban } from './types';

type Target = 'visitor' | 'ip';
type Expiry = 'never' | '1h' | '24h' | '7d' | '30d' | '90d' | 'custom';
const EXPIRY: Array<{ value: Expiry; label: MessageKey; ms?: number }> = [
  { value: '24h', label: 'bans.expiry.24h', ms: 86_400_000 },
  { value: '1h', label: 'bans.expiry.1h', ms: 3_600_000 },
  { value: '7d', label: 'bans.expiry.7d', ms: 7 * 86_400_000 },
  { value: '30d', label: 'bans.expiry.30d', ms: 30 * 86_400_000 },
  { value: '90d', label: 'bans.expiry.90d', ms: 90 * 86_400_000 },
  { value: 'never', label: 'bans.expiry.never' },
  { value: 'custom', label: 'bans.expiry.custom' },
];

function expiryIso(kind: Expiry, custom: string): string | null | 'invalid' {
  if (kind === 'never') return null;
  if (kind === 'custom') {
    const d = new Date(custom);
    return custom && !Number.isNaN(d.getTime()) ? d.toISOString() : 'invalid';
  }
  return new Date(Date.now() + (EXPIRY.find((e) => e.value === kind)?.ms ?? 0)).toISOString();
}

export function BanDialog({ open, onOpenChange, visitor, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; visitor?: { id: string; displayName: string } | null; onCreated?: (b: Ban) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const canSites = useSession((s) => s.permissions.has('sites.view'));
  const sites = useSites(open);
  const [target, setTarget] = useState<Target>('visitor');
  const [picked, setPicked] = useState<VisitorListItem | null>(null);
  const [ip, setIp] = useState('');
  const [siteId, setSiteId] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('24h');
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [closeChat, setCloseChat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTarget('visitor');
    setPicked(null);
    setIp('');
    setSiteId('');
    setExpiry('24h');
    setCustom('');
    setReason('');
    setCloseChat(true);
    setError(null);
    setFieldErrors({});
  }, [open]);

  const visitorId = visitor?.id ?? picked?.id ?? null;
  const visitorName = visitor?.displayName ?? picked?.displayName ?? null;
  const masked = target === 'ip' && ip.trim() ? maskIp(ip) : null;
  const exp = expiryIso(expiry, custom);
  const selectedSite = siteId ? sites.data?.find((s) => s.id === siteId)?.name : undefined;
  const siteName = siteId ? (selectedSite ? isolate(selectedSite) : t('bans.dialog.selectedSite')) : t('bans.scope.allSites');

  const submit = async () => {
    const fe: Record<string, string> = {};
    if (target === 'visitor' && !visitorId) fe.visitor = t('bans.dialog.chooseVisitor');
    if (target === 'ip') {
      if (!ip.trim()) fe.ip = t('bans.dialog.ipRequired');
      else if (ip.includes('/') && !/\/(32|128)$/.test(ip.trim())) fe.ip = t('bans.dialog.noCidr');
      else if (!masked) fe.ip = t('bans.dialog.ipInvalid');
    }
    if (!reason.trim()) fe.reason = t('bans.dialog.reasonRequired');
    if (exp === 'invalid') fe.expiry = t('bans.dialog.expiryInvalid');
    else if (exp && Date.parse(exp) <= Date.now()) fe.expiry = t('bans.dialog.expiryPast');
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError(null);
    try {
      const ban = await api.post<Ban>('/bans', {
        visitorId: target === 'visitor' ? visitorId : undefined,
        ip: target === 'ip' ? ip.trim() : undefined,
        siteId: siteId || null,
        expiresAt: exp === 'invalid' ? null : exp,
        reason: reason.trim(),
        closeActiveChat: target === 'visitor' ? closeChat : undefined,
      });
      await qc.invalidateQueries({ queryKey: ['bans'] });
      const closed = ban.closedChatIds?.length ?? 0;
      toast.success(closed ? t('bans.dialog.createdClosed', { count: closed }) : t('bans.dialog.created'));
      onCreated?.(ban);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError) {
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.fieldErrors)) {
          const key = k === 'visitor_id' ? 'visitor' : k === 'expires_at' ? 'expiry' : k === 'ip_or_cidr' ? 'ip' : k;
          if (target === 'visitor' && key === 'ip') continue;
          if (target === 'ip' && key === 'visitor') continue;
          map[key] = v[0] ?? t('bans.dialog.invalid');
        }
        setFieldErrors(map);
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={visitor ? t('bans.dialog.titleVisitor', { name: isolate(visitor.displayName) }) : t('bans.dialog.title')}
        description={t('bans.dialog.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void submit()} loading={busy}>
              <ShieldBan className="size-4" aria-hidden /> {t('bans.page.create')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <RadioGroup<Target>
            legend={t('bans.col.scope')}
            name="ban-target"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'visitor', label: t('bans.target.visitorIdentity'), description: t('bans.dialog.visitorHint') },
              { value: 'ip', label: t('bans.dialog.ip'), description: t('bans.dialog.ipHint') },
            ]}
          />

          {target === 'visitor' ? (
            visitor ? (
              <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm">
                {t('bans.dialog.visitorLabel')} <bdi className="font-medium">{visitor.displayName}</bdi>
              </p>
            ) : (
              <VisitorPicker label={t('common.visitor')} value={picked} onChange={setPicked} error={fieldErrors.visitor} />
            )
          ) : (
            <div className="flex flex-col gap-2">
              <Field label={t('bans.dialog.ip')} required description={masked ? t('bans.dialog.shownAs', { masked: isolate(masked) }) : t('bans.dialog.ipFieldHint')} error={fieldErrors.ip}>
                <Input
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  placeholder="203.0.113.7" // i18n-ignore: example IP address
                  dir="ltr"
                />
              </Field>
              <Banner tone="warning">{t('bans.dialog.ipWarning')}</Banner>
            </div>
          )}

          <Field label={t('bans.dialog.sites')} description={canSites ? undefined : t('bans.dialog.sitesRoleHint')}>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!canSites}>
              <option value="">{t('bans.dialog.allSitesOption')}</option>
              {(sites.data ?? [])
                .filter((s) => !s.archivedAt)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {t('bans.dialog.onlySite', { name: s.name })}
                  </option>
                ))}
            </Select>
          </Field>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Field label={t('bans.col.expires')} className="flex-1" error={expiry !== 'custom' ? fieldErrors.expiry : undefined}>
              <Select value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                {EXPIRY.map((x) => (
                  <option key={x.value} value={x.value}>
                    {t(x.label)}
                  </option>
                ))}
              </Select>
            </Field>
            {expiry === 'custom' && (
              <Field label={t('bans.dialog.customExpiry')} className="flex-1" error={fieldErrors.expiry}>
                <Input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
              </Field>
            )}
          </div>

          <Field label={t('bans.col.reason')} required description={t('bans.dialog.reasonHint')} error={fieldErrors.reason}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} placeholder={t('bans.dialog.reasonPlaceholder')} dir="auto" />
          </Field>

          {target === 'visitor' && (
            <CheckboxField
              checked={closeChat}
              onCheckedChange={(c) => setCloseChat(c === true)}
              label={t('bans.dialog.closeChat')}
              description={t('bans.dialog.closeChatHint')}
            />
          )}

          <div className="rounded-[var(--radius-control)] border border-line-subtle bg-surface-2 px-3 py-2 text-sm text-fg-2" role="status">
            <p className="font-medium text-fg">{t('bans.dialog.effect')}</p>
            <p>
              {t('bans.dialog.effectBody', {
                target: target === 'visitor' ? (visitorName ? isolate(visitorName) : t('bans.dialog.selectedVisitor')) : masked ? t('bans.dialog.address', { masked: isolate(masked) }) : t('bans.dialog.theAddress'),
                site: siteName,
                until: exp && exp !== 'invalid' ? 'date' : exp === null ? 'never' : 'none',
                date: exp && exp !== 'invalid' ? formatDateTime(exp) : '',
              })}
              {target === 'visitor' && <> {closeChat ? t('bans.dialog.effectEnds') : t('bans.dialog.effectKeeps')}</>}
            </p>
          </div>

          {error && <Banner tone="danger">{error}</Banner>}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
