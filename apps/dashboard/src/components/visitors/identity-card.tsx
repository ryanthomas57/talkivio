'use client';
/**
 * Identity fields (ch. 17/25): verified values come only from a signed identity
 * token; anything typed here is stored as unverified. Saving uses If-Match and a
 * conflict never overwrites another editor. Historical message sender names are
 * snapshots and do not change.
 */
import { BadgeCheck, CircleAlert, Pencil } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Banner, Button, Field, Input } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { byId, useSites } from '@/lib/queries';
import { useCan } from '@/stores/session';
import type { FieldValue, VisitorProfile } from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function FieldRow({ label, field }: { label: string; field: FieldValue | undefined }) {
  const t = useT();
  const value = field?.value ?? null;
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-fg-2">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span
          className={value ? 'font-medium text-fg break-anywhere' : 'text-fg-3'}
          dir={value ? 'auto' : undefined}
        >
          {value ?? t('visitors.identity.notProvided')}
        </span>
        {value &&
          (field?.verified ? (
            <Badge tone="success" icon={<BadgeCheck className="size-3.5" aria-hidden />}>
              {t('visitors.display.verified')}
            </Badge>
          ) : (
            <Badge tone="neutral" icon={<CircleAlert className="size-3.5" aria-hidden />}>
              {t('visitors.display.unverified')}
            </Badge>
          ))}
      </dd>
    </div>
  );
}

export function IdentityCard({
  profile,
  onSaved,
  onReload,
}: {
  profile: VisitorProfile;
  onSaved: (p: VisitorProfile) => void;
  onReload: () => void;
}) {
  const t = useT();
  const canEdit = useCan('visitors.edit') && !profile.erased;
  const sites = byId(useSites().data);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const baseName = profile.fields.name?.value ?? '';
  const baseEmail = profile.fields.email?.value ?? '';
  const dirty =
    editing && (name.trim() !== baseName || email.trim().toLowerCase() !== baseEmail.toLowerCase());
  const anyVerified = !!(profile.fields.name?.verified || profile.fields.email?.verified);

  const save = async (): Promise<boolean> => {
    const errs: { name?: string; email?: string } = {};
    if (name.trim().length > 100) errs.name = t('visitors.identity.errNameLong', { max: 100 });
    if (email.trim() && !EMAIL_RE.test(email.trim())) errs.email = t('visitors.identity.errEmail');
    setErrors(errs);
    if (Object.keys(errs).length) return false;
    const patch: Record<string, string | null> = {};
    if (name.trim() !== baseName) patch.displayName = name.trim() || null;
    if (email.trim().toLowerCase() !== baseEmail.toLowerCase()) patch.email = email.trim() || null;
    if (!Object.keys(patch).length) {
      setEditing(false);
      return true;
    }
    setSaving(true);
    setFailure(null);
    setConflict(false);
    try {
      const next = await api.patch<VisitorProfile>(`/visitors/${profile.id}`, patch, {
        ifMatch: profile.version,
      });
      onSaved(next);
      setEditing(false);
      toast.success(t('visitors.identity.savedToast'));
      return true;
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) setConflict(true);
      else {
        if (e instanceof ApiError) setErrors({ name: e.field('display_name'), email: e.field('email') });
        setFailure(errorMessage(e));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };
  const guard = useDirtyGuard(dirty, { what: t('visitors.identity.dirtyWhat'), onSave: save });

  return (
    <div className="flex flex-col gap-3">
      {guard}
      <div className="flex flex-wrap items-center gap-2">
        {profile.identityVerified ? (
          <Badge tone="success" icon={<BadgeCheck className="size-3.5" aria-hidden />}>
            {t('visitors.identity.identityVerified')}
          </Badge>
        ) : (
          <Badge tone="neutral" icon={<CircleAlert className="size-3.5" aria-hidden />}>
            {t('visitors.identity.identityNotVerified')}
          </Badge>
        )}
        <span className="text-xs text-fg-2">
          {t('visitors.identity.labelLine', { label: isolate(profile.anonymousLabel) })}
        </span>
      </div>
      {conflict && (
        <Banner
          tone="warning"
          title={t('visitors.identity.conflictTitle')}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConflict(false);
                setEditing(false);
                onReload();
              }}
            >
              {t('common.reload')}
            </Button>
          }
        >
          {t('visitors.identity.conflictBody')}
        </Banner>
      )}
      {failure && !conflict && <Banner tone="danger">{failure}</Banner>}
      {!editing ? (
        <>
          <dl className="divide-y divide-line-subtle">
            <FieldRow label={t('common.name')} field={profile.fields.name} />
            <FieldRow label={t('common.email')} field={profile.fields.email} />
            <FieldRow label={t('visitors.identity.phone')} field={profile.fields.phone} />
          </dl>
          {profile.identities.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-2">
                {t('visitors.identity.verifiedLinks')}
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {profile.identities.map((i, n) => (
                  <li key={`${i.issuerSiteId}-${n}`} className="text-fg-2">
                    {t('visitors.identity.linkLine', {
                      site: isolate(sites.get(i.issuerSiteId)?.name ?? t('visitors.page.site')),
                      method: i.verificationMethod,
                      methodText: isolate(i.verificationMethod.replace(/_/g, ' ')),
                      date: formatDateTime(i.linkedAt),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canEdit && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setName(baseName);
                  setEmail(baseEmail);
                  setErrors({});
                  setFailure(null);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden /> {t('visitors.identity.editButton')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Banner tone="info">
            {anyVerified ? t('visitors.identity.noticeWithVerified') : t('visitors.identity.notice')}
          </Banner>
          <Field
            label={t('visitors.identity.displayName')}
            error={errors.name}
            description={t('visitors.identity.displayNameHint')}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoComplete="off"
              dir="auto"
            />
          </Field>
          <Field label={t('visitors.identity.contactEmail')} error={errors.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={200}
              autoComplete="off"
              dir="ltr"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
              {t('visitors.identity.saveDetails')}
            </Button>
            <Button type="button" variant="secondary" disabled={saving} onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
