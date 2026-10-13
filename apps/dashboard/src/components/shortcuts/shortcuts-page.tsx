'use client';
/**
 * Shortcut manager (ch. 18): searchable list with a scope filter limited to what the
 * caller can see, create/edit drawer with server preview, duplicate, archive,
 * CSV import (preview → atomic commit) and CSV export. Search, scope and the open
 * reply live in the URL so back/forward and refresh restore them.
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, MessageSquareText, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Page,
  PageHeader,
  PanelError,
  Select,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { isolate, useT } from '@/i18n';
import { ImportDialog } from './import-dialog';
import { ShortcutDrawer, type DrawerTarget } from './shortcut-drawer';
import { SCOPE_LABELS, sk, useScopeAbilities, useShortcutsRealtime, type ScopeType, type Shortcut } from './shortcuts-api';

export function ShortcutsPage() {
  return (
    <Suspense>
      <Manager />
    </Suspense>
  );
}

function Manager() {
  const t = useT();
  useShortcutsRealtime();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const abilities = useScopeAbilities();
  const canImport = useCan('shortcuts.manage_shared');
  const q = params.get('q') ?? '';
  const scopeParam = params.get('scope');
  const scope = scopeParam && abilities.visible.includes(scopeParam as ScopeType) ? (scopeParam as ScopeType) : 'all';
  const replyParam = params.get('reply');
  const fromParam = params.get('from');
  const [search, setSearch] = useState(q);
  const [importOpen, setImportOpen] = useState(false);
  const [archiving, setArchiving] = useState<Shortcut | null>(null);
  const depts = useDepartments();
  const deptById = useMemo(() => byId(depts.data), [depts.data]);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  // Debounced search → URL.
  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => setParams({ q: search.trim() || null }), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => setSearch(q), [q]);

  const list = useInfiniteQuery({
    queryKey: sk.list(q, scope),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.page<Shortcut>('/shortcuts', { q: q || undefined, scope: scope === 'all' ? undefined : scope, cursor: pageParam ?? undefined, limit: 50 }, signal),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const target: DrawerTarget | null = replyParam === 'new' ? { mode: 'new', from: fromParam } : replyParam ? { mode: 'edit', id: replyParam } : null;
  const openReply = (id: string) => setParams({ reply: id, from: null });
  const duplicate = (id: string) => setParams({ reply: 'new', from: id });
  const closeDrawer = () => setParams({ reply: null, from: null });

  const scopeLabel = (s: Shortcut) => (s.scopeType === 'department' ? t('shortcuts.page.departmentScope', { department: isolate((s.scopeId && deptById.get(s.scopeId)?.name) || t('common.unknown')) }) : t(SCOPE_LABELS[s.scopeType]));
  const canCreate = abilities.manageable.length > 0;
  const filtered = !!q || scope !== 'all';

  return (
    <Page>
      <PageHeader
        title={t('shell.nav.shortcuts')}
        description={t('shortcuts.page.description', { example: '{{visitor.name}}' })}
        actions={
          <>
            <Button asChild variant="secondary">
              <a href={api.url('/shortcuts/export.csv')} download="canned-replies.csv">
                <Download className="size-4" aria-hidden />
                {t('shortcuts.page.exportCsv')}
              </a>
            </Button>
            {canImport && (
              <Button variant="secondary" onClick={() => setImportOpen(true)}>
                <Upload className="size-4" aria-hidden />
                {t('shortcuts.page.importCsv')}
              </Button>
            )}
            {canCreate && (
              <Button variant="primary" onClick={() => setParams({ reply: 'new', from: null })}>
                <Plus className="size-4" aria-hidden />
                {t('shortcuts.page.newReply')}
              </Button>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line-subtle px-4 py-3 sm:px-6">
          <Field label={t('common.search')} hideLabel className="min-w-0 flex-1 basis-60">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2" aria-hidden />
              <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('shortcuts.page.searchPlaceholder')} className="ps-9" aria-label={t('shortcuts.page.searchLabel')} />
            </div>
          </Field>
          <Field label={t('shortcuts.page.scope')} hideLabel className="w-full sm:w-48">
            <Select value={scope} onChange={(e) => setParams({ scope: e.target.value === 'all' ? null : e.target.value })} aria-label={t('shortcuts.page.filterScope')}>
              <option value="all">{t('shortcuts.page.allScopes')}</option>
              {abilities.visible.map((s) => (
                <option key={s} value={s}>
                  {t(SCOPE_LABELS[s])}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {list.isSuccess ? (list.hasNextPage ? t('shortcuts.page.shownMore', { count: items.length }) : t('shortcuts.page.shown', { count: items.length })) : ''}
        </p>
        {list.isPending ? (
          <div className="flex flex-col gap-2 p-4 sm:px-6" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <PanelError message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<MessageSquareText />}
            title={filtered ? t('shortcuts.page.noMatchTitle') : t('shortcuts.page.emptyTitle')}
            description={
              filtered
                ? q
                  ? scope !== 'all'
                    ? t('shortcuts.page.noMatchQueryScope', { query: isolate(q), scope: t(SCOPE_LABELS[scope]) })
                    : t('shortcuts.page.noMatchQuery', { query: isolate(q) })
                  : t('shortcuts.page.noMatchScope', { scope: t(SCOPE_LABELS[scope as ScopeType]) })
                : t('shortcuts.page.emptyBody')
            }
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setParams({ q: null, scope: null });
                  }}
                >
                  {t('shortcuts.page.clearFilters')}
                </Button>
              ) : (
                canCreate && (
                  <Button variant="primary" onClick={() => setParams({ reply: 'new', from: null })}>
                    {t('shortcuts.page.newReply')}
                  </Button>
                )
              )
            }
          />
        ) : (
          <>
            <TableScroll>
              <Table className="min-w-[880px] table-fixed">
                <colgroup>
                  <col className="w-[150px]" />
                  <col className="w-[190px]" />
                  <col />
                  <col className="w-[170px]" />
                  <col className="w-[80px]" />
                  <col className="w-[120px]" />
                  <col className="w-[56px]" />
                </colgroup>
                <THead>
                  <tr>
                    <TH>{t('shortcuts.page.colShortcut')}</TH>
                    <TH>{t('shortcuts.page.colTitle')}</TH>
                    <TH>{t('shortcuts.page.colReply')}</TH>
                    <TH>{t('shortcuts.page.scope')}</TH>
                    <TH className="text-end">{t('shortcuts.page.colUsed')}</TH>
                    <TH>{t('common.updated')}</TH>
                    <TH>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TH>
                  </tr>
                </THead>
                <tbody>
                  {items.map((s) => (
                    <TR key={s.id} selected={replyParam === s.id}>
                      <TD className="py-3">
                        <button type="button" onClick={() => openReply(s.id)} className="max-w-full truncate rounded font-mono text-sm font-medium text-primary underline-offset-4 hover:underline" dir="ltr">
                          /{s.slug}
                        </button>
                        {!s.enabled && (
                          <Badge tone="neutral" className="mt-1">
                            {t('common.disabled')}
                          </Badge>
                        )}
                      </TD>
                      <TD className="py-3">
                        <span className="line-clamp-2 text-sm text-fg" dir="auto">{s.title}</span>
                      </TD>
                      <TD className="py-3">
                        <span className="line-clamp-2 text-sm text-fg-2" dir="auto">{s.body}</span>
                        {s.options.length > 0 && <span className="text-xs text-fg-3">{t('shortcuts.page.optionCount', { count: s.options.length })}</span>}
                      </TD>
                      <TD className="py-3">
                        <Badge tone={s.scopeType === 'personal' ? 'note' : s.scopeType === 'department' ? 'info' : 'primary'}>{scopeLabel(s)}</Badge>
                      </TD>
                      <TD className="text-end tabular">{formatNumber(s.usageCount)}</TD>
                      <TD className="whitespace-nowrap text-sm">
                        <time dateTime={s.updatedAt} title={formatDateTime(s.updatedAt)}>
                          {formatRelative(s.updatedAt)}
                        </time>
                      </TD>
                      <TD className="text-end">
                        <Menu>
                          <MenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={t('shortcuts.page.actionsFor', { slug: isolate(`/${s.slug}`) })}>
                              <MoreHorizontal className="size-4" aria-hidden />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem icon={<Pencil />} onSelect={() => openReply(s.id)}>
                              {s.editable ? t('common.edit') : t('common.view')}
                            </MenuItem>
                            {canCreate && (
                              <MenuItem icon={<Copy />} onSelect={() => duplicate(s.id)}>
                                {t('shortcuts.page.duplicate')}
                              </MenuItem>
                            )}
                            {s.editable && (
                              <>
                                <MenuSeparator />
                                <MenuItem icon={<Trash2 />} danger onSelect={() => setArchiving(s)}>
                                  {t('common.archive')}
                                </MenuItem>
                              </>
                            )}
                          </MenuContent>
                        </Menu>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
            {list.hasNextPage && (
              <div className="flex justify-center border-t border-line-subtle p-3">
                <Button variant="secondary" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {target && (
        <ShortcutDrawer
          key={replyParam === 'new' ? `new:${fromParam ?? ''}` : replyParam!}
          target={target}
          onClose={closeDrawer}
          onCreated={(s) => openReply(s.id)}
          onDuplicate={duplicate}
        />
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}

      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={archiving ? t('shortcuts.archive.title', { slug: isolate(`/${archiving.slug}`) }) : ''}
        description={archiving ? t('shortcuts.archive.bodyNamed', { title: isolate(archiving.title) }) : ''}
        confirmLabel={t('shortcuts.archive.confirm')}
        danger
        onConfirm={async () => {
          if (!archiving) return;
          try {
            await api.post(`/shortcuts/${archiving.id}/archive`, {}, { ifMatch: archiving.version });
          } catch (e) {
            if (isApiError(e, 'VERSION_CONFLICT')) {
              void qc.invalidateQueries({ queryKey: sk.root });
              throw new Error(t('shortcuts.archive.changed'));
            }
            throw e;
          }
          toast.success(t('shortcuts.archive.done', { slug: isolate(`/${archiving.slug}`) }));
          if (replyParam === archiving.id) closeDrawer();
          await qc.invalidateQueries({ queryKey: sk.root });
        }}
      />
    </Page>
  );
}
