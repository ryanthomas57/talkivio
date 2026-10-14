'use client';
import type { ReactNode } from 'react';
import { ChatDock } from '@/components/dock/chat-dock';
import { InboxSync } from '@/components/inbox/inbox-sync';
import { OfferCenter, OfferSkipLink } from '@/components/inbox/offer-center';
import { NotificationsBell } from '@/components/notifications/bell';
import { AppShell } from '@/components/shell/app-shell';
import { SessionGate } from '@/components/shell/session-gate';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <AppShell
        slots={{
          skip: <OfferSkipLink />,
          topbar: <NotificationsBell />,
          global: (
            <>
              <InboxSync />
              <OfferCenter />
              <ChatDock />
            </>
          ),
        }}
      >
        {children}
      </AppShell>
    </SessionGate>
  );
}
