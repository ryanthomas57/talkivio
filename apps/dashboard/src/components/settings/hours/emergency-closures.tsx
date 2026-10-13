'use client';
/**
 * Emergency closures (ch. 22): override every schedule for the whole workspace,
 * one site or one department until revoked or until an optional end time. The
 * list stays live through `emergency_closure.created/revoked` team events.
 */
import { useQueryClient } from '@tanstack/react-query';
import { OctagonAlert, ShieldAlert } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, Input, PanelError, RadioGroup, Select, Skeleton, Textarea } from '@/components/ui';
import { useNow } from '@/hooks/use-media';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { byId, useDepartments, useSites } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { hk, useClosures, type Closure } from './hours-api';

export function EmergencyClosures() {
  const t = useT();
  const qc = useQueryClient();
  const canManage = useCan('schedules.manage');
  const q = useClosures();
  const sites = useSites();
  const departments = useDepartments();
  const siteMap = useMemo(() => byId(sites.data), [sites.data]);
  const deptMap = useMemo(() => byId(departments.data), [departments.data]);
  const now = useNow(30_000);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Closure | null>(null);

  // Hide closures whose end passed while the page was open (the server agrees on next fetch).
  const active = (q.data ?? []).filter((c) => c.state !== 'revoked' && (!c.endsAt || new Date(c.endsAt).getTime() > now));

  /** Name of the closed site/department when it is loaded (tenant content, isolated for bidi). */
  const targetName = (c: Closure): string | null => {
    const name = c.scope === 'site' ? siteMap.get(c.siteId ?? '')?.name : c.scope === 'department' ? deptMap.get(c.departmentId ?? '')?.name : undefined;
    return name ? isolate(name) : null;
  };
  const scopeLabel = (c: Closure) => {
    const name = targetName(c);
    if (c.scope === 'tenant') return t('settings.hours.closures.scopeTenant');
    if (c.scope === 'site') return name ? t('settings.hours.closures.scopeSiteNamed', { name }) : t('settings.hours.closures.scopeSite');
    return name ? t('settings.hours.closures.scopeDepartmentNamed', { name }) : t('settings.hours.closures.scopeDepartment');
  };
  const revokeBody = (c: Closure) => {
    const name = targetName(c);
    if (c.scope === 'tenant') return t('settings.hours.closures.revokeBodyTenant');
    if (c.scope === 'site') return name ? t('settings.hours.closures.revokeBodySite', { name }) : t('settings.hours.closures.revokeBodyOneSite');
    return name ? t('settings.hours.closures.revokeBodyDepartment', { name }) : t('settings.hours.closures.revokeBodyOneDepartment');
  };

  return (
    <Card>
      <CardHeader
        title={t('settings.hours.closures.title')}
        description={t('settings.hours.closures.description')}
        action={
          canManage && (
            <Button size="sm" variant="danger" onClick={() => setCreating(true)}>
              <OctagonAlert className="size-3.5" aria-hidden />
              {t('settings.hours.closures.closeNow')}
            </Button>
          )
        }
      />
      {q.isPending ? (
        <div className="flex flex-col gap-2 p-4 sm:px-6">
          <Skeleton className="h-14" />
        </div>
      ) : q.isError ? (
        <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : active.length === 0 ? (
        <EmptyState icon={<ShieldAlert />} title={t('settings.hours.closures.emptyTitle')} description={t('settings.hours.closures.emptyBody')} />
      ) : (
        <ul className="divide-y divide-line-subtle" aria-live="polite">
          {active.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-6">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <Badge tone="danger" icon={<OctagonAlert className="size-3.5" aria-hidden />}>
                    {c.state === 'scheduled' ? t('settings.hours.closures.scheduled') : t('settings.hours.closed')}
                  </Badge>
                  {scopeLabel(c)}
                </p>
                <p className="mt-1 break-words text-sm" dir="auto">
                  {c.reason}
                </p>
                <p className="mt-1 text-xs text-fg-2">
                  <time dateTime={c.startsAt} title={formatDateTime(c.startsAt)}>
                    {t('settings.hours.closures.started', { time: formatRelative(c.startsAt) })}
                  </time>{' '}
                  ·{' '}
                  {c.endsAt ? <time dateTime={c.endsAt}>{t('settings.hours.closures.ends', { time: formatDateTime(c.endsAt) })}</time> : t('settings.hours.closures.untilRevoked')}
                </p>
              </div>
              {canManage && (
                <Button size="sm" variant="secondary" onClick={() => setRevoking(c)}>
                  {t('settings.hours.closures.reopen')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateClosureDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await qc.invalidateQueries({ queryKey: hk.closures });
          }}
        />
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('settings.hours.closures.revokeTitle')}
        description={revoking ? revokeBody(revoking) : ''}
        confirmLabel={t('settings.hours.closures.revokeConfirm')}
        onConfirm={async () => {
          if (!revoking) return;
          await api.delete(`/emergency-closures/${revoking.id}`);
          toast.success(t('settings.hours.closures.revoked'));
          await qc.invalidateQueries({ queryKey: hk.closures });
        }}
      />
    </Card>
  );
}

function CreateClosureDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const t = useT();
  const sites = useSites();
  const departments = useDepartments();
  const canSites = useCan('sites.view');
  const canDepts = useCan('departments.view');
  const [scope, setScope] = useState<'tenant' | 'site' | 'department'>('tenant');
  const [siteId, setSiteId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ site?: string; department?: string; endsAt?: string; reason?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => uuid());
  const siteOptions = (sites.data ?? []).filter((s) => !s.archivedAt);
  const deptOptions = (departments.data ?? []).filter((d) => !d.archivedAt);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof errors = {};
    if (scope === 'site' && !siteId) fe.site = t('settings.hours.closures.siteRequired');
    if (scope === 'department' && !departmentId) fe.department = t('settings.hours.closures.departmentRequired');
    if (!reason.trim()) fe.reason = t('settings.hours.closures.reasonRequired');
    let endIso: string | null = null;
    if (endsAt) {
      const d = new Date(endsAt);
      if (Number.isNaN(d.getTime())) fe.endsAt = t('settings.hours.closures.endInvalid');
      else if (d.getTime() <= Date.now() + 60_000) fe.endsAt = t('settings.hours.closures.endPast');
      else if (d.getTime() > Date.now() + 366 * 86_400_000) fe.endsAt = t('settings.hours.closures.endTooFar');
      else endIso = d.toISOString();
    }
    setErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.post(
        '/emergency-closures',
        { siteId: scope === 'site' ? siteId : null, departmentId: scope === 'department' ? departmentId : null, endsAt: endIso, reason: reason.trim() },
        { idempotencyKey: key },
      );
      toast.success(t('settings.hours.closures.created'));
      await onCreated();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        setErrors({ site: err.field('site_id'), department: err.field('department_id'), endsAt: err.field('ends_at'), reason: err.field('reason') });
      }
      setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const scopeOptions = [
    { value: 'tenant' as const, label: t('settings.hours.closures.scopeTenant'), description: t('settings.hours.closures.scopeTenantHint') },
    ...(canSites ? [{ value: 'site' as const, label: t('settings.hours.closures.scopeSite'), description: t('settings.hours.closures.scopeSiteHint'), disabled: siteOptions.length === 0 }] : []),
    ...(canDepts ? [{ value: 'department' as const, label: t('settings.hours.closures.scopeDepartment'), description: t('settings.hours.closures.scopeDepartmentHint'), disabled: deptOptions.length === 0 }] : []),
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        size="md"
        title={t('settings.hours.closures.dialogTitle')}
        description={t('settings.hours.closures.dialogBody')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="closure-form" variant="danger" loading={busy}>
              {t('settings.hours.closures.closeNow')}
            </Button>
          </>
        }
      >
        <form id="closure-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
          {message && <Banner tone="danger">{message}</Banner>}
          <RadioGroup legend={t('settings.hours.closures.whatToClose')} name="closure-scope" value={scope} onChange={setScope} options={scopeOptions} />
          {scope === 'site' && (
            <Field label={t('settings.hours.closures.site')} required error={errors.site}>
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">{t('settings.hours.closures.chooseSite')}</option>
                {siteOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {scope === 'department' && (
            <Field label={t('common.department')} required error={errors.department}>
              <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">{t('settings.hours.closures.chooseDepartment')}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('settings.hours.closures.reopenAt')} description={t('settings.hours.closures.reopenAtHint')} error={errors.endsAt}>
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="w-64 max-w-full" />
          </Field>
          <Field label={t('settings.hours.exceptions.reason')} required description={t('settings.hours.closures.reasonHint', { max: 300 })} error={errors.reason}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} placeholder={t('settings.hours.closures.reasonPlaceholder')} dir="auto" />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
