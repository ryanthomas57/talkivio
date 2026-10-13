'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, CalendarCheck2, DoorClosed, DoorOpen, Info, Star } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { validateWeeklyIntervals } from '@talkivio/contracts';
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, Input, Page, PanelError, Skeleton, TimezonePicker } from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { intlLocale, isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import type { Tenant } from '@/lib/types';
import { useCan, useSession } from '@/stores/session';
import { ConflictBanner, describeFailure, isEqual, SaveBar } from '../form-kit';
import { hk, localizeHoursErrors, stripErrors, useHoursRealtime, useSchedule, type ScheduleDetail, type ScheduleImpact, type ScheduleUsage, type WeeklyIntervals } from './hours-api';
import { ScheduleExceptions } from './schedule-exceptions';
import { SchedulePreview } from './schedule-preview';
import { WeeklyGrid } from './weekly-grid';

interface Form {
  name: string;
  timezone: string;
  weeklyIntervals: WeeklyIntervals;
}

const formOf = (s: ScheduleDetail): Form => ({ name: s.name, timezone: s.timezone, weeklyIntervals: s.weeklyIntervals });

/** Shape errors on a half-typed value are hidden until the user tries to save. */
const isShapeError = (key: string) => key.endsWith('.start') || key.endsWith('.end');

export function ScheduleEditor({ id }: { id: string }) {
  const t = useT();
  useHoursRealtime();
  const q = useSchedule(id);
  if (q.isPending)
    return (
      <Page aria-busy>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96" />
      </Page>
    );
  if (q.isError)
    return (
      <Page>
        <BackLink />
        {isApiError(q.error, 'NOT_FOUND') ? (
          <Card>
            <EmptyState
              title={t('settings.hours.notFoundTitle')}
              description={t('settings.hours.notFoundBody')}
              action={
                <Button asChild variant="secondary">
                  <Link href="/settings/hours">{t('settings.hours.backToHours')}</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <Card>
            <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
          </Card>
        )}
      </Page>
    );
  return <Editor schedule={q.data} />;
}

function BackLink() {
  const t = useT();
  return (
    <Link href="/settings/hours" className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-fg-2 hover:text-fg">
      <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {t('settings.hours.title')}
    </Link>
  );
}

function Editor({ schedule }: { schedule: ScheduleDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const canManage = useCan('schedules.manage') && !schedule.archivedAt;
  const weekStartsOn = useSession((s) => s.tenant?.settings.locale.weekStartsOn ?? 1);
  const server = useMemo(() => formOf(schedule), [schedule]);
  const [draft, setDraft] = useState<{ base: Form; baseVersion: number; value: Form } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [impact, setImpact] = useState<ScheduleImpact | null>(null);
  const value = draft?.value ?? server;
  const dirty = !!draft && !isEqual(draft.value, draft.base);

  // A newer server version arrived (realtime refresh or our own exception edits).
  useEffect(() => {
    if (!draft || schedule.version === draft.baseVersion) return;
    if (isEqual(formOf(schedule), draft.base)) setDraft({ ...draft, baseVersion: schedule.version });
    else setRemoteChanged(true);
  }, [schedule, draft]);

  const clientErrors = useMemo(() => {
    const e = validateWeeklyIntervals(value.weeklyIntervals);
    return attempted ? e : Object.fromEntries(Object.entries(e).filter(([k]) => !isShapeError(k) || !/^\d{0,4}$|^\d{1,2}:\d?$/.test(valueAt(value.weeklyIntervals, k))));
  }, [value.weeklyIntervals, attempted]);
  const gridErrors = localizeHoursErrors({ ...clientErrors, ...stripErrors(serverErrors, 'weekly_intervals.') });
  const nameError = attempted && !value.name.trim() ? t('settings.hours.nameRequired') : serverErrors.name?.[0];
  const tzError = serverErrors.timezone?.[0];

  const set = (patch: Partial<Form>) => {
    setDraft((d) => ({ base: d?.base ?? server, baseVersion: d?.baseVersion ?? schedule.version, value: { ...(d?.value ?? server), ...patch } }));
    if (Object.keys(serverErrors).length) setServerErrors({});
  };

  const discard = () => {
    setDraft(null);
    setAttempted(false);
    setServerErrors({});
    setMessage(null);
    setConflict(false);
    setRemoteChanged(false);
  };

  const body = (dryRun: boolean) => {
    if (!draft) return null;
    const v = draft.value;
    return {
      ...(v.name.trim() !== draft.base.name ? { name: v.name.trim() } : {}),
      ...(v.timezone !== draft.base.timezone ? { timezone: v.timezone } : {}),
      ...(!isEqual(v.weeklyIntervals, draft.base.weeklyIntervals) ? { weeklyIntervals: v.weeklyIntervals } : {}),
      expectedVersion: draft.baseVersion,
      dryRun,
    };
  };

  const commit = async (): Promise<boolean> => {
    const b = body(false);
    if (!b) return true;
    setSaving(true);
    try {
      const r = await api.patch<{ schedule: ScheduleDetail; impact: ScheduleImpact; applied: boolean }>(`/schedules/${schedule.id}`, b);
      qc.setQueryData<ScheduleDetail>(hk.schedule(schedule.id), (old) => (old ? { ...old, ...r.schedule } : old));
      discard();
      toast.success(t('settings.hours.saved'));
      void qc.invalidateQueries({ queryKey: hk.schedule(schedule.id) });
      void qc.invalidateQueries({ queryKey: hk.schedulesRoot });
      return true;
    } catch (e) {
      const f = describeFailure(e);
      setConflict(f.conflict);
      setMessage(f.message);
      setServerErrors(f.fieldErrors);
      if (f.conflict) void qc.invalidateQueries({ queryKey: hk.schedule(schedule.id) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    setAttempted(true);
    setMessage(null);
    setConflict(false);
    const errs = validateWeeklyIntervals(draft.value.weeklyIntervals);
    if (!draft.value.name.trim() || Object.keys(errs).length) {
      setMessage(t('settings.hours.checkHours'));
      return false;
    }
    setSaving(true);
    try {
      const dry = await api.patch<{ impact: ScheduleImpact }>(`/schedules/${schedule.id}`, body(true));
      if (dry.impact.closesServiceNow) {
        setImpact(dry.impact);
        return false;
      }
    } catch (e) {
      const f = describeFailure(e);
      setConflict(f.conflict);
      setMessage(f.message);
      setServerErrors(f.fieldErrors);
      return false;
    } finally {
      setSaving(false);
    }
    return commit();
  };

  const guard = useDirtyGuard(dirty, { what: isolate(schedule.name), onSave: save });

  return (
    <Page>
      {guard}
      <BackLink />
      <ScheduleHeader schedule={schedule} />
      {schedule.archivedAt && <Banner tone="info">{t('settings.hours.archivedBanner')}</Banner>}

      <Card>
        <CardHeader title={t('settings.hours.weeklyHours')} description={t('settings.hours.weeklyHoursHint')} />
        <CardBody className="flex flex-col gap-5">
          {conflict && <ConflictBanner message={t('settings.hours.conflict')} onReload={async () => (await qc.invalidateQueries({ queryKey: hk.schedule(schedule.id) }), discard())} />}
          {remoteChanged && !conflict && (
            <Banner
              tone="warning"
              action={
                <Button size="sm" variant="secondary" onClick={discard}>
                  {t('settings.hours.loadLatest')}
                </Button>
              }
            >
              {t('settings.hours.remoteChanged')}
            </Banner>
          )}
          {message && !conflict && <Banner tone="danger">{message}</Banner>}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('common.name')} required error={nameError}>
              <Input value={value.name} maxLength={120} disabled={!canManage} dir="auto" onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={t('common.timezone')} description={t('settings.hours.timezoneHint')} error={tzError}>
              <TimezonePicker value={value.timezone} onChange={(tz) => set({ timezone: tz })} disabled={!canManage} />
            </Field>
          </div>
          {draft && draft.value.timezone !== draft.base.timezone && (
            <Banner tone="info">{t('settings.hours.timezoneChanged', { zone: isolate(draft.value.timezone.replace(/_/g, ' ')) })}</Banner>
          )}
          <div className="flex items-start gap-2 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-xs text-fg-2">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            <p>{t('settings.hours.formatHelp')}</p>
          </div>
          <WeeklyGrid value={value.weeklyIntervals} onChange={(w) => set({ weeklyIntervals: w })} errors={gridErrors} disabled={!canManage} weekStartsOn={weekStartsOn} />
        </CardBody>
        {canManage && <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onDiscard={discard} label={t('settings.hours.saveHours')} />}
      </Card>

      <ScheduleExceptions schedule={schedule} canManage={canManage} />
      <SchedulePreview scheduleId={schedule.id} version={schedule.version} dirty={dirty} />

      <ConfirmDialog
        open={!!impact}
        onOpenChange={(o) => !o && setImpact(null)}
        title={t('settings.hours.impactTitle')}
        description={t('settings.hours.impactBody', { name: isolate(schedule.name) })}
        confirmLabel={t('settings.hours.impactConfirm')}
        danger
        onConfirm={async () => {
          await commit();
        }}
      />
    </Page>
  );
}

/** Value of `day.index.start|end` for the half-typed check. */
function valueAt(w: WeeklyIntervals, key: string): string {
  const [day, idx, field] = key.split('.');
  const r = w[day as keyof WeeklyIntervals]?.[Number(idx)];
  return field === 'start' ? (r?.start ?? '') : field === 'end' ? (r?.end ?? '') : '';
}

function ScheduleHeader({ schedule }: { schedule: ScheduleDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const tenant = useSession((s) => s.tenant);
  const setTenant = useSession((s) => s.setTenant);
  const canManageTenant = useCan('tenant.manage');
  const canManage = useCan('schedules.manage');
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [defaultConflict, setDefaultConflict] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [unsetOpen, setUnsetOpen] = useState(false);
  const state = schedule.state;

  const setDefault = async (scheduleId: string | null) => {
    if (!tenant) return;
    setDefaultBusy(true);
    setDefaultError(null);
    setDefaultConflict(false);
    try {
      const next = await api.patch<Tenant>('/tenants/current', { settings: { availability: { defaultScheduleId: scheduleId } }, expectedVersion: tenant.version });
      setTenant(next);
      toast.success(scheduleId ? t('settings.hours.nowDefault', { name: isolate(schedule.name) }) : t('settings.hours.defaultRemoved'));
      await Promise.all([qc.invalidateQueries({ queryKey: hk.schedule(schedule.id) }), qc.invalidateQueries({ queryKey: hk.schedulesRoot })]);
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) setDefaultConflict(true);
      else setDefaultError(errorMessage(e));
      throw e;
    } finally {
      setDefaultBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="break-words text-xl" dir="auto">
            {schedule.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
            {schedule.isTenantDefault && <Badge tone="primary" icon={<Star className="size-3.5" aria-hidden />}>{t('settings.hours.workspaceDefaultBadge')}</Badge>}
            {schedule.archivedAt ? (
              <Badge tone="neutral" icon={<Archive className="size-3.5" aria-hidden />}>{t('settings.hours.archived')}</Badge>
            ) : state ? (
              state.open ? (
                <Badge tone="success" icon={<DoorOpen className="size-3.5" aria-hidden />}>{t('settings.hours.openNow')}</Badge>
              ) : (
                <Badge tone="neutral" icon={<DoorClosed className="size-3.5" aria-hidden />}>{t('settings.hours.closedNow')}</Badge>
              )
            ) : null}
            {state?.nextBoundary && (
              <span>{state.nextBoundary.kind === 'open' ? t('settings.hours.opensAt', { time: state.nextBoundary.localLabel }) : t('settings.hours.closesAt', { time: state.nextBoundary.localLabel })}</span>
            )}
            <span>· {schedule.timezone.replace(/_/g, ' ')}</span>
          </div>
        </div>
        {!schedule.archivedAt && (canManageTenant || canManage) && (
          <div className="flex flex-wrap gap-2">
            {canManageTenant &&
              (schedule.isTenantDefault ? (
                <Button variant="secondary" onClick={() => setUnsetOpen(true)}>
                  {t('settings.hours.removeAsDefault')}
                </Button>
              ) : (
                <Button variant="secondary" loading={defaultBusy} onClick={() => void setDefault(schedule.id).catch(() => undefined)}>
                  <CalendarCheck2 className="size-4" aria-hidden />
                  {t('settings.hours.setAsDefault')}
                </Button>
              ))}
            {canManage && (
              <Button variant="danger-ghost" onClick={() => setArchiveOpen(true)}>
                <Archive className="size-4" aria-hidden />
                {t('common.archive')}
              </Button>
            )}
          </div>
        )}
      </div>
      {defaultConflict && <ConflictBanner message={t('settings.hours.conflictWorkspace')} onReload={async () => (await useSession.getState().refreshTenant(), setDefaultConflict(false))} />}
      {defaultError && <Banner tone="danger">{defaultError}</Banner>}
      <UsageLine usage={schedule.usage} />
      <ConfirmDialog
        open={unsetOpen}
        onOpenChange={setUnsetOpen}
        title={t('settings.hours.unsetTitle')}
        description={t('settings.hours.unsetBody')}
        confirmLabel={t('settings.hours.unsetConfirm')}
        onConfirm={() => setDefault(null)}
      />
      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        schedule={schedule}
        onArchived={async () => {
          await qc.invalidateQueries({ queryKey: hk.schedulesRoot });
          router.push('/settings/hours');
        }}
      />
    </div>
  );
}

function UsageLine({ usage }: { usage: ScheduleUsage }) {
  const t = useT();
  const list = new Intl.ListFormat(intlLocale(), { style: 'short', type: 'unit' });
  const parts: string[] = [];
  if (usage.tenantDefault) parts.push(t('settings.hours.usage.workspaceDefault'));
  if (usage.sites.length) parts.push(t('settings.hours.usage.siteCount', { count: usage.sites.length }));
  if (usage.departments.length) parts.push(t('settings.hours.usage.departmentCount', { count: usage.departments.length }));
  if (!parts.length) return <p className="text-sm text-fg-2">{t('settings.hours.usage.unused')}</p>;
  return (
    <p className="text-sm text-fg-2">
      {t('settings.hours.usage.governs', { targets: list.format(parts) })}
      {usage.departments.length > 0 && (
        <>
          {' '}
          (
          {usage.departments.map((d, i) => (
            <span key={d.id}>
              {i > 0 && t('settings.hours.usage.separator')}
              <Link href={`/settings/departments/${d.id}?tab=hours`} className="font-medium text-primary hover:underline">
                <bdi>{d.name}</bdi>
              </Link>
            </span>
          ))}
          )
        </>
      )}
      {usage.sites.length > 0 && <> · {t('settings.hours.usage.sites', { names: list.format(usage.sites.map((s) => isolate(s.name))) })}</>}. {t('settings.hours.usage.precedence')}
    </p>
  );
}

function ArchiveDialog({ open, onOpenChange, schedule, onArchived }: { open: boolean; onOpenChange: (o: boolean) => void; schedule: ScheduleDetail; onArchived: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ScheduleUsage | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setUsage(null);
    }
  }, [open]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/schedules/${schedule.id}/archive`, { expectedVersion: schedule.version });
      toast.success(t('settings.hours.archive.done', { name: isolate(schedule.name) }));
      onOpenChange(false);
      await onArchived();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'CONFLICT' && e.details && 'departments' in e.details) setUsage(e.details as unknown as ScheduleUsage);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = usage;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        title={t('settings.hours.archive.title', { name: isolate(schedule.name) })}
        description={t('settings.hours.archive.body')}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void run()} loading={busy}>
              {t('settings.hours.archive.confirm')}
            </Button>
          </>
        }
      >
        {(error || shown) && (
          <div className="flex flex-col gap-3">
            {error && <Banner tone="danger">{error}</Banner>}
            {shown && (
              <div className="text-sm">
                <p className="font-medium">{t('settings.hours.archive.stillUsed')}</p>
                <ul className="mt-1 list-disc ps-5 text-fg-2">
                  {shown.tenantDefault && <li>{t('settings.hours.workspaceDefaultBadge')}</li>}
                  {shown.sites.map((s) => (
                    <li key={s.id}>{t('settings.hours.archive.site', { name: isolate(s.name) })}</li>
                  ))}
                  {shown.departments.map((d) => (
                    <li key={d.id}>
                      {t('settings.hours.archive.department')}{' '}
                      <Link href={`/settings/departments/${d.id}?tab=hours`} className="font-medium text-primary hover:underline">
                        <bdi>{d.name}</bdi>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
