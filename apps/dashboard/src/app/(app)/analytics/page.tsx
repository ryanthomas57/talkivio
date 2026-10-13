'use client';
import { Suspense } from 'react';
import { AnalyticsView } from '@/components/analytics/analytics-view';

export default function AnalyticsPage() {
  return (
    <Suspense>
      <AnalyticsView />
    </Suspense>
  );
}
