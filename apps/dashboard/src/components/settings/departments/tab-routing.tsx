'use client';
import { useEffect, useMemo, useState } from 'react';
import { hasFallbackCycle } from '@talkivio/contracts';
import { Banner, Card, CardBody, CardHeader, Field, RadioGroup, Select } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { checkInt, fieldError, NumberInput, SaveBar } from '../form-kit';
import type { TabProps } from './department-detail';
import { routingOptions, type DepartmentResource } from './dept-shared';
import { TabAlerts } from './tab-kit';
import { useDeptForm } from './use-dept-form';

type Form = { routingMode: DepartmentResource['routingMode']; queueLimit: number; maxWaitSeconds: number; fallbackDepartmentId: string | null };

export function RoutingTab({ dept, all, canManage, onDirtyChange, registerSave }: TabProps & { all: DepartmentResource[] }) {
  const t = useT();
  const form = useDeptForm<Form>(dept, (d) => ({ routingMode: d.routingMode, queueLimit: d.queueLimit, maxWaitSeconds: d.maxWaitSeconds, fallbackDepartmentId: d.fallbackDepartmentId }), { savedMessage: t('settings.departments.routing.saved'), onDirtyChange });
  const [local, setLocal] = useState<Partial<Record<keyof Form, string>>>({});
  const v = form.value;

  // Current fallback graph with this department's edge replaced by the candidate.
  const edges = useMemo(() => Object.fromEntries(all.map((d) => [d.id, d.fallbackDepartmentId])) as Record<string, string | null>, [all]);
  const wouldLoop = (target: string | null) => !!target && hasFallbackCycle({ ...edges, [dept.id]: target }, dept.id);
  const loopPath = (target: string): string => {
    const names = new Map(all.map((d) => [d.id, d.name]));
    const path = [isolate(dept.name)];
    let cur: string | null = target;
    const seen = new Set<string>([dept.id]);
    while (cur && !seen.has(cur)) {
      path.push(isolate(names.get(cur)) || t('common.unknown'));
      seen.add(cur);
      cur = cur === dept.id ? null : edges[cur];
    }
    if (cur) path.push(isolate(names.get(cur)) || t('common.unknown'));
    return path.join(t('settings.departments.routing.pathArrow'));
  };

  const candidates = all.filter((d) => d.id !== dept.id && (!d.archivedAt || d.id === v.fallbackDepartmentId));

  const save = async () => {
    const fe: typeof local = { queueLimit: checkInt(v.queueLimit, 1, 10000, 'chats') ?? undefined, maxWaitSeconds: checkInt(v.maxWaitSeconds, 0, 3600, 'seconds') ?? undefined };
    if (wouldLoop(v.fallbackDepartmentId)) fe.fallbackDepartmentId = t('settings.departments.routing.loop', { path: loopPath(v.fallbackDepartmentId!) });
    const clean = Object.fromEntries(Object.entries(fe).filter(([, m]) => m)) as typeof local;
    setLocal(clean);
    if (Object.keys(clean).length) return false;
    return form.save();
  };
  useEffect(() => {
    registerSave(save);
  });

  const serverFallbackError = form.message && /loop/i.test(form.message) ? form.message : undefined;
  const err = (k: keyof Form) => local[k] ?? fieldError(form.errors, k) ?? (k === 'fallbackDepartmentId' ? serverFallbackError : undefined);
  const target = all.find((d) => d.id === v.fallbackDepartmentId);

  return (
    <Card>
      <CardHeader title={t('settings.departments.tabs.routing')} description={t('settings.departments.routing.description')} />
      <CardBody className="flex flex-col gap-6">
        <TabAlerts form={form} />
        <RadioGroup
          legend={t('settings.departments.routing.mode')}
          name={`routing-${dept.id}`}
          value={v.routingMode}
          onChange={(m) => canManage && form.set({ routingMode: m })}
          options={routingOptions(t).map((o) => ({ ...o, disabled: !canManage }))}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('settings.departments.routing.queueLimit')} description={t('settings.departments.routing.queueLimitHint', { min: 1, max: 10000 })} error={err('queueLimit')}>
            <NumberInput value={v.queueLimit} min={1} max={10000} suffix={t('settings.departments.routing.unitChats')} disabled={!canManage} onChange={(n) => (form.set({ queueLimit: n }), setLocal({}))} />
          </Field>
          <Field label={t('settings.departments.routing.maxWait')} description={t('settings.departments.routing.maxWaitHint', { min: 0, max: 3600 })} error={err('maxWaitSeconds')}>
            <NumberInput value={v.maxWaitSeconds} min={0} max={3600} suffix={t('settings.general.unit.seconds')} disabled={!canManage} onChange={(n) => (form.set({ maxWaitSeconds: n }), setLocal({}))} />
          </Field>
        </div>
        <Field
          label={t('settings.departments.routing.overflow')}
          description={v.maxWaitSeconds === 0 ? t('settings.departments.routing.overflowOff') : t('settings.departments.routing.overflowHint')}
          error={err('fallbackDepartmentId')}
          className="max-w-xl"
        >
          <Select
            value={v.fallbackDepartmentId ?? ''}
            disabled={!canManage || v.maxWaitSeconds === 0}
            onChange={(e) => (form.set({ fallbackDepartmentId: e.target.value || null }), setLocal({}))}
          >
            <option value="">{t('settings.departments.routing.keepWaiting')}</option>
            {candidates.map((d) => {
              const loops = wouldLoop(d.id);
              return (
                <option key={d.id} value={d.id} disabled={loops && d.id !== v.fallbackDepartmentId}>
                  {t('settings.departments.routing.overflowTo', { name: d.name, state: d.archivedAt ? 'archived' : !d.enabled ? 'disabled' : 'ok', loops: loops ? 'yes' : 'no' })}
                </option>
              );
            })}
          </Select>
        </Field>
        {target && (target.archivedAt || !target.enabled) && v.maxWaitSeconds > 0 && (
          <Banner tone="warning">
            {target.archivedAt ? t('settings.departments.routing.targetArchived', { name: isolate(target.name) }) : t('settings.departments.routing.targetDisabled', { name: isolate(target.name) })}
          </Banner>
        )}
      </CardBody>
      {canManage && <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void save()} onDiscard={() => (form.discard(), setLocal({}))} />}
    </Card>
  );
}
