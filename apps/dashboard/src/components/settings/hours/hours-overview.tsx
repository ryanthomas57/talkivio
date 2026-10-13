'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, DoorClosed, DoorOpen, Plus, Star } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Banner, Button, Card, CardHeader, CheckboxField, Dialog, DialogContent, EmptyState, Field, Input, Page, PageHeader, PanelError, RadioGroup, Skeleton, Table, TableScroll, TD, TH, THead, TimezonePicker, TR } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useCan, useSession } from '@/stores/session';
import { EmergencyClosures } from './emergency-closures';
import { hk, summarizeWeek, useHoursRealtime, useSchedules, type Schedule, type WeeklyIntervals } from './hours-api';

export function HoursOverview() {
  return (
    <Suspense>
      <Overview />
    </Suspense>
  );
}

function Overview() {
  const t = useT();
  useHoursRealtime();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const showArchived = params.get('archived') === '1';
  const canManage = useCan('schedules.manage');
  const tenant = useSession((s) => s.tenant);
  const weekStartsOn = tenant?.settings.locale.weekStartsOn ?? 1;
  const q = useSchedules(showArchived);
  const [creating, setCreating] = useState(false);
  const defaultSchedule = q.data?.find((s) => s.isTenantDefault);

  const toggleArchived = (on: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (on) next.set('archived', '1');
    else next.delete('archived');
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  return (
    <Page>
      <PageHeader
        title={t('settings.hours.title')}
        description={t('settings.hours.description')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              {t('settings.hours.newSchedule')}
            </Button>
          )
        }
      />

      <EmergencyClosures />

      <Card>
        <CardHeader
          title={t('settings.hours.schedules')}
          description={
            q.data
              ? defaultSchedule
                ? t('settings.hours.workspaceDefault', { name: isolate(defaultSchedule.name) })
                : t('settings.hours.noWorkspaceDefault')
              : t('settings.hours.schedulesHint')
          }
          action={<CheckboxField label={t('settings.hours.showArchived')} checked={showArchived} onCheckedChange={(c) => toggleArchived(c === true)} className="min-h-0 py-0" />}
        />
        {q.isPending ? (
          <div className="flex flex-col gap-2 p-4 sm:px-6">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : q.isError ? (
          <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title={showArchived ? t('settings.hours.emptyTitle') : t('settings.hours.emptyActiveTitle')}
            description={t('settings.hours.emptyBody')}
            action={
              canManage && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t('settings.hours.newSchedule')}
                </Button>
              )
            }
          />
        ) : (
          <TableScroll>
            <Table className="min-w-[720px]">
              <THead>
                <tr>
                  <TH>{t('common.name')}</TH>
                  <TH>{t('settings.hours.colNow')}</TH>
                  <TH>{t('settings.hours.weeklyHours')}</TH>
                  <TH>{t('common.timezone')}</TH>
                  <TH className="text-end">{t('settings.hours.specialDates')}</TH>
                </tr>
              </THead>
              <tbody>
                {q.data.map((s) => (
                  <ScheduleRow key={s.id} s={s} weekStartsOn={weekStartsOn} />
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      {creating && (
        <CreateScheduleDialog
          defaultTimezone={tenant?.timezone ?? 'UTC'}
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            router.push(`/settings/hours/${s.id}`);
          }}
        />
      )}
    </Page>
  );
}

function ScheduleRow({ s, weekStartsOn }: { s: Schedule; weekStartsOn: 0 | 1 }) {
  const t = useT();
  return (
    <TR>
      <TD>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/settings/hours/${s.id}`} className="font-medium text-primary hover:underline" dir="auto">
            {s.name}
          </Link>
          {s.isTenantDefault && <Badge tone="primary" icon={<Star className="size-3" aria-hidden />}>{t('settings.hours.default')}</Badge>}
          {s.archivedAt && <Badge>{t('settings.hours.archived')}</Badge>}
        </div>
      </TD>
      <TD className="whitespace-nowrap">
        {s.state ? (
          <div className="flex flex-col">
            <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${s.state.open ? 'text-success' : 'text-fg-2'}`}>
              {s.state.open ? <DoorOpen className="size-4" aria-hidden /> : <DoorClosed className="size-4" aria-hidden />}
              {s.state.open ? t('settings.hours.open') : t('settings.hours.closed')}
            </span>
            {s.state.nextBoundary && (
              <span className="text-xs text-fg-2">
                {s.state.nextBoundary.kind === 'open' ? t('settings.hours.opensAt', { time: s.state.nextBoundary.localLabel }) : t('settings.hours.closesAt', { time: s.state.nextBoundary.localLabel })}
              </span>
            )}
          </div>
        ) : (
          <span className="text-sm text-fg-2">—</span>
        )}
      </TD>
      <TD className="max-w-[320px]">
        <span className="line-clamp-2 text-sm text-fg-2">{summarizeWeek(s.weeklyIntervals, weekStartsOn)}</span>
      </TD>
      <TD className="whitespace-nowrap text-sm">{s.timezone.replace(/_/g, ' ')}</TD>
      <TD className="text-end tabular">{formatNumber(s.exceptionCount)}</TD>
    </TR>
  );
}

