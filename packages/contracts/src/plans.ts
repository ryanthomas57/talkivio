/**
 * Plans, prices and what each plan includes. The one source for the API (charges, limits), the dashboard (Billing)
 * and the public website (pricing). Prices are US cents per agent per month.
 */
export const PLAN_IDS = ['starter', 'team', 'business'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const TRIAL_DAYS = 14;
/** Days before a trial ends that the reminder goes out (card network rules ask for at least 7). */
export const TRIAL_REMINDER_DAYS = 7;
/** Days a workspace keeps working after a renewal charge fails, while the charge is retried. */
export const PAYMENT_GRACE_DAYS = 7;

/** Capabilities that depend on the plan. */
export const PLAN_FEATURES = [
  'departments',
  'triggers',
  'analytics',
  'customFields',
  'monitor',
  'integrations',
  'verifiedIdentity',
  'auditLog',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Per agent per month, billed monthly. */
  monthlyCents: number;
  /** Per agent per month, billed yearly (charged as 12 months at once). */
  yearlyCents: number;
  /** Websites with the widget installed; null is unlimited. */
  websites: number | null;
  /** How far back chat history can be viewed; null is unlimited. */
  historyDays: number | null;
  features: readonly PlanFeature[];
}

export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyCents: 1500,
    yearlyCents: 1200,
    websites: 1,
    historyDays: 60,
    features: [],
  },
  team: {
    id: 'team',
    name: 'Team',
    monthlyCents: 2900,
    yearlyCents: 2400,
    websites: 5,
    historyDays: null,
    features: ['departments', 'triggers', 'analytics', 'customFields'],
  },
  business: {
    id: 'business',
    name: 'Business',
    monthlyCents: 4900,
    yearlyCents: 4100,
    websites: null,
    historyDays: null,
    features: [
      'departments',
      'triggers',
      'analytics',
      'customFields',
      'monitor',
      'integrations',
      'verifiedIdentity',
      'auditLog',
    ],
  },
};

/** The lowest plan that includes a feature (for "Available on Team" messages). */
export function planFor(feature: PlanFeature): PlanId {
  return PLAN_IDS.find((p) => PLAN_CATALOG[p].features.includes(feature)) ?? 'business';
}

export const isPlanId = (v: unknown): v is PlanId =>
  typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);
export const isBillingCycle = (v: unknown): v is BillingCycle =>
  typeof v === 'string' && (BILLING_CYCLES as readonly string[]).includes(v);

/** Per-agent monthly price for a plan and cycle, in cents. */
export function unitPriceCents(plan: PlanId, cycle: BillingCycle): number {
  const p = PLAN_CATALOG[plan];
  return cycle === 'yearly' ? p.yearlyCents : p.monthlyCents;
}

/** Amount charged for one full billing period: agents × monthly price × (1 or 12 months). */
export function periodAmountCents(unitCents: number, cycle: BillingCycle, seats: number): number {
  return unitCents * seats * (cycle === 'yearly' ? 12 : 1);
}

/** The end of a billing period that starts at `start` (calendar month or year, clamped to the month's last day). */
export function addPeriod(start: Date, cycle: BillingCycle): Date {
  const d = new Date(start.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (cycle === 'yearly' ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * The part of a full-period amount for the time left in the period, rounded up to the cent: what adding agents
 * or upgrading costs mid-period.
 */
export function prorateCents(fullCents: number, periodStart: Date, periodEnd: Date, now: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  const left = Math.min(total, Math.max(0, periodEnd.getTime() - now.getTime()));
  if (total <= 0 || fullCents <= 0) return 0;
  return Math.ceil((fullCents * left) / total);
}

/** "$1,234.50" from cents. */
export function formatUsd(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}
