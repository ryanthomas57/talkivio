/**
 * Subscription states.
 *   incomplete  signed up, no card yet: nothing works until one is added (the trial starts then)
 *   trialing    card on file, free trial running
 *   active      paid for the current period
 *   past_due    a charge failed; retried during the grace period while everything keeps working
 *   suspended   the grace period ran out unpaid: paused until the card is updated and the balance paid
 *   ended       cancelled (or the trial was cancelled) and the paid time is over
 * A workspace with no billing account (billing off, or created before billing) is never blocked.
 */
export const BILLING_STATES = ['incomplete', 'trialing', 'active', 'past_due', 'suspended', 'ended'] as const;
export type BillingState = (typeof BILLING_STATES)[number];

const BLOCKED: Record<string, string> = {
  incomplete: 'Add a payment method to start your free trial.',
  suspended:
    'This workspace is paused because a payment did not go through. The owner can update the card in Settings, Billing.',
  ended: 'This workspace’s subscription has ended. The owner can choose a plan in Settings, Billing.',
};

/** Why a workspace in this state cannot be used, or null when it can. */
export function billingBlockMessage(state: string | null | undefined): string | null {
  return (state && BLOCKED[state]) || null;
}
