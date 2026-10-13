'use client';
import { Suspense } from 'react';
import { MonitorView } from '@/components/monitor/monitor-view';

export default function MonitorPage() {
  return (
    <Suspense>
      <MonitorView />
    </Suspense>
  );
}
