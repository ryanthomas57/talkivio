'use client';
import { Suspense } from 'react';
import { IntegrationsView } from '@/components/integrations/integrations-view';

export default function IntegrationsPage() {
  return (
    <Suspense>
      <IntegrationsView />
    </Suspense>
  );
}
