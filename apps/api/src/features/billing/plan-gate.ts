import { Injectable, SetMetadata } from '@nestjs/common';
import {
  isPlanId,
  PLAN_CATALOG,
  planFor,
  type PlanDefinition,
  type PlanFeature as Feature,
} from '@talkivio/contracts';
import { AppError } from '../../common/http';
import { env } from '../../config/env';
import type { Tx } from '../../db/tenant-db';

export const PLAN_FEATURE = 'rd:plan-feature';
/** The route needs a plan that includes this feature (checked by the auth guard; billing off means every feature. Usage: @RequiresPlan('analytics')). */
export const RequiresPlan = (feature: Feature) => SetMetadata(PLAN_FEATURE, feature);

const FEATURE_LABEL: Record<Feature, string> = {
  departments: 'Additional departments',
  triggers: 'Proactive chat triggers',
  analytics: 'Analytics',
  customFields: 'Custom visitor fields and tags',
  monitor: 'The supervisor monitor',
  integrations: 'Webhooks and API tokens',
  verifiedIdentity: 'Verified visitor identity',
  auditLog: 'The audit log and retention rules',
};

export const billingOn = () => env().BILLING_PROVIDER !== 'none';

/** The plan whose limits apply, or null when there are none (billing off, or no subscription on this workspace). */
export function effectivePlan(plan: string | null | undefined): PlanDefinition | null {
  return billingOn() && isPlanId(plan) ? PLAN_CATALOG[plan] : null;
}

export function planLimitError(message: string): AppError {
  return new AppError(402, 'PLAN_LIMIT', `${message} Upgrade in Settings, Billing.`);
}

/** Null when the plan includes the feature, else the refusal. */
export function featureRefusal(plan: PlanDefinition | null, feature: Feature): AppError | null {
  if (!plan || plan.features.includes(feature)) return null;
  return planLimitError(
    `${FEATURE_LABEL[feature]} ${feature === 'departments' || feature === 'triggers' || feature === 'customFields' || feature === 'integrations' ? 'are' : 'is'} available on the ${PLAN_CATALOG[planFor(feature)].name} plan.`,
  );
}

/** Limits that depend on counts or dates, checked where the data is written or read. */
@Injectable()
export class PlanGate {
  async plan(tx: Tx, tenantId: string): Promise<PlanDefinition | null> {
    if (!billingOn()) return null;
    const a = await tx.billingAccount.findUnique({ where: { tenantId }, select: { plan: true } });
    return effectivePlan(a?.plan);
  }

  async assertFeature(tx: Tx, tenantId: string, feature: Feature): Promise<void> {
    const refusal = featureRefusal(await this.plan(tx, tenantId), feature);
    if (refusal) throw refusal;
  }

  /** Before adding a website: the plan's website count. */
  async assertWebsiteSlot(tx: Tx, tenantId: string): Promise<void> {
    const plan = await this.plan(tx, tenantId);
    if (!plan || plan.websites === null) return;
    const used = await tx.site.count({ where: { tenantId, archivedAt: null } });
    if (used >= plan.websites)
      throw planLimitError(
        `The ${plan.name} plan includes ${plan.websites === 1 ? '1 website' : `${plan.websites} websites`}.`,
      );
  }

  /** The oldest chat the plan's history covers, or null for unlimited history. */
  async historySince(tx: Tx, tenantId: string, now = new Date()): Promise<Date | null> {
    const plan = await this.plan(tx, tenantId);
    return plan?.historyDays ? new Date(now.getTime() - plan.historyDays * 86_400_000) : null;
  }
}
