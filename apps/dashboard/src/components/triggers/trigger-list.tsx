'use client';
/**
 * Trigger list (ch. 33 interface): name, event, status, priority, last matched,
 * match / error counts; create from blank or as a copy (starter templates are
 * seeded by the API as disabled triggers on first load); enable/disable through
 * publish; archive with confirmation; invitation funnels for campaign triggers.
 * Refreshes live when any trigger is published, enabled, disabled or archived.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleDashed,
  Copy,
  MoreHorizontal,
  Pencil,
  PauseCircle,
  Plus,
  Trash2,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DSL_EVENTS, type DslEvent } from '@talkivio/contracts';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Page,
  PageHeader,
  PanelError,
  RadioGroup,
  Select,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { departmentNamer, describeAction, eventLabel } from './dsl-ui';
import { FunnelPanel, FunnelRangeSelect, type FunnelRange } from './funnel';
import { archiveTrigger, publishTrigger, setTriggerEnabled } from './trigger-commands';
import {
  hasInvitation,
  tk,
  triggerStatus,
  useTriggers,
  useTriggersRealtime,
  type TriggerListItem,
} from './triggers-api';

export function TriggerList() {
  return (
    <Suspense>
      <ListPage />
    </Suspense>
  );
}

export function StatusBadge({
  t: trigger,
}: {
  t: Pick<TriggerListItem, 'publishedRevision' | 'enabled' | 'draftPending'>;
}) {
  const t = useT();
  const s = triggerStatus(trigger);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {s === 'enabled' ? (
        <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
          {t('triggers.status.enabled')}
        </Badge>
      ) : s === 'disabled' ? (
        <Badge tone="neutral" icon={<PauseCircle className="size-3.5" aria-hidden />}>
          {t('triggers.status.disabled')}
        </Badge>
      ) : (
        <Badge tone="warning" icon={<CircleDashed className="size-3.5" aria-hidden />}>
          {t('triggers.status.draft')}
        </Badge>
      )}
      {s !== 'draft' && trigger.draftPending && (
        <Badge tone="info">{t('triggers.status.unpublishedChanges')}</Badge>
      )}
    </span>
  );
}

function ListPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const eventParam = params.get('event');
  const event =
    eventParam && (DSL_EVENTS as readonly string[]).includes(eventParam) ? (eventParam as DslEvent) : null;
  const canManage = useCan('triggers.manage');
  const q = useTriggers(event);
  const all = useTriggers(null);
  // Publish / enable / disable / archive anywhere refreshes the list (trigger.published on team:all).
  useTriggersRealtime();
  const [creating, setCreating] = useState(false);
  const [toggle, setToggle] = useState<{ t: TriggerListItem; enabled: boolean } | null>(null);
  const [archiving, setArchiving] = useState<TriggerListItem | null>(null);
  const [funnelRange, setFunnelRange] = useState<FunnelRange>('30');
  const qc = useQueryClient();
  const depts = useDepartments();
  const deptById = useMemo(() => byId(depts.data), [depts.data]);
  const deptName = departmentNamer(t, (id) => deptById.get(id)?.name);

  const setEvent = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set('event', v);
    else next.delete('event');
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const invitationTriggers = (all.data ?? []).filter((tr) => hasInvitation(tr.definition));
  const refresh = () => qc.invalidateQueries({ queryKey: tk.root });

  return (
    <Page>
      <PageHeader
        title={t('triggers.list.title')}
        description={t('triggers.list.description')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              {t('triggers.list.new')}
            </Button>
          )
        }
      />

      <Card>
        <CardHeader
          title={t('triggers.list.allTriggers')}
          description={
            q.data
              ? event
                ? t('triggers.list.countForEvent', { count: q.data.length, event: eventLabel(t, event) })
                : t('triggers.list.count', { count: q.data.length })
              : t('triggers.list.loading')
          }
          action={
            <Field label={t('triggers.label.event')} hideLabel>
              <Select
                compact
                value={event ?? ''}
                onChange={(e) => setEvent(e.target.value)}
                className="w-56"
                aria-label={t('triggers.list.filterByEvent')}
              >
                <option value="">{t('triggers.list.allEvents')}</option>
                {DSL_EVENTS.map((e) => (
                  <option key={e} value={e}>
                    {eventLabel(t, e)}
                  </option>
                ))}
              </Select>
            </Field>
          }
        />
        {q.isPending ? (
          <div className="flex flex-col gap-2 p-4 sm:px-6" aria-busy>
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : q.isError ? (
          <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState
            icon={<Workflow />}
            title={event ? t('triggers.list.emptyEventTitle') : t('triggers.list.emptyTitle')}
            description={event ? t('triggers.list.emptyEventBody') : t('triggers.list.emptyBody')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t('triggers.list.new')}
                </Button>
              ) : event ? (
                <Button variant="secondary" onClick={() => setEvent('')}>
                  {t('triggers.list.showAllEvents')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <TableScroll>
            <Table className="min-w-[880px]">
              <THead>
                <tr>
                  <TH>{t('common.name')}</TH>
                  <TH>{t('triggers.label.event')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH className="text-end">{t('triggers.label.priority')}</TH>
                  <TH>{t('triggers.list.colLastMatched')}</TH>
                  <TH className="text-end">{t('triggers.list.colMatches')}</TH>
                  <TH className="text-end">{t('triggers.list.colErrors')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {q.data.map((tr) => (
                  <TR key={tr.id}>
                    <TD className="max-w-[320px] py-3">
                      <Link
                        href={`/settings/triggers/${tr.id}`}
                        className="font-medium text-fg underline-offset-4 hover:text-primary hover:underline"
                        dir="auto"
                      >
                        {tr.name}
                      </Link>
                      {tr.description && (
                        <p className="line-clamp-2 text-xs text-fg-2" dir="auto">
                          {tr.description}
                        </p>
                      )}
                    </TD>
                    <TD className="text-sm">{eventLabel(t, tr.event)}</TD>
                    <TD>
                      <StatusBadge t={tr} />
                    </TD>
                    <TD className="text-end tabular">{tr.priority}</TD>
                    <TD className="whitespace-nowrap text-sm">
                      {tr.lastMatchedAt ? (
                        <time dateTime={tr.lastMatchedAt} title={formatDateTime(tr.lastMatchedAt)}>
                          {formatRelative(tr.lastMatchedAt)}
                        </time>
                      ) : (
                        <span className="text-fg-2">{t('triggers.list.never')}</span>
                      )}
                    </TD>
                    <TD className="text-end tabular">{formatNumber(tr.matchCount)}</TD>
                    <TD className="text-end tabular">
                      {tr.errorCount > 0 ? (
                        <span className="font-medium text-danger">{formatNumber(tr.errorCount)}</span>
                      ) : (
                        formatNumber(tr.errorCount)
                      )}
                    </TD>
                    <TD className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setToggle({ t: tr, enabled: !tr.enabled })}
                          >
                            {!tr.publishedRevision
                              ? t('common.publish')
                              : tr.enabled
                                ? t('common.disable')
                                : t('common.enable')}
                          </Button>
                        )}
                        <Menu>
                          <MenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t('triggers.list.moreActionsFor', { name: isolate(tr.name) })}
                            >
                              <MoreHorizontal className="size-4" aria-hidden />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem
                              icon={<Pencil />}
                              onSelect={() => router.push(`/settings/triggers/${tr.id}`)}
                            >
                              {canManage ? t('common.edit') : t('common.view')}
                            </MenuItem>
                            {canManage && (
                              <MenuItem
                                icon={<Copy />}
                                onSelect={() => router.push(`/settings/triggers/new?from=${tr.id}`)}
                              >
                                {t('triggers.list.duplicate')}
                              </MenuItem>
                            )}
                            {canManage && (
                              <>
                                <MenuSeparator />
                                <MenuItem icon={<Trash2 />} danger onSelect={() => setArchiving(tr)}>
                                  {t('common.archive')}
                                </MenuItem>
                              </>
                            )}
                          </MenuContent>
                        </Menu>
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      {invitationTriggers.length > 0 && (
        <Card>
          <CardHeader
            title={t('triggers.list.funnels')}
            description={t('triggers.list.funnelsHelp')}
            action={<FunnelRangeSelect value={funnelRange} onChange={setFunnelRange} />}
          />
          <CardBody className="flex flex-col gap-6">
            {invitationTriggers.map((tr) => (
              <section key={tr.id} aria-labelledby={`funnel-${tr.id}`} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id={`funnel-${tr.id}`} className="text-sm font-semibold text-fg">
                    <Link
                      href={`/settings/triggers/${tr.id}?tab=invitations`}
                      className="underline-offset-4 hover:text-primary hover:underline"
                      dir="auto"
                    >
                      {tr.name}
                    </Link>
                  </h3>
                  <StatusBadge t={tr} />
                </div>
                <FunnelPanel triggerId={tr.id} range={funnelRange} compact />
              </section>
            ))}
          </CardBody>
        </Card>
      )}

      {creating && <CreateTriggerDialog triggers={all.data ?? []} onClose={() => setCreating(false)} />}

      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && setToggle(null)}
        title={
          !toggle
            ? ''
            : t(
                !toggle.t.publishedRevision
                  ? 'triggers.list.publishTitle'
                  : toggle.enabled
                    ? 'triggers.list.enableTitle'
                    : 'triggers.list.disableTitle',
                { name: isolate(toggle.t.name) },
              )
        }
        description={
          !toggle
            ? ''
            : !toggle.t.publishedRevision
              ? t('triggers.list.publishBody', {
                  revision: toggle.t.currentRevision,
                  event: eventLabel(t, toggle.t.event),
                })
              : toggle.enabled
                ? t(toggle.t.draftPending ? 'triggers.list.enableBodyDraft' : 'triggers.list.enableBody', {
                    revision: toggle.t.publishedRevision,
                    event: eventLabel(t, toggle.t.event),
                  })
                : t('triggers.list.disableBody', { revision: toggle.t.publishedRevision })
        }
        confirmLabel={
          !toggle
            ? ''
            : !toggle.t.publishedRevision
              ? t('triggers.list.publishAndEnable')
              : toggle.enabled
                ? t('common.enable')
                : t('common.disable')
        }
        danger={!!toggle && !toggle.enabled && !!toggle.t.publishedRevision}
        onConfirm={async () => {
          if (!toggle) return;
          const { t: tr, enabled } = toggle;
          try {
            if (!tr.publishedRevision) await publishTrigger(tr.id, tr.currentRevision, true);
            else await setTriggerEnabled(tr, enabled);
          } catch (e) {
            if (isApiError(e, 'VERSION_CONFLICT')) {
              void refresh();
              throw new Error(t('triggers.list.changedSinceLoad'));
            }
            throw e;
          }
          toast.success(
            !tr.publishedRevision
              ? t('triggers.list.publishedEnabled')
              : enabled
                ? t('triggers.list.enabledToast')
                : t('triggers.list.disabledToast'),
          );
          await refresh();
        }}
      >
        {toggle &&
          (!toggle.t.publishedRevision || toggle.enabled) &&
          toggle.t.definition &&
          !toggle.t.draftPending && (
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium text-fg">{t('triggers.label.whenMatches')}</p>
              <ul className="list-disc ps-5 text-fg-2">
                {toggle.t.definition.actions.map((a, i) => (
                  <li key={i}>{describeAction(t, a, { department: deptName })}</li>
                ))}
              </ul>
            </div>
          )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={archiving ? t('triggers.list.archiveTitle', { name: isolate(archiving.name) }) : ''}
        description={t('triggers.list.archiveBody')}
        confirmLabel={t('triggers.list.archiveConfirm')}
        danger
        onConfirm={async () => {
          if (!archiving) return;
          try {
            await archiveTrigger(archiving.id, archiving.version);
          } catch (e) {
            if (isApiError(e, 'VERSION_CONFLICT')) {
              void refresh();
              throw new Error(t('triggers.list.changedSinceLoad'));
            }
            throw e;
          }
          toast.success(t('triggers.list.archivedToast'));
          await refresh();
        }}
      />
    </Page>
  );
}

function CreateTriggerDialog({ triggers, onClose }: { triggers: TriggerListItem[]; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [mode, setMode] = useState<'blank' | 'copy'>(triggers.length ? 'copy' : 'blank');
  const [event, setEvent] = useState<DslEvent>('visitor.timer.elapsed');
  const [from, setFrom] = useState<string>(triggers[0]?.id ?? '');
  const go = () => {
    if (mode === 'copy' && from) router.push(`/settings/triggers/new?from=${from}`);
    else router.push(`/settings/triggers/new?event=${encodeURIComponent(event)}`);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('triggers.list.new')}
        description={t('triggers.create.description')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={go} disabled={mode === 'copy' && !from}>
              {t('common.continue')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <RadioGroup
            legend={t('triggers.create.startFrom')}
            name="trigger-start"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'copy',
                label: t('triggers.create.copyLabel'),
                description: t('triggers.create.copyHelp'),
                disabled: !triggers.length,
              },
              {
                value: 'blank',
                label: t('triggers.create.blankLabel'),
                description: t('triggers.create.blankHelp'),
              },
            ]}
          />
          {mode === 'copy' ? (
            <Field label={t('triggers.create.triggerToCopy')}>
              <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                {triggers.map((tr) => (
                  <option key={tr.id} value={tr.id}>
                    {tr.name} ({eventLabel(t, tr.event)})
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={t('triggers.label.event')} description={t('triggers.create.eventHelp')}>
              <Select value={event} onChange={(e) => setEvent(e.target.value as DslEvent)}>
                {DSL_EVENTS.map((e) => (
                  <option key={e} value={e}>
                    {eventLabel(t, e)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!triggers.length && mode === 'blank' && (
            <Banner tone="info">{t('triggers.create.nothingToCopy')}</Banner>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
