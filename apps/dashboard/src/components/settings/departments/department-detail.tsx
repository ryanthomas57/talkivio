'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, ConfirmDialog, EmptyState, Page, PanelError, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { intlLocale, isolate, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { qk, useDepartments } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { DepartmentStatus } from './departments-list';
import { AgentsTab } from './tab-agents';
import { GeneralTab } from './tab-general';
import { HoursTab } from './tab-hours';
import { RoutingTab } from './tab-routing';
import { asResource, useDepartmentsRealtime, type DepartmentResource } from './dept-shared';

const TABS: ReadonlyArray<{ id: 'general' | 'agents' | 'routing' | 'hours'; label: MessageKey }> = [
  { id: 'general', label: 'settings.departments.tabs.general' },
  { id: 'agents', label: 'settings.departments.tabs.agents' },
  { id: 'routing', label: 'settings.departments.tabs.routing' },
  { id: 'hours', label: 'settings.departments.tabs.hours' },
];
type TabId = (typeof TABS)[number]['id'];

export interface TabProps {
  dept: DepartmentResource;
  canManage: boolean;
  onDirtyChange: (dirty: boolean) => void;
  registerSave: (fn: () => Promise<boolean>) => void;
}

export function DepartmentDetail({ id }: { id: string }) {
  return (
    <Suspense>
      <Detail id={id} />
    </Suspense>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link href="/settings/departments" className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-fg-2 hover:text-fg">
      <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {t('common.departments')}
    </Link>
  );
}

function Detail({ id }: { id: string }) {
  const t = useT();
  useDepartmentsRealtime();
  const depts = useDepartments();
  const raw = depts.data?.find((d) => d.id === id);
  if (depts.isPending)
    return (
      <Page aria-busy>
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-80" />
      </Page>
    );
  if (depts.isError)
    return (
      <Page>
        <BackLink />
        <Card>
          <PanelError message={errorMessage(depts.error)} onRetry={() => void depts.refetch()} />
        </Card>
      </Page>
    );
  if (!raw)
    return (
      <Page>
        <BackLink />
        <Card>
          <EmptyState
            title={t('settings.departments.notFoundTitle')}
            description={t('settings.departments.notFoundBody')}
            action={
              <Button asChild variant="secondary">
                <Link href="/settings/departments">{t('settings.departments.backToList')}</Link>
              </Button>
            }
          />
        </Card>
      </Page>
    );
  return <Loaded dept={asResource(raw)} all={(depts.data ?? []).map(asResource)} />;
}

function Loaded({ dept, all }: { dept: DepartmentResource; all: DepartmentResource[] }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const canManage = useCan('departments.manage') && !dept.archivedAt;
  const tabParam = params.get('tab');
  const tab: TabId = TABS.some((x) => x.id === tabParam) ? (tabParam as TabId) : 'general';
  const [dirty, setDirty] = useState<Record<TabId, boolean>>({ general: false, agents: false, routing: false, hours: false });
  const saves = useRef<Partial<Record<TabId, () => Promise<boolean>>>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);

  const dirtySetter = useCallback((id: TabId) => (d: boolean) => setDirty((prev) => (prev[id] === d ? prev : { ...prev, [id]: d })), []);
  const onDirty = useRef({ general: dirtySetter('general'), agents: dirtySetter('agents'), routing: dirtySetter('routing'), hours: dirtySetter('hours') }).current;
  const register = useRef({
    general: (fn: () => Promise<boolean>) => {
      saves.current.general = fn;
    },
    agents: (fn: () => Promise<boolean>) => {
      saves.current.agents = fn;
    },
    routing: (fn: () => Promise<boolean>) => {
      saves.current.routing = fn;
    },
    hours: (fn: () => Promise<boolean>) => {
      saves.current.hours = fn;
    },
  }).current;

  const anyDirty = Object.values(dirty).some(Boolean);
  const guard = useDirtyGuard(anyDirty, {
    what: isolate(dept.name),
    onSave: async () => {
      let ok = true;
      for (const x of TABS) if (dirty[x.id] && saves.current[x.id]) ok = (await saves.current[x.id]!()) && ok;
      return ok;
    },
  });

  const setTab = (id: string) => {
    const next = new URLSearchParams(params.toString());
    if (id === 'general') next.delete('tab');
    else next.set('tab', id);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const fallbackFrom = all.filter((d) => d.fallbackDepartmentId === dept.id && !d.archivedAt);

  return (
    <Page>
      {guard}
      <BackLink />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="break-words text-xl" dir="auto">
            {dept.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
            <DepartmentStatus d={dept} />
            <span>{t('settings.departments.headerCounts', { waiting: dept.queued, members: dept.members.length })}</span>
          </div>
        </div>
        {canManage && (
          <Button variant="danger-ghost" onClick={() => setArchiveOpen(true)}>
            <Archive className="size-4" aria-hidden />
            {t('common.archive')}
          </Button>
        )}
      </div>
      {dept.archivedAt && <p className="text-sm text-fg-2">{t('settings.departments.archivedNote')}</p>}

      <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-6">
        <TabsList aria-label={t('settings.departments.tabsLabel')}>
          {TABS.map((x) => (
            <TabsTrigger key={x.id} value={x.id}>
              {t(x.label)}
              {dirty[x.id] && <span className="size-1.5 rounded-full bg-warning" aria-label={t('settings.departments.unsavedDot')} role="img" />}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Tabs stay mounted so unsaved edits survive switching tabs. */}
        <TabsContent value="general" forceMount className="data-[state=inactive]:hidden">
          <GeneralTab dept={dept} canManage={canManage} onDirtyChange={onDirty.general} registerSave={register.general} />
        </TabsContent>
        <TabsContent value="agents" forceMount className="data-[state=inactive]:hidden">
          <AgentsTab dept={dept} canManage={canManage} onDirtyChange={onDirty.agents} registerSave={register.agents} />
        </TabsContent>
        <TabsContent value="routing" forceMount className="data-[state=inactive]:hidden">
          <RoutingTab dept={dept} all={all} canManage={canManage} onDirtyChange={onDirty.routing} registerSave={register.routing} />
        </TabsContent>
        <TabsContent value="hours" forceMount className="data-[state=inactive]:hidden">
          <HoursTab dept={dept} canManage={canManage} onDirtyChange={onDirty.hours} registerSave={register.hours} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={t('settings.departments.archive.title', { name: isolate(dept.name) })}
        danger
        confirmLabel={t('settings.departments.archive.confirm')}
        description={t('settings.departments.archive.body')}
        onConfirm={async () => {
          await api.post(`/departments/${dept.id}/archive`);
          await qc.invalidateQueries({ queryKey: qk.departments });
          toast.success(t('settings.hours.archive.done', { name: isolate(dept.name) }));
          router.push('/settings/departments');
        }}
      >
        {fallbackFrom.length > 0 && (
          <p className="text-sm text-fg-2">
            {t('settings.departments.archive.fallbackFrom', { names: new Intl.ListFormat(intlLocale(), { style: 'short', type: 'unit' }).format(fallbackFrom.map((d) => isolate(d.name))), count: fallbackFrom.length })}
          </p>
        )}
      </ConfirmDialog>
    </Page>
  );
}
