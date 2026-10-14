'use client';
/**
 * Visitor information beside a docked chat (classic live chat side panel): who they are, where they are, the
 * address and network they use, their device, how often they came and chatted, and the pages of this visit.
 */
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { countryName, flagEmoji, formatNumber, formatRelative, formatTime } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import type { StaffChat } from '@/lib/types';
import { useCan } from '@/stores/session';
import { DEVICE, originLabel, siteTitle, urlLabel } from '@/components/visitors/display';
import { visitorKeys, type VisitorProfile, type VisitorSessionRecord } from '@/components/visitors/types';
import { useVisitorProfile } from '@/components/visitors/use-visitor';
import type { DockVisitor } from '@/stores/dock';
import { useInbox } from '@/stores/inbox';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-xs text-fg-2">{label}</dt>
      <dd className="min-w-0 break-anywhere text-sm text-fg">{children}</dd>
    </div>
  );
}

function localTime(timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(
      new Date(),
    );
  } catch {
    return null;
  }
}

export function VisitorInfo({
  visitorId,
  chat,
  fallback,
}: {
  visitorId: string;
  chat?: StaffChat;
  fallback?: DockVisitor;
}) {
  const t = useT();
  const canView = useCan('visitors.view');
  const profile = useVisitorProfile(canView ? visitorId : null);
  const latest = useQuery({
    queryKey: [...visitorKeys.sessions(visitorId), 'latest'],
    queryFn: () => api.page<VisitorSessionRecord>(`/visitors/${visitorId}/sessions`, { limit: 1 }),
    enabled: canView,
    staleTime: 15_000,
    retry: false,
  });
  const departments = byId(useDepartments().data);
  const p = profile.data;
  const s = latest.data?.items[0];

  const name = p?.displayName ?? chat?.visitor.displayName ?? fallback?.name ?? t('common.visitor');
  const email = p?.fields.email?.value ?? null;
  const phone = p?.fields.phone?.value ?? null;
  const code =
    p?.location?.countryCode ?? s?.country ?? chat?.visitor.countryCode ?? fallback?.country ?? null;
  const place = [p?.location?.city, p?.location?.region, countryName(code)].filter(Boolean).join(', ');
  const ip = s?.ipAddress ?? fallback?.ipAddress ?? null;
  const device = s?.device ?? p?.device ?? null;
  const deviceLabel =
    device?.category && DEVICE[device.category] ? t(DEVICE[device.category]!.label) : device?.category;
  const deviceText = [deviceLabel, device?.browser, device?.os].filter(Boolean).join(' · ');
  const time = localTime(p?.timezone ?? null);
  const pages = s && !s.browsingHidden ? [...s.pages].reverse().slice(0, 10) : [];
  const dept = chat?.departmentId ? departments.get(chat.departmentId)?.name : null;

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="flex items-center gap-1.5 text-base font-semibold text-fg">
        <bdi className="truncate">{name}</bdi>
        {p?.verified && (
          <BadgeCheck className="size-4 shrink-0 text-success" aria-label={t('visitors.display.verified')} />
        )}
      </p>
      {p && !p.erased ? (
        <DetailsForm
          profile={p}
          onSaved={profile.setProfile}
          refetch={() => void profile.refetch()}
          chatId={chat?.id ?? null}
        />
      ) : (
        (email || phone) && (
          <div className="text-sm text-fg-2">
            {email && (
              <p className="truncate" dir="ltr">
                {email}
              </p>
            )}
            {phone && (
              <p className="truncate" dir="ltr">
                {phone}
              </p>
            )}
          </div>
        )
      )}

      <dl className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
        {place && (
          <Row label={t('dock.info.location')}>
            {flagEmoji(code) && <span className="me-1.5">{flagEmoji(code)}</span>}
            {place}
          </Row>
        )}
        {time && <Row label={t('dock.info.localTime')}>{time}</Row>}
        {ip && (
          <Row label={t('visitors.live.col.ip')}>
            <span className="font-mono text-xs" dir="ltr">
              {ip}
            </span>
            {s?.network && <span className="block text-xs text-fg-2">{s.network}</span>}
          </Row>
        )}
        {deviceText && <Row label={t('dock.info.device')}>{deviceText}</Row>}
        {p?.language && (
          <Row label={t('common.language')}>
            <span dir="ltr">{p.language}</span>
          </Row>
        )}
        {s && !s.browsingHidden && s.referrerOrigin && (
          <Row label={t('visitors.live.col.referrer')}>{originLabel(s.referrerOrigin)}</Row>
        )}
        {p && (
          <Row label={t('dock.info.history')}>
            {t('dock.info.visitsChats', {
              visits: formatNumber(p.visitCount),
              chats: formatNumber(p.chatCount),
            })}
          </Row>
        )}
        {chat && <Row label={t('common.department')}>{dept ? <bdi>{dept}</bdi> : t('common.none')}</Row>}
      </dl>

      {pages.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-2">
            {t('dock.info.path')}
          </h3>
          <ol className="flex flex-col">
            {pages.map((pg, i) => (
              <li key={`${pg.enteredAt}-${i}`} className="flex items-baseline gap-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto" title={urlLabel(pg.url)}>
                  {siteTitle(pg.title) || urlLabel(pg.url)}
                </span>
                <time dateTime={pg.enteredAt} className="shrink-0 text-xs text-fg-3">
                  {formatTime(pg.enteredAt)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      )}

      {canView && (
        <p className="text-xs text-fg-2">
          {p && t('dock.info.firstSeen', { when: formatRelative(p.firstSeenAt) })}{' '}
          <Link href={`/visitors/${visitorId}`} className="font-medium text-primary hover:underline">
            {t('inbox.visitor.openProfile')}
          </Link>
        </p>
      )}
    </div>
  );
}

type Details = { name: string; email: string; phone: string; notes: string };

/**
 * Name, email, phone and notes, editable beside the chat (classic live chat). Saved with the record's version so
 * two agents never overwrite each other; what an agent types is unverified identity, never proof.
 */
function DetailsForm({
  profile,
  onSaved,
  refetch,
  chatId,
}: {
  profile: VisitorProfile;
  onSaved: (p: unknown) => void;
  refetch: () => void;
  chatId: string | null;
}) {
  const t = useT();
  const canEdit = useCan('visitors.edit');
  const base: Details = {
    name: profile.fields.name?.value ?? '',
    email: profile.fields.email?.value ?? '',
    phone: profile.fields.phone?.value ?? '',
    notes: profile.notes ?? '',
  };
  const [draft, setDraft] = useState<Details>(base);
  const [version, setVersion] = useState(profile.version);
  const [errors, setErrors] = useState<Partial<Record<keyof Details, string>>>({});
  const [saving, setSaving] = useState(false);
  const [takeServer, setTakeServer] = useState(false);
  const changed = (Object.keys(base) as Array<keyof Details>).filter(
    (k) => draft[k].trim() !== base[k].trim(),
  );
  // Someone else saved meanwhile: take their values unless this agent is mid-edit.
  useEffect(() => {
    if (profile.version === version) return;
    setVersion(profile.version);
    if (!changed.length || takeServer) setDraft(base);
    setTakeServer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.version]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!changed.length || saving) return;
    const patch: Record<string, string | null> = {};
    if (changed.includes('name')) patch.displayName = draft.name.trim() || null;
    if (changed.includes('email')) patch.email = draft.email.trim() || null;
    if (changed.includes('phone')) patch.phone = draft.phone.trim() || null;
    if (changed.includes('notes')) patch.notes = draft.notes.trim() || null;
    setSaving(true);
    setErrors({});
    try {
      const next = await api.patch<VisitorProfile>(`/visitors/${profile.id}`, patch, {
        ifMatch: profile.version,
      });
      onSaved(next);
      setVersion(next.version);
      setDraft({
        name: next.fields.name?.value ?? '',
        email: next.fields.email?.value ?? '',
        phone: next.fields.phone?.value ?? '',
        notes: next.notes ?? '',
      });
      if (chatId && changed.includes('name')) void useInbox.getState().loadChat(chatId);
      toast.success(t('dock.info.saved'));
    } catch (err) {
      if (isApiError(err, 'VERSION_CONFLICT')) {
        toast.warning(t('dock.info.conflict'));
        setTakeServer(true);
        refetch();
      } else if (
        err instanceof ApiError &&
        (err.field('display_name') || err.field('email') || err.field('phone') || err.field('notes'))
      )
        setErrors({
          name: err.field('display_name'),
          email: err.field('email'),
          phone: err.field('phone'),
          notes: err.field('notes'),
        });
      else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof Details) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const input =
    'block h-8 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-fg-3 focus-visible:outline-2 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:bg-surface-3';
  const field = (
    k: Exclude<keyof Details, 'notes'>,
    label: string,
    type: string,
    placeholder: string,
    max: number,
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg-2">{label}</span>
      <input
        type={type}
        value={draft[k]}
        onChange={set(k)}
        disabled={!canEdit || saving}
        maxLength={max}
        dir="auto"
        placeholder={placeholder}
        aria-invalid={!!errors[k] || undefined}
        className={cn(input, errors[k] && 'border-danger')}
      />
      {errors[k] && <span className="text-xs text-danger">{errors[k]}</span>}
    </label>
  );

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2" aria-label={t('dock.info.details')}>
      {field('name', t('dock.info.name'), 'text', t('dock.info.namePlaceholder'), 100)}
      {field('email', t('dock.info.email'), 'email', t('dock.info.emailPlaceholder'), 200)}
      {field('phone', t('dock.info.phone'), 'tel', t('dock.info.phonePlaceholder'), 40)}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-2">{t('dock.info.notes')}</span>
        <textarea
          value={draft.notes}
          onChange={set('notes')}
          disabled={!canEdit || saving}
          maxLength={5000}
          rows={3}
          dir="auto"
          placeholder={t('dock.info.notesPlaceholder')}
          className={cn(input, 'h-auto min-h-16 resize-y py-1.5 leading-5', errors.notes && 'border-danger')}
        />
        {errors.notes && <span className="text-xs text-danger">{errors.notes}</span>}
      </label>
      {changed.length > 0 && (
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(base)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm" variant="primary" loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </form>
  );
}
