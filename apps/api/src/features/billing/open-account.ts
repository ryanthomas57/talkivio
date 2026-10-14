import { unitPriceCents, type BillingCycle, type PlanId } from '@talkivio/contracts';
import type { Tx } from '../../db/tenant-db';
import { billingOn } from './plan-gate';

/**
 * A new workspace's subscription, before any card: with billing on, nothing works until the owner adds a card in
 * the payment step, which starts the free trial. Called inside the transaction that creates the workspace.
 */
export async function openBillingAccount(
  tx: Tx,
  tenantId: string,
  plan: PlanId = 'team',
  cycle: BillingCycle = 'monthly',
): Promise<void> {
  if (!billingOn()) return;
  await tx.billingAccount.create({
    data: {
      tenantId,
      state: 'incomplete',
      plan,
      cycle,
      seats: 1,
      unitPriceCents: unitPriceCents(plan, cycle),
    },
  });
  await tx.tenant.update({ where: { id: tenantId }, data: { plan } });
}
