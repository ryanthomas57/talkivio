'use client';
/**
 * History detail (ch. 17/20): Transcript tab (server-ordered by sequence, notes
 * only when the API returns them, load earlier) and Metadata tab (ids, times in
 * the workspace time zone, wait / first response, close reason, ownership events,
 * rating, tags). Actions: export, email transcript, open visitor profile.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Copy,
  Download,
  Mail,
  MessageSquareOff,
  ThumbsDown,
  ThumbsUp,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Page,
  PageHeader,
  PanelError,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { MessageBubble, SystemRow } from '@/components/inbox/message-bubble';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { dayLabel, formatDuration, formatDurationLong, formatNumber, sameDay } from '@/lib/format';
import { byId, useAgents, useDepartments, useSites } from '@/lib/queries';
import type { Message, MessagePage, StaffChat } from '@/lib/types';
import { useSession } from '@/stores/session';
import { ChatStatusLabel } from '../visitors/chat-status';
import { safeHref, urlLabel } from '../visitors/display';
import { TagEditor } from '../visitors/tag-editor';
import { EmailTranscriptDialog } from './email-dialog';
import { ExportDialog, type ExportSource } from './export-dialog';
import { historyKeys } from './types';
import { formatInZone, validTimeZone } from './tz';

const MSG_PAGE = 50;

const STARTED_BY: Record<string, MessageKey> = {
  visitor: 'history.startedBy.visitor',
  invitation: 'history.startedBy.invitation',
};
const CLOSE_REASON: Record<string, MessageKey> = {
  resolved: 'history.closeReason.resolved',
  ended: 'history.closeReason.ended',
  visitor_ended: 'history.closeReason.visitorEnded',
  visitor_disconnected: 'history.closeReason.visitorDisconnected',
  converted_offline: 'history.closeReason.convertedOffline',
  inactivity: 'history.closeReason.inactivity',
};
const ROUTE_REASON: Record<string, MessageKey> = {
  default: 'history.routeReason.default',
  department_selected: 'history.routeReason.departmentSelected',
  invitation_accepted: 'history.routeReason.invitationAccepted',
  max_wait_fallback: 'history.routeReason.maxWaitFallback',
  site_default: 'history.routeReason.siteDefault',
  trigger_override: 'history.routeReason.triggerOverride',
  fallback: 'history.routeReason.fallback',
};

/** Known codes get translated labels; anything else is shown as the readable code. */
function codeLabel(map: Record<string, MessageKey>, code: string, t: (k: MessageKey) => string): string {
  const key =
    map[code] ?? (map === CLOSE_REASON && code.startsWith('inactivity') ? map.inactivity : undefined);
  return key ? t(key) : code.replace(/_/g, ' ');
}

