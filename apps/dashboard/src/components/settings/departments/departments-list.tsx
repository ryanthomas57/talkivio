'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, CircleCheck, CircleSlash, Plus, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Banner,
  Button,
  Card,
  CheckboxField,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Page,
  PageHeader,
  PanelError,
  RadioGroup,
  Skeleton,
  SwitchField,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  Textarea,
  TR,
} from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { byId, qk, useAgents, useDepartments } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { useSchedules } from '../hours/hours-api';
import {
  asResource,
  eligibleOnline,
  routingLabel,
  routingOptions,
  useDepartmentsRealtime,
  type DepartmentResource,
} from './dept-shared';

export function DepartmentsList() {
  return (
    <Suspense>
      <List />
    </Suspense>
  );
}

function List() {
  const t = useT();
  useDepartmentsRealtime();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const canManage = useCan('departments.manage');
  const canAgents = useCan('agents.view');
  const canSchedules = useCan('schedules.view');
  const depts = useDepartments();
  const agents = useAgents();
  const schedules = useSchedules(true);
  const scheduleMap = useMemo(() => byId(schedules.data), [schedules.data]);
  const showArchived = params.get('archived') === '1';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);

  // Mirror the search box into the URL (debounced) so refresh/back restore it.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (query.trim()) next.set('q', query.trim());
      else next.delete('q');
      if (next.toString() !== params.toString())
        router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, params, pathname, router]);

  const setArchived = (on: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (on) next.set('archived', '1');
    else next.delete('archived');
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (depts.data ?? [])
      .map(asResource)
      .filter((d) => showArchived || !d.archivedAt)
      .filter(
        (d) =>
          !needle ||
          d.name.toLowerCase().includes(needle) ||
          (d.publicLabel ?? '').toLowerCase().includes(needle) ||
          (d.description ?? '').toLowerCase().includes(needle),
      );
  }, [depts.data, query, showArchived]);
  const archivedCount = (depts.data ?? []).filter((d) => d.archivedAt).length;

  return (
    <Page>
      <PageHeader
        title={t('common.departments')}
        description={t('settings.departments.description')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              {t('settings.departments.new')}
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line-subtle px-4 py-3 sm:px-6">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.departments.search')}
              aria-label={t('settings.departments.search')}
              className="ps-9"
            />
          </div>
          {archivedCount > 0 && (
            <CheckboxField
              label={t('settings.departments.showArchived', { count: archivedCount })}
              checked={showArchived}
              onCheckedChange={(c) => setArchived(c === true)}
              className="min-h-0 py-0"
            />
          )}
        </div>
        {depts.isPending ? (
          <div className="flex flex-col gap-2 p-4 sm:px-6">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : depts.isError ? (
          <PanelError message={errorMessage(depts.error)} onRetry={() => void depts.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={
              query.trim()
                ? t('settings.departments.noMatch', { query: isolate(query.trim()) })
                : t('settings.departments.emptyTitle')
            }
            description={
              query.trim() ? t('settings.departments.noMatchBody') : t('settings.departments.emptyBody')
            }
            action={
              query.trim() ? (
                <Button variant="secondary" onClick={() => setQuery('')}>
                  {t('settings.departments.clearSearch')}
                </Button>
              ) : (
                canManage && (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    {t('settings.departments.new')}
                  </Button>
                )
              )
            }
          />
        ) : (
          <TableScroll>
            <Table className="min-w-[760px]">
              <THead>
                <tr>
                  <TH>{t('common.department')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH className="text-end">{t('settings.departments.colAvailable')}</TH>
                  <TH className="text-end">{t('settings.departments.colWaiting')}</TH>
                  <TH>{t('settings.departments.tabs.hours')}</TH>
                  <TH>{t('settings.departments.tabs.routing')}</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((d) => (
                  <Row
                    key={d.id}
                    d={d}
                    eligible={canAgents ? eligibleOnline(d, agents.data) : null}
                    scheduleName={
                      d.scheduleId
                        ? canSchedules
                          ? (scheduleMap.get(d.scheduleId)?.name ??
                            (schedules.isPending ? '…' : t('settings.departments.unknownSchedule')))
                          : t('settings.departments.ownSchedule')
                        : null
                    }
                    scheduleOpen={d.scheduleId ? (scheduleMap.get(d.scheduleId)?.state?.open ?? null) : null}
                  />
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>
      {creating && (
        <CreateDepartmentDialog
          onClose={() => setCreating(false)}
          onCreated={(d) => router.push(`/settings/departments/${d.id}`)}
        />
      )}
    </Page>
  );
}

function Row({
  d,
  eligible,
  scheduleName,
  scheduleOpen,
}: {
  d: DepartmentResource;
  eligible: number | null;
  scheduleName: string | null;
  scheduleOpen: boolean | null;
}) {
  const t = useT();
  const servers = d.members.filter((m) => m.canServe).length;
  return (
    <TR>
      <TD>
        <Link
          href={`/settings/departments/${d.id}`}
          className="font-medium text-primary hover:underline"
          dir="auto"
        >
          {d.name}
        </Link>
        {d.publicLabel && d.publicLabel !== d.name && (
          <p className="text-xs text-fg-2">
            {t('settings.departments.shownAs', { label: isolate(d.publicLabel) })}
          </p>
        )}
      </TD>
      <TD>
        <DepartmentStatus d={d} />
      </TD>
      <TD className="text-end tabular">
        {eligible === null ? (
          <span className="text-fg-2" title={t('settings.departments.noRosterAccess')}>
            {t('common.notAvailable')}
          </span>
        ) : (
          <span>
            <span aria-hidden>
              <span
                className={
                  eligible === 0 && !d.archivedAt && d.enabled
                    ? 'font-semibold text-warning'
                    : 'font-semibold'
                }
              >
                {formatNumber(eligible)}
              </span>
              <span className="text-fg-2"> / {formatNumber(servers)}</span>
            </span>
            <span className="sr-only">
              {t('settings.departments.availableSr', { count: eligible, servers })}
            </span>
          </span>
        )}
      </TD>
      <TD className="text-end tabular">
        <span className={d.queued > 0 ? 'font-semibold' : 'text-fg-2'}>{formatNumber(d.queued)}</span>
      </TD>
      <TD className="text-sm">
        {scheduleName ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <bdi>{scheduleName}</bdi>
            {scheduleOpen !== null && (
              <Badge tone={scheduleOpen ? 'success' : 'neutral'}>
                {scheduleOpen ? t('settings.hours.open') : t('settings.hours.closed')}
              </Badge>
            )}
          </span>
        ) : (
          <span className="text-fg-2">{t('settings.departments.siteOrDefault')}</span>
        )}
      </TD>
      <TD className="whitespace-nowrap text-sm">{routingLabel(t, d.routingMode)}</TD>
    </TR>
  );
}

export function DepartmentStatus({ d }: { d: DepartmentResource }) {
  const t = useT();
  if (d.archivedAt)
    return <Badge icon={<Archive className="size-3.5" aria-hidden />}>{t('settings.hours.archived')}</Badge>;
  return d.enabled ? (
    <Badge tone="success" icon={<CircleCheck className="size-3.5" aria-hidden />}>
      {t('common.enabled')}
    </Badge>
  ) : (
    <Badge tone="warning" icon={<CircleSlash className="size-3.5" aria-hidden />}>
      {t('common.disabled')}
    </Badge>
  );
}

function CreateDepartmentDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (d: DepartmentResource) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [publicLabel, setPublicLabel] = useState('');
  const [description, setDescription] = useState('');
  const [routingMode, setRoutingMode] = useState<DepartmentResource['routingMode']>('broadcast');
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; publicLabel?: string; description?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof errors = {};
    if (!name.trim()) fe.name = t('settings.departments.nameRequired');
    if (publicLabel.trim().length > 80) fe.publicLabel = t('settings.profile.maxChars', { max: 80 });
    if (description.trim().length > 300) fe.description = t('settings.profile.maxChars', { max: 300 });
    setErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setMessage(null);
    try {
      const d = await api.post<DepartmentResource>('/departments', {
        name: name.trim(),
        publicLabel: publicLabel.trim() || undefined,
        description: description.trim() || null,
        routingMode,
        enabled,
      });
      await qc.invalidateQueries({ queryKey: qk.departments });
      toast.success(t('settings.hours.create.created', { name: isolate(d.name) }));
      onCreated(d);
    } catch (err) {
      if (isApiError(err, 'CONFLICT')) setErrors({ name: err.message });
      else if (err instanceof ApiError && Object.keys(err.fieldErrors).length)
        setErrors({
          name: err.field('name'),
          publicLabel: err.field('public_label'),
          description: err.field('description'),
        });
      else setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        size="md"
        title={t('settings.departments.new')}
        description={t('settings.departments.create.description')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="dept-form" variant="primary" loading={busy}>
              {t('settings.departments.create.submit')}
            </Button>
          </>
        }
      >
        <form id="dept-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
          {message && <Banner tone="danger">{message}</Banner>}
          <Field
            label={t('common.name')}
            required
            description={t('settings.departments.general.nameHint')}
            error={errors.name}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
              placeholder={t('settings.departments.create.namePlaceholder')}
              dir="auto"
            />
          </Field>
          <Field
            label={t('settings.departments.general.publicLabel')}
            description={t('settings.departments.create.publicLabelHint')}
            error={errors.publicLabel}
          >
            <Input
              value={publicLabel}
              onChange={(e) => setPublicLabel(e.target.value)}
              maxLength={80}
              placeholder={name || t('settings.departments.create.publicLabelPlaceholder')}
              dir="auto"
            />
          </Field>
          <Field
            label={t('common.description')}
            description={t('settings.departments.general.descriptionHint', { max: 300 })}
            error={errors.description}
          >
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              rows={2}
              dir="auto"
            />
          </Field>
          <RadioGroup
            legend={t('settings.departments.tabs.routing')}
            name="new-dept-routing"
            value={routingMode}
            onChange={setRoutingMode}
            options={routingOptions(t)}
          />
          <SwitchField
            label={t('common.enabled')}
            description={t('settings.departments.create.enabledHint')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