const EMPTY_WEEK: WeeklyIntervals = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
const OFFICE_WEEK: WeeklyIntervals = { ...EMPTY_WEEK, mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }], thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '17:00' }] };
const ALWAYS: WeeklyIntervals = Object.fromEntries(Object.keys(EMPTY_WEEK).map((d) => [d, [{ start: '00:00', end: '24:00' }]])) as WeeklyIntervals;

function CreateScheduleDialog({ defaultTimezone, onClose, onCreated }: { defaultTimezone: string; onClose: () => void; onCreated: (s: Schedule) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [template, setTemplate] = useState<'office' | 'always' | 'empty'>('office');
  const [errors, setErrors] = useState<{ name?: string; timezone?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => uuid());
  const weekly = useMemo(() => (template === 'office' ? OFFICE_WEEK : template === 'always' ? ALWAYS : EMPTY_WEEK), [template]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof errors = {};
    if (!name.trim()) fe.name = t('settings.hours.create.nameRequired');
    if (!timezone) fe.timezone = t('settings.general.workspace.timezoneRequired');
    setErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setMessage(null);
    try {
      const s = await api.post<Schedule>('/schedules', { name: name.trim(), timezone, weeklyIntervals: weekly }, { idempotencyKey: key });
      toast.success(t('settings.hours.create.created', { name: isolate(s.name) }));
      await qc.invalidateQueries({ queryKey: hk.schedulesRoot });
      onCreated(s);
    } catch (err) {
      if (err instanceof ApiError) setErrors({ name: err.field('name'), timezone: err.field('timezone') });
      setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        size="md"
        title={t('settings.hours.newSchedule')}
        description={t('settings.hours.create.description')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="schedule-form" variant="primary" loading={busy}>
              {t('settings.hours.create.submit')}
            </Button>
          </>
        }
      >
        <form id="schedule-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
          {message && <Banner tone="danger">{message}</Banner>}
          <Field label={t('common.name')} required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus placeholder={t('settings.hours.create.namePlaceholder')} dir="auto" />
          </Field>
          <Field label={t('common.timezone')} required error={errors.timezone}>
            <TimezonePicker value={timezone} onChange={setTimezone} />
          </Field>
          <RadioGroup
            legend={t('settings.hours.create.startFrom')}
            name="schedule-template"
            value={template}
            onChange={setTemplate}
            options={[
              { value: 'office', label: t('settings.hours.create.office'), description: t('settings.hours.create.officeHint') },
              { value: 'always', label: t('settings.hours.create.always') },
              { value: 'empty', label: t('settings.hours.closedEveryDay'), description: t('settings.hours.create.emptyHint') },
            ]}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
