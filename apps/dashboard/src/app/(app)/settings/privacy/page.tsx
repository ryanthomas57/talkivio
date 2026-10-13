'use client';
import { Suspense } from 'react';
import { PrivacyView } from '@/components/privacy/privacy-view';

export default function PrivacyPage() {
  return (
    <Suspense>
      <PrivacyView />
    </Suspense>
  );
}
