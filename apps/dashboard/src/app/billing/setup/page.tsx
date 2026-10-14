'use client';
import { BillingSetupPage } from '@/components/billing/setup-page';
import { SessionGate } from '@/components/shell/session-gate';

export default function BillingSetup() {
  return (
    <SessionGate>
      <BillingSetupPage />
    </SessionGate>
  );
}
