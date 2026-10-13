'use client';
import { useParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { ChatList } from '@/components/inbox/chat-list';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';

/**
 * Inbox workspace (ch. 06/12): 280 px chat list + conversation. Below 900 px the
 * list and the conversation are separate routes with a back action.
 */
export default function InboxLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const params = useParams<{ chatId?: string }>();
  const chatId = params.chatId ?? null;
  return (
    <div className="flex h-full min-h-0">
      <aside aria-label={t('pages.inbox.listRegion')} className={cn('h-full w-full shrink-0 border-r border-line min-[900px]:w-[280px]', chatId ? 'hidden min-[900px]:block' : 'block')}>
        <Suspense>
          <ChatList activeId={chatId} />
        </Suspense>
      </aside>
      <section aria-label={t('pages.inbox.conversationRegion')} className={cn('h-full min-w-0 flex-1 bg-canvas', chatId ? 'block' : 'hidden min-[900px]:block')}>
        {children}
      </section>
    </div>
  );
}
