'use client';
import { Suspense } from 'react';
import { OfflineList } from '@/components/offline/offline-list';

export default function OfflineMessagesPage() {
  return (
    <Suspense>
      <OfflineList />
    </Suspense>
  );
}
