'use client';
import { Suspense } from 'react';
import { BansPage } from '@/components/bans/bans-page';
import { Page, Skeleton } from '@/components/ui';

export default function BansRoute() {
  return (
    <Suspense
      fallback={
        <Page>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-64 w-full" />
        </Page>
      }
    >
      <BansPage />
    </Suspense>
  );
}
