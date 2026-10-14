'use client';
/**
 * Subscription billing in the dashboard: the workspace's billing status (every member), the owner's summary, quotes
 * with the automatic-renewal wording, and card capture through the gateway's hosted form.
 */
import { useQuery } from '@tanstack/react-query';
import type { BillingCycle, PlanId } from '@talkivio/contracts';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';

export type BillingState = 'incomplete' | 'trialing' | 'active' | 'past_due' | 'suspended' | 'ended';

export interface BillingStatus {
  enabled: boolean;
  state: BillingState | null;
  plan: string | null;
  trialEndsAt: string | null;
}

export interface BillingSummary {
  enabled: boolean;
  exempt?: boolean;
  provider?: 'converge' | 'fake';
  state?: BillingState;
  plan?: PlanId;
  cycle?: BillingCycle;
  seats?: number;
  seatsInUse?: number;
  unitPriceCents?: number;
  periodCents?: number;
  trialEndsAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  graceEndsAt?: string | null;
  nextChargeAt?: string | null;
  nextChargeCents?: number | null;
  pending?: { plan: PlanId; cycle: BillingCycle; seats: number } | null;
  card?: { brand: string | null; last4: string; exp: string | null } | null;
  lastError?: string | null;
}

export interface BillingQuote {
  kind: 'trial' | 'subscribe' | 'upgrade' | 'scheduled' | 'unchanged';
  plan: PlanId;
  cycle: BillingCycle;
  seats: number;
  unitCents: number;
  periodCents: number;
  dueNowCents: number;
  nextChargeAt: string | null;
  trialEndsAt: string | null;
  disclosure: string;
  disclosureHash: string;
}

export interface BillingCharge {
  id: string;
  kind: string;
  invoiceNumber: string;
  amountCents: number;
  status: 'approved' | 'declined' | 'error';
  plan: string;
  cycle: string;
  seats: number;
  periodStart: string | null;
  periodEnd: string | null;
  cardLast4: string | null;
  createdAt: string;
}

export const billingKeys = {
  status: ['billing', 'status'] as const,
  summary: ['billing', 'summary'] as const,
  charges: ['billing', 'charges'] as const,
  quote: (plan: string, cycle: string, seats: number) => ['billing', 'quote', plan, cycle, seats] as const,
};

/** States in which the workspace cannot be used until the owner sorts out billing. */
export const BLOCKED_STATES: ReadonlySet<BillingState> = new Set(['incomplete', 'suspended', 'ended']);

export function useBillingStatus() {
  const ready = useSession((s) => s.status === 'ready');
  return useQuery({
    queryKey: billingKeys.status,
    queryFn: () => api.get<BillingStatus>('/billing/status'),
    enabled: ready,
    staleTime: 60_000,
  });
}

export function useBillingSummary(enabled = true) {
  return useQuery({
    queryKey: billingKeys.summary,
    queryFn: () => api.get<BillingSummary>('/billing'),
    enabled,
  });
}

export function useBillingCharges(enabled = true) {
  return useQuery({
    queryKey: billingKeys.charges,
    queryFn: () => api.get<BillingCharge[]>('/billing/charges'),
    enabled,
  });
}

export function useQuote(plan: PlanId, cycle: BillingCycle, seats: number, enabled = true) {
  return useQuery({
    queryKey: billingKeys.quote(plan, cycle, seats),
    queryFn: () => api.get<BillingQuote>('/billing/quote', { plan, cycle, seats: String(seats) }),
    enabled: enabled && seats >= 1,
    staleTime: 30_000,
  });
}

// ─────────────────────────────── Card capture ───────────────────────────────

interface CardSession {
  provider: 'converge' | 'fake';
  token: string;
  scriptUrl: string | null;
}

/** The outcome of the hosted card form: a token for the stored card, or why there is none. */
export type CaptureResult =
  { ok: true; token: string } | { ok: false; reason: 'cancelled' | 'declined' | 'error'; message?: string };

declare global {
  interface Window {
    PayWithConverge?: {
      open: (
        fields: Record<string, string>,
        callbacks: {
          onError?: (e: unknown) => void;
          onCancelled?: () => void;
          onDeclined?: (r: Record<string, string>) => void;
          onApproval?: (r: Record<string, string>) => void;
        },
      ) => void;
    };
  }
}

const loaded = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error('The payment form could not be loaded. Check your connection and try again.'));
      };
      document.head.appendChild(s);
    });
    loaded.set(src, p);
  }
  return p;
}

/**
 * Opens the gateway's card form. With Converge this is the Lightbox: the card number goes from the customer's
 * browser to Converge, and we get back only the stored card's token. The test gateway uses `askTestCard` instead.
 */
export async function captureCard(askTestCard: () => Promise<string | null>): Promise<CaptureResult> {
  const session = await api.post<CardSession>('/billing/card-session', {});
  if (session.provider === 'fake') {
    const number = await askTestCard();
    if (!number) return { ok: false, reason: 'cancelled' };
    const digits = number.replace(/\D/g, '');
    return { ok: true, token: `fake_${digits.slice(-4)}_${Math.random().toString(36).slice(2, 12)}` };
  }
  if (!session.scriptUrl) return { ok: false, reason: 'error' };
  await loadScript(session.scriptUrl);
  const converge = window.PayWithConverge;
  if (!converge) return { ok: false, reason: 'error' };
  return new Promise<CaptureResult>((resolve) => {
    converge.open(
      { ssl_txn_auth_token: session.token },
      {
        onError: () => resolve({ ok: false, reason: 'error' }),
        onCancelled: () => resolve({ ok: false, reason: 'cancelled' }),
        onDeclined: (r) => resolve({ ok: false, reason: 'declined', message: r?.ssl_result_message }),
        onApproval: (r) =>
          r?.ssl_token ? resolve({ ok: true, token: r.ssl_token }) : resolve({ ok: false, reason: 'error' }),
      },
    );
  });
}

/** "$1,234.50" from cents. */
export function usdCents(cents: number | null | undefined): string {
  const c = cents ?? 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: c % 100 === 0 ? 0 : 2,
  }).format(c / 100);
}