function useTranscript(chatId: string) {
  return useInfiniteQuery({
    queryKey: historyKeys.messages(chatId),
    queryFn: ({ pageParam }) =>
      api.get<MessagePage>(`/chats/${chatId}/messages`, {
        beforeSeq: pageParam ?? undefined,
        limit: MSG_PAGE,
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => (last.hasMore && last.items[0] ? last.items[0].seq : undefined),
    staleTime: 15_000,
  });
}

export function HistoryDetail({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get('tab') === 'metadata' ? 'metadata' : 'transcript';
  const perms = useSession((s) => s.permissions);
  const qc = useQueryClient();
  const chat = useQuery({
    queryKey: historyKeys.chat(id),
    queryFn: () => api.get<StaffChat>(`/chats/${id}`),
    retry: (n, e) => !(isApiError(e) && (e.status === 404 || e.status === 403)) && n < 2,
  });
  const transcript = useTranscript(id);
  const [exportSource, setExportSource] = useState<ExportSource | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  const messages = useMemo(() => {
    const pages = transcript.data?.pages ?? [];
    const seen = new Set<string>();
    const out: Message[] = [];
    for (const p of [...pages].reverse())
      for (const m of p.items) if (!seen.has(m.id)) (seen.add(m.id), out.push(m));
    return out.sort((a, b) => a.seq - b.seq);
  }, [transcript.data]);

  if (chat.isLoading)
    return (
      <Page>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[480px] w-full" />
      </Page>
    );
  if (chat.isError) {
    const missing = isApiError(chat.error) && (chat.error.status === 404 || chat.error.status === 403);
    return (
      <Page>
        {missing ? (
          <EmptyState
            icon={<MessageSquareOff />}
            title={t('history.detail.notFoundTitle')}
            description={t('history.detail.notFoundBody')}
            action={
              <Button asChild variant="secondary">
                <Link href="/history">{t('history.detail.back')}</Link>
              </Button>
            }
          />
        ) : (
          <PanelError
            message={t('history.detail.loadError', { error: errorMessage(chat.error) })}
            onRetry={() => void chat.refetch()}
          />
        )}
      </Page>
    );
  }
  const c = chat.data!;
  const setTab = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === 'transcript') next.delete('tab');
    else next.set('tab', value);
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  return (
    <Page>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? router.back() : router.push('/history'))}
          className="inline-flex min-h-8 items-center gap-1 self-start text-sm font-medium text-fg-2 hover:text-fg"
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden /> {t('history.page.title')}
        </button>
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{t('history.detail.chatNumber', { number: String(c.number) })}</span>
              <span className="text-base font-normal text-fg-2">
                {t('history.detail.withVisitor', { name: isolate(c.visitor.displayName) })}
              </span>
            </span>
          }
          description={
            <span className="flex flex-wrap items-center gap-2">
              <ChatStatusLabel status={c.status} className="text-sm" />
              {c.closedAt && (
                <span>· {formatDuration(Date.parse(c.closedAt) - Date.parse(c.requestedAt))}</span>
              )}
            </span>
          }
          actions={
            <>
              {perms.has('exports.create') && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setExportSource({
                        kind: 'chats',
                        chatIds: [c.id],
                        label: t('history.detail.exportLabel', {
                          number: String(c.number),
                          name: isolate(c.visitor.displayName),
                        }),
                      })
                    }
                  >
                    <Download className="size-4" aria-hidden /> {t('common.export')}
                  </Button>
                  <Button variant="secondary" onClick={() => setEmailOpen(true)}>
                    <Mail className="size-4" aria-hidden /> {t('history.detail.emailTranscript')}
                  </Button>
                </>
              )}
              {perms.has('visitors.view') && (
                <Button asChild variant="secondary">
                  <Link href={`/visitors/${c.visitorId}`}>
                    <UserRound className="size-4" aria-hidden /> {t('history.detail.visitorProfile')}
                  </Link>
                </Button>
              )}
            </>
          }
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t('history.detail.tabs')}>
          <TabsTrigger value="transcript">{t('history.detail.transcript')}</TabsTrigger>
          <TabsTrigger value="metadata">{t('history.detail.metadata')}</TabsTrigger>
        </TabsList>
        <TabsContent value="transcript" className="pt-4">
          <TranscriptView chat={c} messages={messages} q={transcript} />
        </TabsContent>
        <TabsContent value="metadata" className="pt-4">
          <Metadata
            chat={c}
            messages={messages}
            hasEarlier={!!transcript.hasNextPage}
            loadingEarlier={transcript.isFetchingNextPage}
            loadEarlier={() => void transcript.fetchNextPage()}
            onChat={(next) => qc.setQueryData(historyKeys.chat(id), next)}
          />
        </TabsContent>
      </Tabs>

      <ExportDialog
        open={!!exportSource}
        onOpenChange={(o) => !o && setExportSource(null)}
        source={exportSource}
      />
      {perms.has('exports.create') && (
        <EmailTranscriptDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          chatId={c.id}
          visitorId={c.visitorId}
        />
      )}
    </Page>
  );
}

/**
 * At most this many messages are rendered (PERF02: a 10 000-message transcript). Loading earlier pages pins the window
 * to the oldest loaded message; "Show earlier/newer" slide it through what is already loaded, so the DOM — and the
 * layout work each page causes — stays bounded however far back an agent reads.
 */
const TRANSCRIPT_WINDOW = 600;

