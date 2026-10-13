'use client';
import { Suspense } from 'react';
import { AuditLog } from '@/components/audit/audit-log';

export default function AuditPage() {
  return (
    <Suspense>
      <AuditLog />
    </Suspense>
  );
}
