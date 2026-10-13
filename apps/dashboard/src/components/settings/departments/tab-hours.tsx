'use client';
import { DoorClosed, DoorOpen } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { Badge, Banner, Card, CardBody, CardHeader, Field, RadioGroup, Select, Skeleton } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { useCan, useSession } from '@/stores/session';
import { byId } from '@/lib/queries';
import { fieldError, SaveBar } from '../form-kit';
import { summarizeWeek, useSchedules } from '../hours/hours-api';
import type { TabProps } from './department-detail';
import { TabAlerts } from './tab-kit';
import { useDeptForm } from './use-dept-form';

type Form = { scheduleId: string | null };

export function HoursTab({ dept, canManage, onDirtyChange, registerSave }: TabProps) {
  const t = useT();
  const canSchedules = useCan('schedules.view');
  const weekStartsOn = useSession((s) => s.tenant?.settings.locale.weekStartsOn ?? 1);
  const schedules = useSchedules(true);
  const map = useMemo(() => byId(schedules.data), [schedules.data]);
  const form = useDeptForm<Form>(dept, (d) => ({ scheduleId: d.scheduleId }), { savedMessage: t('settings.departments.hours.saved'), onDirtyChange });
  const mode: 'default' | 'own' = form.value.scheduleId === null ? 'default' : 'own';
  const active = (schedules.data ?? []).filter((s) => !s.archivedAt || s.id === form.value.scheduleId);
  const selected = form.value.scheduleId ? map.get(form.value.scheduleId) : undefined;
  const fallback = (schedules.data ?? []).find((s) => s.isTenantDefault);

  const save = async () => {
    if (mode === 'own' && !form.value.scheduleId) return false;
    return form.save();
  };
  useEffect(() => {
    registerSave(save);
  });

  return (
    <Card>
      <CardHeader title={t('settings.departments.tabs.hours')} description={t('settings.departments.hours.description')} />
      <CardBody className="flex flex-col gap-5">
        <TabAlerts form={form} />
        {!canSchedules ? (
          <p className="text-sm text-fg-2">{dept.scheduleId ? t('settings.departments.hours.ownReadOnly') : t('settings.departments.hours.defaultReadOnly')}</p>
        ) : schedules.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <RadioGroup
              legend={t('settings.departments.hours.schedule')}
              name={`dept-hours-${dept.id}`}
              value={mode}
              onChange={(m) => {
                if (!canManage) return;
                if (m === 'default') form.set({ scheduleId: null });
                else form.set({ scheduleId: dept.scheduleId ?? active.find((s) => !s.archivedAt)?.id ?? null });
              }}
              options={[
                {
                  value: 'default',
                  label: t('settings.departments.hours.useDefault'),
                  description: fallback ? t('settings.departments.hours.useDefaultHint', { name: isolate(fallback.name) }) : t('settings.departments.hours.useDefaultNoDefault'),
                  disabled: !canManage,
                },
                { value: 'own', label: t('settings.departments.hours.useOwn'), description: t('settings.departments.hours.useOwnHint'), disabled: !canManage || active.filter((s) => !s.archivedAt).length === 0 },
              ]}
            />
            {active.filter((s) => !s.archivedAt).length === 0 && (
              <p className="text-sm text-fg-2">
                {t('settings.departments.hours.noSchedules')}{' '}
                <Link href="/settings/hours" className="font-medium text-primary hover:underline">
                  {t('settings.departments.hours.createOne')}
                </Link>
              </p>
            )}
            {mode === 'own' && (
              <Field label={t('settings.departments.hours.schedule')} error={fieldError(form.errors, 'scheduleId')} className="max-w-md">
                <Select value={form.value.scheduleId ?? ''} disabled={!canManage} onChange={(e) => form.set({ scheduleId: e.target.value || null })}>
                  {active.map((s) => (
                    <option key={s.id} value={s.id} disabled={!!s.archivedAt}>
                      {s.archivedAt ? t('settings.departments.hours.optionArchived', { name: s.name, zone: s.timezone.replace(/_/g, ' ') }) : t('settings.departments.hours.option', { name: s.name, zone: s.timezone.replace(/_/g, ' ') })}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {mode === 'own' && selected && (
              <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" dir="auto">
                    {selected.name}
                  </span>
                  {selected.state &&
                    (selected.state.open ? (
                      <Badge tone="success" icon={<DoorOpen className="size-3.5" aria-hidden />}>{t('settings.hours.openNow')}</Badge>
                    ) : (
                      <Badge tone="neutral" icon={<DoorClosed className="size-3.5" aria-hidden />}>{t('settings.hours.closedNow')}</Badge>
                    ))}
                  {selected.state?.nextBoundary && (
                    <span className="text-sm text-fg-2">
                      {selected.state.nextBoundary.kind === 'open' ? t('settings.hours.opensAt', { time: selected.state.nextBoundary.localLabel }) : t('settings.hours.closesAt', { time: selected.state.nextBoundary.localLabel })}
                    </span>
                  )}
                </div>
                <p className="text-sm text-fg-2">{summarizeWeek(selected.weeklyIntervals, weekStartsOn)}</p>
                <Link href={`/settings/hours/${selected.id}`} className="w-fit text-sm font-medium text-primary hover:underline">
                  {t('settings.departments.hours.viewSchedule')}
                </Link>
              </div>
            )}
            {selected?.archivedAt && <Banner tone="warning">{t('settings.departments.hours.selectedArchived')}</Banner>}
          </>
        )}
      </CardBody>
      {canManage && canSchedules && <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void save()} onDiscard={form.discard} />}
    </Card>
  );
}