/** Index of the first message with seq ≥ `seq` (messages are in seq order). */
function indexFromSeq(messages: Message[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid]!.seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function TranscriptView({
  chat,
  messages,
  q,
}: {
  chat: StaffChat;
  messages: Message[];
  q: ReturnType<typeof useTranscript>;
}) {
  const t = useT();
  const canNotes = useSession((s) => s.permissions.has('notes.view'));
  // Seq of the first rendered message; null follows the newest messages.
  const [firstSeq, setFirstSeq] = useState<number | null>(null);
  if (q.isLoading)
    return (
      <Card className="flex flex-col gap-3 p-5" aria-busy="true">
        {[60, 40, 70, 30].map((w, i) => (
          <Skeleton key={i} className={`h-10 ${i % 2 ? 'w-1/2 self-end' : 'w-2/3'}`} />
        ))}
      </Card>
    );
  if (q.isError)
    return (
      <PanelError
        message={t('history.detail.transcriptError', { error: errorMessage(q.error) })}
        onRetry={() => void q.refetch()}
      />
    );
  const start =
    firstSeq === null
      ? Math.max(0, messages.length - TRANSCRIPT_WINDOW)
      : Math.min(indexFromSeq(messages, firstSeq), Math.max(0, messages.length - 1));
  const end = Math.min(messages.length, start + TRANSCRIPT_WINDOW);
  const shown = messages.slice(start, end);
  const slideTo = (index: number) =>
    setFirstSeq(index + TRANSCRIPT_WINDOW >= messages.length ? null : messages[Math.max(0, index)]!.seq);
  const loadEarlier = async () => {
    const r = await q.fetchNextPage();
    const pages = r.data?.pages ?? [];
    const oldest = pages[pages.length - 1]?.items[0]?.seq;
    if (oldest !== undefined) setFirstSeq(oldest);
  };
  let prev: Message | null = null;
  return (
    <Card>
      <div
        className="flex flex-col px-4 py-5 sm:px-6"
        role="log"
        aria-label={t('history.detail.transcriptOf', { number: String(chat.number) })}
      >
        {start > 0 ? (
          <div className="flex justify-center pb-3">
            <Button size="sm" variant="secondary" onClick={() => slideTo(start - TRANSCRIPT_WINDOW / 2)}>
              {t('history.detail.showEarlier')}
            </Button>
          </div>
        ) : q.hasNextPage ? (
          <div className="flex justify-center pb-3">
            {q.isFetchingNextPage ? (
              <Spinner label={t('history.detail.loadingEarlier')} />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void loadEarlier()}>
                {t('history.detail.loadEarlier')}
              </Button>
            )}
          </div>
        ) : (
          messages.length > 0 && (
            <p className="pb-2 text-center text-xs text-fg-2">{t('history.detail.start')}</p>
          )
        )}
        {!messages.length && (
          <p className="py-8 text-center text-sm text-fg-2">{t('history.detail.noMessages')}</p>
        )}
        {shown.map((m) => {
          const newDay = !prev || !sameDay(prev.sentAt, m.sentAt);
          const grouped =
            !!prev &&
            !newDay &&
            prev.sender.type === m.sender.type &&
            prev.sender.id === m.sender.id &&
            prev.visibility === m.visibility &&
            prev.type !== 'system' &&
            Date.parse(m.sentAt) - Date.parse(prev.sentAt) < 120_000;
          prev = m;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div
                  className="my-4 flex items-center gap-3"
                  role="separator"
                  aria-label={dayLabel(m.sentAt)}
                >
                  <span className="h-px flex-1 bg-line-subtle" />
                  <span className="text-xs font-medium text-fg-2">{dayLabel(m.sentAt)}</span>
                  <span className="h-px flex-1 bg-line-subtle" />
                </div>
              )}
              {m.type === 'system' ? (
                <SystemRow m={m} />
              ) : (
                <MessageBubble m={m} own={false} grouped={grouped} readByVisitor={false} />
              )}
            </Fragment>
          );
        })}
        {end < messages.length && (
          <div className="flex justify-center pt-4">
            <Button size="sm" variant="secondary" onClick={() => slideTo(start + TRANSCRIPT_WINDOW / 2)}>
              {t('history.detail.showNewer')}
            </Button>
          </div>
        )}
        {chat.status === 'closed' && end === messages.length && (
          <div
            className="my-5 flex items-center gap-3"
            role="separator"
            aria-label={t('history.detail.ended')}
          >
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs font-semibold text-fg-2">{t('history.detail.ended')}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
      </div>
      <p className="border-t border-line-subtle px-6 py-2 text-xs text-fg-2">
        {t('history.detail.deviceTime')}{' '}
        {canNotes ? t('history.detail.notesShown') : t('history.detail.notesHidden')}
      </p>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2 text-sm sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-fg-2">{label}</dt>
      <dd className="min-w-0 text-fg break-anywhere">{children}</dd>
    </div>
  );
}

