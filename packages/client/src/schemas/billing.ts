/** Subscription billing: the account summary, quotes with the renewal wording, card sessions and charges. */
import { z } from 'zod';
import { DateTime, Uuid } from './common.ts';

export const BillingPlanSchema = z.enum(['starter', 'team', 'business']);
export const BillingCycleSchema = z.enum(['monthly', 'yearly']);
export const BillingStateSchema = z.enum([
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'suspended',
  'ended',
]);

/** What every member's dashboard reads: whether billing is on and whether the workspace is usable. */
export const BillingStatusSchema = z.object({
  enabled: z.boolean(),
  state: BillingStateSchema.nullable(),
  plan: z.string().nullable(),
  trialEndsAt: DateTime.nullable(),
});

const CardSchema = z.object({ brand: z.string().nullable(), last4: z.string(), exp: z.string().nullable() });
const TermsSchema = z.object({ plan: BillingPlanSchema, cycle: BillingCycleSchema, seats: z.number().int() });

/** Settings, Billing: { enabled: false } when billing is off, { exempt: true } for a workspace without a subscription. */
export const BillingSummarySchema = z.object({
  enabled: z.boolean(),
  exempt: z.boolean().optional(),
  provider: z.enum(['converge', 'fake']).optional(),
  state: BillingStateSchema.optional(),
  plan: BillingPlanSchema.optional(),
  cycle: BillingCycleSchema.optional(),
  seats: z.number().int().optional(),
  seatsInUse: z.number().int().optional(),
  unitPriceCents: z.number().int().optional(),
  periodCents: z.number().int().optional(),
  trialEndsAt: DateTime.nullable().optional(),
  currentPeriodStart: DateTime.nullable().optional(),
  currentPeriodEnd: DateTime.nullable().optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
  graceEndsAt: DateTime.nullable().optional(),
  nextChargeAt: DateTime.nullable().optional(),
  nextChargeCents: z.number().int().nullable().optional(),
  pending: TermsSchema.nullable().optional(),
  card: CardSchema.nullable().optional(),
  lastError: z.string().nullable().optional(),
  termsVersion: z.string().optional(),
});

export const BillingQuoteSchema = TermsSchema.extend({
  kind: z.enum(['trial', 'subscribe', 'upgrade', 'scheduled', 'unchanged']),
  unitCents: z.number().int(),
  periodCents: z.number().int(),
  dueNowCents: z.number().int(),
  nextChargeAt: DateTime.nullable(),
  trialEndsAt: DateTime.nullable(),
  /** The automatic-renewal wording to show next to the agreement checkbox, word for word. */
  disclosure: z.string(),
  disclosureHash: z.string(),
});

export const BillingCardSessionSchema = z.object({
  provider: z.enum(['converge', 'fake']),
  token: z.string(),
  scriptUrl: z.string().nullable(),
});

export const BillingChargeSchema = z.object({
  id: Uuid,
  kind: z.string(),
  invoiceNumber: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: z.enum(['approved', 'declined', 'error']),
  plan: z.string(),
  cycle: z.string(),
  seats: z.number().int(),
  periodStart: DateTime.nullable(),
  periodEnd: DateTime.nullable(),
  cardLast4: z.string().nullable(),
  createdAt: DateTime,
});

export type BillingStatus = z.infer<typeof BillingStatusSchema>;
export type BillingSummary = z.infer<typeof BillingSummarySchema>;
export type BillingQuote = z.infer<typeof BillingQuoteSchema>;
export type BillingCardSession = z.infer<typeof BillingCardSessionSchema>;
export type BillingCharge = z.infer<typeof BillingChargeSchema>;
