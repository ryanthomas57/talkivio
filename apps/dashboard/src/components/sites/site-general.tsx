'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  Select,
  Switch,
} from '@/components/ui';
import { intlLocale, isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { qk, useDepartments } from '@/lib/queries';
import type { Site } from '@/lib/types';
import { useCan } from '@/stores/session';
import {
  duplicateOriginErrors,
  OriginsEditor,
  originErrorsFrom,
  originsPayload,
  originsSignature,
  rowsFromOrigins,
  type OriginRow,
} from './origins-editor';

interface ScheduleOption {
  id: string;
  name: string;
  timezone: string;
  isTenantDefault: boolean;
  archivedAt: string | null;
}

interface FormState {
  name: string;
  defaultDepartmentId: string;
  scheduleId: string;
  rows: OriginRow[];
}

const fromSite = (s: Site): FormState => ({
  name: s.name,
  defaultDepartmentId: s.defaultDepartmentId ?? '',
  scheduleId: s.scheduleId ?? '',
  rows: rowsFromOrigins(s.origins),
});
const signature = (f: FormState) =>
  JSON.stringify([f.name.trim(), f.defaultDepartmentId, f.scheduleId, originsSignature(f.rows)]);

export function siteKey(id: string) {
  return [...qk.sites, id] as const;
}

/**
 * General settings: name, enabled, default department, schedule and the allowed
 * origins list. Saves with `expectedVersion`; a VERSION_CONFLICT keeps the edits on
 * screen with a Reload choice instead of overwriting another editor.
 */
export function SiteGeneral({
  site,
  onDirtyChange,
}: {
  site: Site;
  onDirtyChange: (dirty: boolean, save: () => Promise<boolean>) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const canManage = useCan('sites.manage') && !site.archivedAt;
  const canSchedules = useCan('schedules.view');
  const departments = useDepartments();
  const schedules = useQuery({
    queryKey: ['schedules', 'options'],
    queryFn: async () => (await api.page<ScheduleOption>('/schedules', { limit: 100 })).items,
    enabled: canSchedules,
    staleTime: 60_000,
  });

  const [base, setBase] = useState(() => ({ version: site.version, form: fromSite(site) }));
  const [form, setForm] = useState<FormState>(base.form);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [originErrors, setOriginErrors] = useState<Record<number, string>>({});
  const [confirm, setConfirm] = useState<'disable' | 'archive' | null>(null);
  const dirty = signature(form) !== signature(base.form);

  // Adopt fresh server data when nothing is being edited. The site version also
  // moves on publish, key rotation and enable/disable; while editing, adopt the new
  // version silently when the fields this form edits are unchanged on the server.
  useEffect(() => {
    if (site.version === base.version) return;
    const f = fromSite(site);
    if (!dirty) {
      setBase({ version: site.version, form: f });
      setForm(f);
    } else if (signature(f) === signature(base.form)) {
      setBase((b) => ({ ...b, version: site.version }));
    }
  }, [site, base.version, base.form, dirty]);

  const reload = async () => {
    const fresh = await qc.fetchQuery({
      queryKey: siteKey(site.id),
      queryFn: () => api.get<Site>(`/sites/${site.id}`),
    });
    const f = fromSite(fresh);
    setBase({ version: fresh.version, form: f });
    setForm(f);
    setConflict(false);
    setError(null);
    setOriginErrors({});
    setNameError(null);
  };

  const save = async (): Promise<boolean> => {
    setError(null);
    setConflict(false);
    const nErr = form.name.trim() ? null : t('sites.create.nameRequired');
    const dup = duplicateOriginErrors(form.rows);
    setNameError(nErr);
    setOriginErrors(dup);
    if (nErr || Object.keys(dup).length) {
      setError(t('sites.general.fixFields'));
      return false;
    }
    const originsChanged = originsSignature(form.rows) !== originsSignature(base.form.rows);
    const { origins, indexMap } = originsPayload(form.rows);
    setBusy(true);
    try {
      const updated = await api.patch<Site>(`/sites/${site.id}`, {
        name: form.name.trim(),
        defaultDepartmentId: form.defaultDepartmentId || null,
        scheduleId: form.scheduleId || null,
        ...(originsChanged ? { origins } : {}),
        expectedVersion: base.version,
      });
      qc.setQueryData(siteKey(site.id), updated);
      void qc.invalidateQueries({ queryKey: qk.sites, exact: true });
      const f = fromSite(updated);
      setBase({ version: updated.version, form: f });
      setForm(f);
      toast.success(t('sites.general.saved'));
      return true;
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) setConflict(true);
      else {
        const rowErrors = originErrorsFrom(e, indexMap);
        setOriginErrors(rowErrors);
        if (isApiError(e)) setNameError(e.field('name') ?? null);
        setError(
          isApiError(e, 'NOT_FOUND')
            ? t('sites.general.notFoundChoose', { error: errorMessage(e) })
            : Object.keys(rowErrors).length
              ? t('sites.create.fixOrigins')
              : errorMessage(e),
        );
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => onDirtyChange(dirty, () => saveRef.current()), [dirty, onDirtyChange]);

  const setEnabled = async (enabled: boolean) => {
    const updated = await api.patch<Site>(`/sites/${site.id}`, { enabled });
    qc.setQueryData(siteKey(site.id), updated);
    void qc.invalidateQueries({ queryKey: qk.sites, exact: true });
    // Only `enabled` changed on the server; keep any in-progress edits valid.
    setBase((b) => ({ ...b, version: updated.version }));
    toast.success(enabled ? t('sites.general.widgetEnabledToast') : t('sites.general.widgetDisabledToast'));
  };

  const archive = async () => {
    await api.post(`/sites/${site.id}/archive`);
    onDirtyChange(false, async () => true);
    await qc.invalidateQueries({ queryKey: qk.sites });
    toast.success(t('sites.general.archived', { name: isolate(site.name) }));
    router.push('/settings/sites');
  };

  const deptOptions = useMemo(
    () => (departments.data ?? []).filter((d) => !d.archivedAt || d.id === form.defaultDepartmentId),
    [departments.data, form.defaultDepartmentId],
  );
  const scheduleOptions = (schedules.data ?? []).filter((s) => !s.archivedAt || s.id === form.scheduleId);
  const tenantDefault = (schedules.data ?? []).find((s) => s.isTenantDefault);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title={t('sites.list.colWebsite')}
          description={t('sites.general.description')}
        />
        <CardBody className="flex flex-col gap-5">
          {conflict && (
            <Banner
              tone="warning"
              title={t('sites.general.conflictTitle')}
              action={
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  {t('common.reload')}
                </Button>
              }
            >
              {t('sites.general.conflictBody')}
            </Banner>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
          <Field label={t('sites.create.name')} error={nameError} required>
            <Input
              dir="auto"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={120}
              disabled={!canManage}
            />
          </Field>
          <div className="flex min-h-11 items-center justify-between gap-6 rounded-[var(--radius-control)] border border-line-subtle px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <span id="site-enabled-label" className="text-sm font-medium">
                {t('sites.general.widgetEnabled')}
              </span>
              <span id="site-enabled-desc" className="text-xs text-fg-2">
                {site.enabled ? t('sites.general.widgetOnHint') : t('sites.general.widgetOffHint')}
              </span>
            </div>
            <Switch
              checked={site.enabled}
              aria-labelledby="site-enabled-label"
              aria-describedby="site-enabled-desc"
              disabled={!canManage}
              onCheckedChange={(c) =>
                c ? void setEnabled(true).catch((e) => setError(errorMessage(e))) : setConfirm('disable')
              }
            />
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <Field
              label={t('sites.general.defaultDepartment')}
              description={t('sites.general.defaultDepartmentHint')}
            >
              <Select
                value={form.defaultDepartmentId}
                onChange={(e) => setForm({ ...form, defaultDepartmentId: e.target.value })}
                disabled={!canManage || departments.isLoading}
              >
                <option value="">{t('sites.general.noDefaultDepartment')}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {t('sites.general.departmentOption', { name: d.name, state: d.archivedAt ? 'archived' : !d.enabled ? 'disabled' : 'ok' })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('sites.general.hours')}
              description={
                !canSchedules
                  ? t('sites.general.noScheduleAccess')
                  : schedules.isError
                    ? t('sites.general.schedulesFailed')
                    : t('sites.general.hoursHint')
              }
            >
              <Select
                value={form.scheduleId}
                onChange={(e) => setForm({ ...form, scheduleId: e.target.value })}
                disabled={!canManage || !canSchedules || schedules.isLoading}
              >
                <option value="">
                  {tenantDefault ? t('sites.general.workspaceDefaultNamed', { name: isolate(tenantDefault.name) }) : t('sites.general.workspaceDefault')}
                </option>
                {scheduleOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t('sites.general.scheduleOption', { name: s.name, zone: s.timezone, archived: s.archivedAt ? 'yes' : 'no' })}
                  </option>
                ))}
                {form.scheduleId && !scheduleOptions.some((s) => s.id === form.scheduleId) && (
                  <option value={form.scheduleId}>{t('sites.general.currentSchedule')}</option>
                )}
              </Select>
            </Field>
          </div>
          {canSchedules && !schedules.isLoading && !scheduleOptions.length && (
            <p className="text-xs text-fg-2">
              {t('sites.general.noSchedules')}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('sites.origins.legend')}
          description={t('sites.general.originsDescription')}
        />
        <CardBody>
          <OriginsEditor
            rows={form.rows}
            onChange={(rows) => {
              setForm({ ...form, rows });
              setOriginErrors({});
            }}
            errors={originErrors}
            disabled={!canManage}
            legend={t('sites.list.colOrigins')}
          />
          {originsPayload(form.rows).origins.length === 0 && (
            <Banner tone="warning" className="mt-4">
              {t('sites.general.noOrigins')}
            </Banner>
          )}
        </CardBody>
      </Card>

      {canManage && (
        <div className="sticky bottom-0 z-[2] flex flex-wrap items-center justify-end gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
          <span className="me-auto text-sm text-fg-2" role="status" aria-live="polite">
            {dirty ? t('sites.general.unsaved') : t('sites.general.allSaved')}
          </span>
          <Button
            variant="ghost"
            disabled={!dirty || busy}
            onClick={() => {
              setForm(base.form);
              setOriginErrors({});
              setNameError(null);
              setError(null);
            }}
          >
            {t('sites.general.discard')}
          </Button>
          <Button variant="primary" disabled={!dirty} loading={busy} onClick={() => void save()}>
            {t('common.saveChanges')}
          </Button>
        </div>
      )}

      {canManage && (
        <Card className="border-danger/30">
          <CardHeader
            title={t('sites.general.archiveTitle')}
            description={t('sites.general.archiveDescription')}
          />
          <CardBody>
            <Button variant="danger-ghost" onClick={() => setConfirm('archive')}>
              <Archive className="size-4" aria-hidden />
              {t('sites.general.archiveButton', { name: isolate(site.name) })}
            </Button>
          </CardBody>
        </Card>
      )}

      <ConfirmDialog
        open={confirm === 'disable'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('sites.general.disableTitle', { name: isolate(site.name) })}
        danger
        confirmLabel={t('sites.general.disableConfirm')}
        description={t('sites.general.disableBody')}
        onConfirm={() => setEnabled(false)}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('sites.general.archiveConfirmTitle', { name: isolate(site.name) })}
        danger
        confirmLabel={t('sites.general.archiveTitle')}
        description={
          site.origins.length
            ? t('sites.general.archiveBody', { origins: new Intl.ListFormat(intlLocale(), { style: 'short', type: 'unit' }).format(site.origins.map((o) => isolate(o.origin))) })
            : t('sites.general.archiveBodyAll')
        }
        onConfirm={archive}
      />
    </div>
  );
}
