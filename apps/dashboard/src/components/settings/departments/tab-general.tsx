'use client';
import { useEffect, useState } from 'react';
import { Banner, Card, CardBody, CardHeader, Field, Input, SwitchField, Textarea } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { fieldError, SaveBar } from '../form-kit';
import type { TabProps } from './department-detail';
import { TabAlerts } from './tab-kit';
import { useDeptForm } from './use-dept-form';

type Form = { name: string; publicLabel: string; description: string; enabled: boolean };

export function GeneralTab({ dept, canManage, onDirtyChange, registerSave }: TabProps) {
  const t = useT();
  const form = useDeptForm<Form>(dept, (d) => ({ name: d.name, publicLabel: d.publicLabel ?? '', description: d.description ?? '', enabled: d.enabled }), { savedMessage: t('settings.departments.general.saved'), onDirtyChange });
  const [local, setLocal] = useState<Partial<Record<keyof Form, string>>>({});
  const v = form.value;

  const save = async () => {
    const fe: typeof local = {};
    if (!v.name.trim()) fe.name = t('settings.departments.nameRequired');
    else if (v.name.trim().length > 80) fe.name = t('settings.profile.maxChars', { max: 80 });
    if (v.publicLabel.trim().length > 80) fe.publicLabel = t('settings.profile.maxChars', { max: 80 });
    if (v.description.trim().length > 300) fe.description = t('settings.profile.maxChars', { max: 300 });
    setLocal(fe);
    if (Object.keys(fe).length) return false;
    const ok = await form.save((changed) => ({
      ...('name' in changed ? { name: v.name.trim() } : {}),
      ...('publicLabel' in changed ? { publicLabel: v.publicLabel.trim() } : {}),
      ...('description' in changed ? { description: v.description.trim() || null } : {}),
      ...('enabled' in changed ? { enabled: v.enabled } : {}),
    }));
    return ok;
  };
  useEffect(() => {
    registerSave(save);
  });

  // A duplicate name comes back as a conflict without field errors; show it on the name field too.
  const dupName = form.message && /already exists/i.test(form.message) ? form.message : undefined;
  const err = (k: keyof Form) => local[k] ?? fieldError(form.errors, k) ?? (k === 'name' ? dupName : undefined);

  return (
    <Card>
      <CardHeader title={t('settings.departments.tabs.general')} description={t('settings.departments.general.description')} />
      <CardBody className="flex flex-col gap-5">
        <TabAlerts form={form} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('common.name')} required description={t('settings.departments.general.nameHint')} error={err('name')}>
            <Input value={v.name} maxLength={80} disabled={!canManage} dir="auto" onChange={(e) => (form.set({ name: e.target.value }), setLocal({}))} />
          </Field>
          <Field label={t('settings.departments.general.publicLabel')} description={t('settings.departments.general.publicLabelHint')} error={err('publicLabel')}>
            <Input value={v.publicLabel} maxLength={80} disabled={!canManage} placeholder={v.name} dir="auto" onChange={(e) => (form.set({ publicLabel: e.target.value }), setLocal({}))} />
          </Field>
          <Field label={t('common.description')} description={t('settings.departments.general.descriptionHint', { max: 300 })} error={err('description')} className="sm:col-span-2">
            <Textarea value={v.description} maxLength={300} rows={3} disabled={!canManage} dir="auto" onChange={(e) => (form.set({ description: e.target.value }), setLocal({}))} />
          </Field>
        </div>
        <div className="border-t border-line-subtle pt-3">
          <SwitchField
            label={t('common.enabled')}
            description={t('settings.departments.general.enabledHint')}
            checked={v.enabled}
            disabled={!canManage}
            onCheckedChange={(c) => form.set({ enabled: c })}
          />
          {!v.enabled && dept.enabled && (
            <Banner tone="warning" className="mt-2">
              {dept.queued > 0
                ? t('settings.departments.general.disableWarningQueued', { name: isolate(v.publicLabel.trim() || v.name), count: dept.queued })
                : t('settings.departments.general.disableWarning', { name: isolate(v.publicLabel.trim() || v.name) })}
            </Banner>
          )}
        </div>
      </CardBody>
      {canManage && <SaveBar dirty={form.dirty} saving={form.saving} onSave={() => void save()} onDiscard={() => (form.discard(), setLocal({}))} />}
    </Card>
  );
}
