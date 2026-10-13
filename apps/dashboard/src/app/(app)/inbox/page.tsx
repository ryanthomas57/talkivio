'use client';
import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { useInbox } from '@/stores/inbox';
import { useT } from '@/i18n';

export default function InboxIndex() {
  const t = useT();
  const waiting = useInbox((s) => s.lists.queue.length);
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<MessagesSquare />}
        title={t('pages.inbox.selectTitle')}
        description={waiting ? t('pages.inbox.waitingBody', { count: waiting }) : t('pages.inbox.selectBody')}
      />
    </div>
  );
}
