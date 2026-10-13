'use client';
import { RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { Button, Field, Input, Select, SwitchField, TimezonePicker } from '@/components/ui';
import { useT } from '@/i18n';
import { useAgents, useDepartments, useSites, useTags } from '@/lib/queries';
import { useSession } from '@/stores/session';
import { MAX_DAYS, PRESETS, todayIn, type RangePreset } from './range';
import type { AnalyticsParams } from './use-analytics-params';

/**
 * Report filters (ch. 51): date presets in the report timezone, grouping,
 * comparison and dimension filters. Every value is written to the URL.
 */
export function FiltersBar({ params: p, update }: { params: AnalyticsParams; update: (patch: Record<string, string | null>) => void }) {
  const t = useT();
  const NOT_APPLIED = t('analytics.filters.notApplied');
  const scope = useSession((s) => s.agent?.departmentScope ?? 'all');
  const departments = useDepartments();
  const agents = useAgents();
  const tags = useTags();
  const sites = useSites();

  const deptOptions = useMemo(
    () => (departments.data ?? []).filter((d) => !d.archivedAt && (scope === 'all' || scope.includes(d.id))).sort((a, b) => a.name.localeCompare(b.name)),
    [departments.data, scope],
  );
  const agentOptions = useMemo(() => (agents.data ?? []).filter((a) => a.enabled).sort((a, b) => a.displayName.localeCompare(b.displayName)), [agents.data]);
  const tagOptions = useMemo(() => (tags.data ?? []).filter((tag) => !tag.archivedAt).sort((a, b) => a.label.localeCompare(b.label)), [tags.data]);
  const siteOptions = useMemo(() => (sites.data ?? []).filter((s) => !s.archivedAt), [sites.data]);
  const today = todayIn(p.timezone);
  const active = !!(p.siteId || p.departmentId || p.currentDepartmentId || p.agentId || p.tagId);

  const tabApplies = {
    site: true,
    dept: true,
    cdept: p.tab === 'chats',
    agent: p.tab !== 'invitations',
    tag: p.tab === 'chats',
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('analytics.filters.dateRange')}>
          <Select
            value={p.preset}
            onChange={(e) => {
              const v = e.target.value as RangePreset;
              update(v === 'custom' ? { range: v, from: p.customFrom ?? p.range.first, to: p.customTo ?? p.range.last } : { range: v, from: null, to: null, group: null });
            }}
          >
            {PRESETS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </Select>
        </Field>
        {p.preset === 'custom' && (
          <>
            <Field label={t('common.from')} error={p.range.error && !p.customFrom ? p.range.error : null}>
              <Input type="date" value={p.customFrom ?? ''} max={today} onChange={(e) => update({ from: e.target.value || null })} />
            </Field>
            <Field label={t('analytics.filters.toInclusive')} error={p.range.error && p.customFrom ? p.range.error : null}>
              <Input type="date" value={p.customTo ?? ''} max={today} min={p.customFrom ?? undefined} onChange={(e) => update({ to: e.target.value || null })} />
            </Field>
          </>
        )}
        <Field label={t('analytics.filters.groupBy')} description={p.range.days > MAX_DAYS.hour ? t('analytics.filters.hourlyLimit', { days: MAX_DAYS.hour }) : undefined}>
          <Select value={p.group} onChange={(e) => update({ group: e.target.value })} disabled={p.tab !== 'chats'}>
            <option value="hour" disabled={p.range.days > MAX_DAYS.hour}>
              {t('analytics.chart.hour')}
            </option>
            <option value="day" disabled={p.range.days > MAX_DAYS.day}>
              {t('analytics.chart.day')}
            </option>
            <option value="week">{t('analytics.chart.week')}</option>
          </Select>
        </Field>
        <Field label={t('common.timezone')} description={p.timezone === p.workspaceTimezone ? t('analytics.filters.workspaceTz') : t('analytics.filters.workspaceDefault', { tz: p.workspaceTimezone })}>
          <TimezonePicker value={p.timezone} onChange={(tz) => update({ tz: tz === p.workspaceTimezone ? null : tz })} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {siteOptions.length > 0 && (
          <Field label={t('analytics.filters.site')}>
            <Select value={p.siteId ?? ''} onChange={(e) => update({ site: e.target.value || null })}>
              <option value="">{t('analytics.filters.allSites')}</option>
              {siteOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('analytics.filters.admissionDept')} description={tabApplies.dept ? t('analytics.filters.admissionDeptHint') : NOT_APPLIED}>
          <Select value={p.departmentId ?? ''} onChange={(e) => update({ dept: e.target.value || null })}>
            <option value="">{scope === 'all' ? t('analytics.filters.allDepartments') : t('analytics.filters.allMyDepartments')}</option>
            {deptOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('analytics.filters.currentDept')} description={tabApplies.cdept ? t('analytics.filters.currentDeptHint') : NOT_APPLIED}>
          <Select value={p.currentDepartmentId ?? ''} onChange={(e) => update({ cdept: e.target.value || null })}>
            <option value="">{t('analytics.filters.any')}</option>
            {deptOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        {agents.data && (
          <Field label={t('common.agent')} description={tabApplies.agent ? t('analytics.filters.agentHint') : NOT_APPLIED}>
            <Select value={p.agentId ?? ''} onChange={(e) => update({ agent: e.target.value || null })}>
              <option value="">{t('analytics.filters.allAgents')}</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('analytics.filters.tag')} description={tabApplies.tag ? undefined : NOT_APPLIED}>
          <Select value={p.tagId ?? ''} onChange={(e) => update({ tag: e.target.value || null })}>
            <option value="">{t('analytics.filters.anyTag')}</option>
            {tagOptions.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {p.tab === 'chats' ? (
          <SwitchField
            label={t('analytics.filters.compare')}
            description={t('analytics.filters.compareHint')}
            checked={p.compare}
            onCheckedChange={(c) => update({ compare: c ? null : 'none' })}
            className="min-w-0 flex-1 justify-start gap-4 [&>button]:order-first"
          />
        ) : (
          <span />
        )}
        {active && (
          <Button variant="ghost" size="sm" onClick={() => update({ site: null, dept: null, cdept: null, agent: null, tag: null })}>
            <RotateCcw className="size-4" aria-hidden />
            {t('analytics.filters.clear')}
          </Button>
        )}
      </div>
    </div>
  );
}
