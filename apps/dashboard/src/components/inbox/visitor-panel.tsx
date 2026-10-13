'use client';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, ExternalLink, Globe, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Badge, Banner, Button, Field, MultiCombobox } from '@/components/ui';
import { useNow } from '@/hooks/use-media';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { countryName, formatDateTime, formatDuration, formatRelative } from '@/lib/format';
import { byId, qk, useDepartments, useTags } from '@/lib/queries';
import type { StaffChat, Tag } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';
import { useInbox } from '@/stores/inbox';
import { useCan } from '@/stores/session';

interface PriorChat {
  id: string;
  number: number;
  status: string;
  requestedAt: string;
  closedAt: string | null;
  lastMessagePreview?: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-line-subtle px-5 py-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-2">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <dt className="shrink-0 text-fg-2">{label}</dt>
      <dd className="min-w-0 text-end text-fg break-anywhere">{children}</dd>
    </div>
  );
}

/** Visitor + chat context beside the conversation (inline ≥ 1200 px, drawer below). */
export function VisitorPanel({ chat }: { chat: StaffChat }) {
  const t = useT();
  const now = useNow(5000);
  const departments = byId(useDepartments().data);
  const canViewVisitors = useCan('visitors.view');
  const dept = chat.departmentId ? departments.get(chat.departmentId) : null;
  const firstResponse = chat.firstResponseAt ? Date.parse(chat.firstResponseAt) - Date.parse(chat.requestedAt) : null;
  const prior = useQuery({
    queryKey: ['visitor-chats', chat.visitorId],
    queryFn: () => api.page<PriorChat>(`/visitors/${chat.visitorId}/chats`, { limit: 10 }),
    enabled: canViewVisitors,
    retry: false,
  });

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-line-subtle px-5 py-4">
        <Avatar name={chat.visitor.displayName} color={chat.visitor.avatarColor} size="lg" />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-base font-semibold">
            <bdi>{chat.visitor.displayName}</bdi>
            {chat.visitor.verified && <BadgeCheck className="size-4 shrink-0 text-primary" aria-label={t('inbox.visitor.verified')} />}
          </p>
          <p className="text-sm text-fg-2">
            {chat.visitor.online ? (
              <span className="font-medium text-success">
                <span aria-hidden>● </span>
                {t('inbox.visitor.connected')}
              </span>
            ) : (
              t('inbox.visitor.notConnected')
            )}
            {chat.visitor.countryCode && <span> · {countryName(chat.visitor.countryCode)}</span>}
          </p>
          {!chat.visitor.verified && <p className="text-xs text-fg-2">{t('inbox.visitor.unverified')}</p>}
        </div>
      </div>

      <Section title={t('common.chat')}>
        <dl className="flex flex-col gap-1.5">
          <Row label={t('common.chat')}>#{chat.number}</Row>
          <Row label={t('common.department')}>{dept ? <bdi>{dept.name}</bdi> : t('common.none')}</Row>
          <Row label={t('inbox.visitor.requested')}>
            <time dateTime={chat.requestedAt} title={formatDateTime(chat.requestedAt)}>
              {formatRelative(chat.requestedAt)}
            </time>
          </Row>
          {chat.status === 'queued' || chat.status === 'offered' ? (
            <Row label={t('inbox.visitor.waiting')}>{formatDuration(now - Date.parse(chat.requestedAt))}</Row>
          ) : (
            firstResponse !== null && <Row label={t('inbox.visitor.firstResponse')}>{formatDuration(firstResponse)}</Row>
          )}
          {chat.pageUrl && (
            <Row label={t('inbox.visitor.page')}>
              <a href={chat.pageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                <Globe className="size-3.5" aria-hidden />
                <span className="max-w-[180px] truncate" dir="auto">
                  {chat.pageUrl.replace(/^https?:\/\//, '')}
                </span>
                <ExternalLink className="size-3 rtl:-scale-x-100" aria-hidden />
              </a>
            </Row>
          )}
          {chat.rating && (
            <Row label={t('inbox.visitor.rating')}>
              <span className={`inline-flex items-center gap-1 font-medium ${chat.rating.rating === 'good' ? 'text-success' : 'text-danger'}`}>
                {chat.rating.rating === 'good' ? <ThumbsUp className="size-3.5" aria-hidden /> : <ThumbsDown className="size-3.5" aria-hidden />}
                {chat.rating.rating === 'good' ? t('inbox.visitor.ratingGood') : t('inbox.visitor.ratingBad')}
              </span>
            </Row>
          )}
        </dl>
        {chat.rating?.comment && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg" dir="auto">
            {t('inbox.visitor.ratingComment', { comment: chat.rating.comment })}
          </p>
        )}
      </Section>

      <Section title={t('inbox.visitor.tags')}>
        <ChatTags chat={chat} />
      </Section>

      {canViewVisitors && (
        <Section title={t('inbox.visitor.previousChats')}>
          {prior.isLoading ? (
            <p className="text-sm text-fg-2">{t('common.loading')}</p>
          ) : prior.isError ? (
            <p className="text-sm text-fg-2">{t('inbox.visitor.previousUnavailable')}</p>
          ) : (
            (() => {
              const others = (prior.data?.items ?? []).filter((c) => c.id !== chat.id);
              return others.length ? (
                <ul className="flex flex-col gap-1">
                  {others.map((c) => (
                    <li key={c.id}>
                      <Link href={`/history/${c.id}`} className="flex min-h-10 items-center justify-between gap-2 rounded-md px-2 text-sm hover:bg-surface-2">
                        <span className="font-medium">#{c.number}</span>
                        <span className="text-xs text-fg-2">{formatRelative(c.requestedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-fg-2">{t('inbox.visitor.firstChat')}</p>
              );
            })()
          )}
          <Link href={`/visitors/${chat.visitorId}`} className="text-sm font-medium text-primary hover:underline">
            {t('inbox.visitor.openProfile')}
          </Link>
        </Section>
      )}
    </div>
  );
}

function ChatTags({ chat }: { chat: StaffChat }) {
  const t = useT();
  const tags = useTags();
  const qc = useQueryClient();
  const canCreate = useCan('tags.create');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = chat.tags.map((tag) => tag.id);
  const options = (tags.data ?? []).map((tag) => ({ value: tag.id, label: tag.label, hint: tag.slug }));

  const save = async (ids: string[]) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.put<StaffChat>(`/chats/${chat.id}/tags`, { tagIds: ids });
      if (updated && 'id' in updated) useInbox.getState().upsertChat(updated);
      else void useInbox.getState().loadChat(chat.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const [newLabel, setNewLabel] = useState('');
  const create = async () => {
    const label = newLabel.trim();
    if (!label) return;
    try {
      const created = await api.post<Tag>('/tags', { label });
      setNewLabel('');
      await qc.invalidateQueries({ queryKey: qk.tags });
      await save([...selected, created.id]);
    } catch (e) {
      toast.error(t('inbox.tags.createFailed', { error: errorMessage(e) }));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {chat.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('inbox.tags.onChat')}>
          {chat.tags.map((tag) => (
            <li key={tag.id}>
              <Badge tone="primary">
                <bdi>{tag.label}</bdi>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Field label={t('inbox.tags.edit')} hideLabel>
        <MultiCombobox
          values={selected}
          onChange={(v) => void save(v)}
          options={options}
          placeholder={saving ? t('common.saving') : t('inbox.tags.add')}
          searchPlaceholder={t('inbox.tags.search')}
          emptyText={t('inbox.tags.empty')}
          disabled={saving || chat.status === 'closed'}
        />
      </Field>
      {canCreate && chat.status !== 'closed' && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="sr-only" htmlFor={`newtag-${chat.id}`}>
            {t('inbox.tags.newTag')}
          </label>
          <input id={`newtag-${chat.id}`} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={80} placeholder={t('inbox.tags.newTag')} dir="auto" className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-sm placeholder:text-fg-3" />
          <Button size="sm" type="submit" disabled={!newLabel.trim()}>
            {t('common.create')}
          </Button>
        </form>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
    </div>
  );
}
