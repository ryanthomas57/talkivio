'use client';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { Conversation } from '@/components/inbox/conversation';

export default function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  return (
    <Suspense>
      <Conversation key={chatId} chatId={chatId} />
    </Suspense>
  );
}