function CopyId({ value }: { value: string }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-xs" dir="ltr">
        {value}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('history.detail.copyId')}
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => toast.success(t('common.copied')))
        }
      >
        <Copy className="size-3.5" />
      </Button>
    </span>
  );
}

const span = (a: string | null, b: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);

function D({ ms }: { ms: number | null }) {
  return ms === null ? null : <span aria-label={formatDurationLong(ms)}>{formatDuration(ms)}</span>;
}

function Metadata({
  chat: c,
  messages,
  hasEarlier,
  loadingEarlier,
  loadEarlier,
  onChat,
}: {
  chat: StaffChat;
  messages: Message[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  onChat: (c: StaffChat) => void;
}) {
  const t = useT();
  const tz = useSession((s) => validTimeZone(s.tenant?.timezone));
  const perms = useSession((s) => s.permissions);
  const agents = byId(useAgents().data);
  const depts = byId(useDepartments().data);
  const sites = byId(useSites().data);
  const name = (id: string | null | undefined) =>
    id ? (agents.get(id)?.displayName ?? t('history.page.formerAgent')) : '';
  const at = (v: string | null) => (v ? formatInZone(v, tz, { second: '2-digit' }) : '');
  const wait = span(c.requestedAt, c.firstAssignedAt);
  const first = span(c.requestedAt, c.firstResponseAt);
  const dur = span(c.requestedAt, c.closedAt);
  const events = messages.filter(
    (m) =>
      m.type === 'system' &&
      ['chat.agent_joined', 'chat.transferred', 'chat.agent_left', 'chat.closed'].includes(
        m.systemEvent?.kind ?? '',
      ),
  );
  const pageHref = safeHref(c.pageUrl);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader title={t('history.detail.identifiers')} />
          <CardBody>
            <dl className="divide-y divide-line-subtle">
              <Row label={t('common.chat')}>#{c.number}</Row>
              <Row label={t('history.detail.chatId')}>
                <CopyId value={c.id} />
              </Row>
              <Row label={t('common.visitor')}>
                <span className="flex flex-col">
                  {perms.has('visitors.view') ? (
                    <Link
                      href={`/visitors/${c.visitorId}`}
                      className="font-medium text-primary hover:underline"
                      dir="auto"
                    >
                      {c.visitor.displayName}
                    </Link>
                  ) : (
                    <span dir="auto">{c.visitor.displayName}</span>
                  )}
                  <CopyId value={c.visitorId} />
                </span>
              </Row>
              <Row label={t('history.page.site')}>
                {sites.get(c.siteId) ? (
                  <span dir="auto">{sites.get(c.siteId)!.name}</span>
                ) : (
                  <CopyId value={c.siteId} />
                )}
              </Row>
              <Row label={t('common.department')}>
                {c.departmentId ? (
                  <span dir="auto">{depts.get(c.departmentId)?.name ?? t('common.department')}</span>
                ) : (
                  t('common.none')
                )}
              </Row>
              <Row label={t('history.detail.startedBy')}>{codeLabel(STARTED_BY, c.startedBy, t)}</Row>
              {c.routeReason && (
                <Row label={t('history.detail.routing')}>{codeLabel(ROUTE_REASON, c.routeReason, t)}</Row>
              )}
              {c.pageUrl && (
                <Row label={t('history.detail.startedOnPage')}>
                  {pageHref ? (
                    <a
                      href={pageHref}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      dir="auto"
                      className="break-all text-primary hover:underline"
                    >
                      {urlLabel(c.pageUrl)}
                    </a>
                  ) : (
                    <span dir="auto">{urlLabel(c.pageUrl)}</span>
                  )}
                </Row>
              )}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={t('history.detail.timing')}
            description={t('history.detail.timingHint', { timezone: tz })}
          />
          <CardBody>
            <dl className="divide-y divide-line-subtle">
              <Row label={t('history.detail.requested')}>{at(c.requestedAt)}</Row>
              <Row label={t('history.detail.firstAssigned')}>{at(c.firstAssignedAt)}</Row>
              <Row label={t('history.detail.firstReply')}>{at(c.firstResponseAt)}</Row>
              <Row label={t('history.detail.closed')}>{at(c.closedAt)}</Row>
              <Row label={t('history.detail.wait')}>
                <D ms={wait} />
              </Row>
              <Row label={t('history.detail.firstResponse')}>
                <D ms={first} />
              </Row>
              <Row label={t('history.page.duration')}>
                {dur === null ? (
                  <span className="text-fg-2">{t('history.page.ongoing')}</span>
                ) : (
                  <D ms={dur} />
                )}
              </Row>
              <Row label={t('history.detail.closeReason')}>
                {c.closeReason ? codeLabel(CLOSE_REASON, c.closeReason, t) : ''}
              </Row>
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('history.detail.ownership')} description={t('history.detail.ownershipHint')} />
          <CardBody className="flex flex-col gap-3">
            <dl className="divide-y divide-line-subtle">
              <Row label={t('history.detail.owner')}>
                <span dir="auto">{name(c.ownerMembershipId)}</span>
              </Row>
              <Row label={t('history.detail.collaborators')}>
                {c.collaboratorIds.length ? (
                  <span dir="auto">{c.collaboratorIds.map(name).join(', ')}</span>
                ) : (
                  ''
                )}
              </Row>
            </dl>
            {events.length ? (
              <ol
                className="flex flex-col gap-1.5 border-s border-line ps-4 text-sm"
                aria-label={t('history.detail.ownershipEvents')}
              >
                {events.map((m) => (
                  <li key={m.id} className="flex flex-wrap justify-between gap-x-3">
                    {/* System event text comes from the server as written. */}
                    <span dir="auto">{m.body}</span>
                    <time dateTime={m.sentAt} className="text-xs text-fg-2">
                      {at(m.sentAt)}
                    </time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-fg-2">{t('history.detail.noEvents')}</p>
            )}
            {hasEarlier && (
              <div>
                <Button size="sm" variant="secondary" loading={loadingEarlier} onClick={loadEarlier}>
                  {t('history.detail.loadEarlierEvents')}
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader title={t('history.detail.rating')} />
          <CardBody className="flex flex-col gap-2">
            {c.rating ? (
              <>
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-semibold ${c.rating.rating === 'good' ? 'text-success' : 'text-danger'}`}
                >
                  {c.rating.rating === 'good' ? (
                    <ThumbsUp className="size-4" aria-hidden />
                  ) : (
                    <ThumbsDown className="size-4" aria-hidden />
                  )}
                  {c.rating.rating === 'good' ? t('history.page.good') : t('history.page.bad')}
                  <span className="font-normal text-fg-2">· {at(c.rating.submittedAt)}</span>
                </span>
                {c.rating.comment ? (
                  <blockquote className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg">
                    {t('history.detail.ratingComment', { comment: isolate(c.rating.comment) })}
                  </blockquote>
                ) : (
                  <p className="text-sm text-fg-2">{t('history.detail.noComment')}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-fg-2">{t('history.detail.notRated')}</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('history.page.tags')} />
          <CardBody>
            <TagEditor
              tags={c.tags}
              canEdit
              label={t('history.detail.chatTags')}
              onSave={async (tagIds) => {
                const next = await api.put<StaffChat>(`/chats/${c.id}/tags`, { tagIds });
                onChat(next);
              }}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('history.detail.other')} />
          <CardBody>
            <dl className="divide-y divide-line-subtle">
              <Row label={t('history.detail.priority')}>
                {formatNumber(c.priority, { useGrouping: false })}
              </Row>
              <Row label={t('history.detail.lastSeq')}>{formatNumber(c.lastSeq, { useGrouping: false })}</Row>
              <Row label={t('common.status')}>
                <ChatStatusLabel status={c.status} />
              </Row>
              {c.visitor.verified && (
                <Row label={t('history.detail.identity')}>
                  <Badge tone="success">{t('history.detail.verifiedVisitor')}</Badge>
                </Row>
              )}
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
