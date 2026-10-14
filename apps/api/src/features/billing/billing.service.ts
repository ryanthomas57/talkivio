import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BillingAccount, Plan, Prisma } from '@prisma/client';
import {
  addPeriod,
  formatUsd,
  isPlanId,
  PAYMENT_GRACE_DAYS,
  periodAmountCents,
  PLAN_CATALOG,
  prorateCents,
  TRIAL_DAYS,
  TRIAL_REMINDER_DAYS,
  unitPriceCents,
  type BillingCycle,
  type PlanId,
} from '@talkivio/contracts';
import { AuditService, type AuditActor } from '../../common/audit.service';
import { decrypt, encrypt, sha256 } from '../../common/crypto';
import { AppError, badRequest, conflict, type AuthContext } from '../../common/http';
import { env } from '../../config/env';
import { MailService } from '../../core/mail.service';
import { TenantDb, type Tx } from '../../db/tenant-db';
import {
  GatewayError,
  PAYMENT_GATEWAY,
  type CardDetails,
  type ChargeResult,
  type PaymentGateway,
} from './gateway';
import type { BillingState } from './states';

/** Version of the Terms of Use and Refund Policy a consent refers to (their "Last updated" date). */
export const TERMS_VERSION = 'terms-2026-10-14';

/** Retries after a failed charge, in hours after each failure; the grace period ends the attempts. */
const RETRY_AFTER_HOURS = [24, 48, 48, 48];
/** How long one worker holds an account while charging it. */
const CLAIM_MS = 2 * 60_000;
/** Back-off when the gateway cannot be reached. */
const UNAVAILABLE_BACKOFF_MS = 15 * 60_000;

const SYSTEM: Omit<AuditActor, 'tenantId'> = {
  userId: null,
  tokenId: null,
  actorName: 'Billing',
  requestId: '',
  ipHash: null,
};

export interface ChangeRequest {
  plan: PlanId;
  cycle: BillingCycle;
  seats: number;
}

export interface Quote {
  kind: 'trial' | 'subscribe' | 'upgrade' | 'scheduled' | 'unchanged';
  plan: PlanId;
  cycle: BillingCycle;
  seats: number;
  unitCents: number;
  /** One full billing period at the new terms. */
  periodCents: number;
  /** Charged now (prorated upgrade, or a restarted subscription), else 0. */
  dueNowCents: number;
  /** When the next full-period charge happens. */
  nextChargeAt: Date | null;
  trialEndsAt: Date | null;
  disclosure: string;
  disclosureHash: string;
}

export interface ConsentInfo {
  ip: string | null;
  userAgent: string | null;
}

const longDate = (d: Date, timeZone: string) =>
  d.toLocaleDateString('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' });
const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
const every = (c: BillingCycle) => (c === 'yearly' ? 'year' : 'month');
const cardLabel = (a: Pick<BillingAccount, 'cardBrand' | 'cardLast4'>) =>
  a.cardLast4 ? `${a.cardBrand ?? 'card'} ending ${a.cardLast4}` : 'card on file';
/**
 * One invoice number per workspace and billing period (period start to the second), so retrying a period reuses its
 * number and a paid period is never charged twice. At most 23 characters (Converge allows 25).
 */
const invoiceFor = (tenantId: string, periodStart: Date, kind: string) =>
  `TK${periodStart.toISOString().slice(2, 19).replace(/[-T:]/g, '')}${kind === 'proration' ? 'P' : ''}${tenantId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Optional() @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway | null,
  ) {}

  /** Billing runs only with a configured gateway; without one every workspace has every feature. */
  get enabled(): boolean {
    return !!this.gateway;
  }

  private requireGateway(): PaymentGateway {
    if (!this.gateway) throw new AppError(404, 'NOT_FOUND', 'Billing is not enabled on this server');
    return this.gateway;
  }

  async account(tenantId: string): Promise<BillingAccount | null> {
    return this.db.read(tenantId, (tx) => tx.billingAccount.findUnique({ where: { tenantId } }));
  }

  /** Agents who can sign in (enabled, not archived): the minimum number of paid agents. */
  async seatsInUse(tx: Tx, tenantId: string): Promise<number> {
    return tx.membership.count({ where: { tenantId, enabled: true, archivedAt: null } });
  }

  // ─────────────────────────────── Quotes and the consent wording ───────────────────────────────

  /** What a change would cost and the automatic-renewal wording the owner agrees to (stored word for word). */
  async quote(tenantId: string, req: ChangeRequest, now = new Date()): Promise<Quote> {
    return this.db.read(tenantId, async (tx) => {
      const a = await tx.billingAccount.findUnique({ where: { tenantId } });
      if (!a) throw new AppError(404, 'NOT_FOUND', 'This workspace has no subscription');
      const tz = (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } }))
        .timezone;
      return this.quoteFor(a, req, now, tz);
    });
  }

  quoteFor(a: BillingAccount, req: ChangeRequest, now: Date, tz: string): Quote {
    const unitCents = unitPriceCents(req.plan, req.cycle);
    const periodCents = periodAmountCents(unitCents, req.cycle, req.seats);
    const plan = PLAN_CATALOG[req.plan].name;
    const amount = formatUsd(periodCents);
    const base = { plan: req.plan, cycle: req.cycle, seats: req.seats, unitCents, periodCents };
    const tail = `Payments are non-refundable and prices exclude applicable taxes. You can cancel at any time in Settings, Billing; cancelling stops future charges.`;
    const make = (q: Omit<Quote, 'disclosureHash'>): Quote => ({
      ...q,
      disclosureHash: sha256(q.disclosure).slice(0, 32),
    });

    if (a.state === 'incomplete' || (a.state === 'trialing' && a.trialEndsAt && a.trialEndsAt > now)) {
      const trialEndsAt =
        a.state === 'trialing' && a.trialEndsAt
          ? a.trialEndsAt
          : new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
      const end = longDate(trialEndsAt, tz);
      return make({
        ...base,
        kind: 'trial',
        dueNowCents: 0,
        nextChargeAt: trialEndsAt,
        trialEndsAt,
        disclosure:
          `${a.state === 'incomplete' ? `Your ${TRIAL_DAYS}-day free trial of the ${plan} plan starts today.` : `Your free trial continues on the ${plan} plan.`} ` +
          `Unless you cancel before ${end}, your card will be charged ${amount} on ${end} for ${agents(req.seats)}, billed ${req.cycle}, ` +
          `and then ${amount} every ${every(req.cycle)} until you cancel. We will email you a reminder ${TRIAL_REMINDER_DAYS} days before the trial ends. ${tail}`,
      });
    }

    if (a.state === 'ended' || a.state === 'suspended' || !a.currentPeriodEnd || !a.currentPeriodStart) {
      // A restart (or paying a paused workspace) charges a full period now.
      return make({
        ...base,
        kind: 'subscribe',
        dueNowCents: periodCents,
        nextChargeAt: addPeriod(now, req.cycle),
        trialEndsAt: null,
        disclosure:
          `Your card will be charged ${amount} today for ${agents(req.seats)} on the ${plan} plan, billed ${req.cycle}, ` +
          `and then ${amount} every ${every(req.cycle)} until you cancel. ${tail}`,
      });
    }

    const current = periodAmountCents(a.unitPriceCents, a.cycle as BillingCycle, a.seats);
    const sameTerms = req.plan === a.plan && req.cycle === a.cycle && req.seats === a.seats;
    if (sameTerms)
      return make({
        ...base,
        kind: 'unchanged',
        dueNowCents: 0,
        nextChargeAt: a.currentPeriodEnd,
        trialEndsAt: null,
        disclosure: '',
      });
    const renewal = longDate(a.currentPeriodEnd, tz);
    // Same cycle and dearer: applies now, the rest of this period prorated. Anything else waits for the renewal.
    if (req.cycle === a.cycle && periodCents > current) {
      const due = prorateCents(periodCents - current, a.currentPeriodStart, a.currentPeriodEnd, now);
      return make({
        ...base,
        kind: 'upgrade',
        dueNowCents: due,
        nextChargeAt: a.currentPeriodEnd,
        trialEndsAt: null,
        disclosure:
          `Your card will be charged ${formatUsd(due)} today for the rest of the current billing period, and then ${amount} on ${renewal} ` +
          `for ${agents(req.seats)} on the ${plan} plan, billed ${req.cycle}, and every ${every(req.cycle)} after that until you cancel. ${tail}`,
      });
    }
    return make({
      ...base,
      kind: 'scheduled',
      dueNowCents: 0,
      nextChargeAt: a.currentPeriodEnd,
      trialEndsAt: null,
      disclosure:
        `Your current plan stays as it is until ${renewal}. From then your card will be charged ${amount} for ${agents(req.seats)} on the ${plan} plan, ` +
        `billed ${req.cycle}, every ${every(req.cycle)} until you cancel. No refund or credit is given for the current period. ${tail}`,
    });
  }

  // ─────────────────────────────── Owner actions ───────────────────────────────

  async cardSession(auth: AuthContext) {
    const email = auth.userId
      ? (await this.db.root.user.findUnique({ where: { id: auth.userId }, select: { email: true } }))?.email
      : null;
    try {
      return await this.requireGateway().cardSession({ tenantId: auth.tenantId, email: email ?? '' });
    } catch (err) {
      throw this.gatewayFailure(err);
    }
  }

  /**
   * Start (or restart) the subscription with a card from the hosted form: the trial for a new workspace, or a paid
   * period straight away after it ended or was paused.
   */
  async subscribe(
    auth: AuthContext,
    input: ChangeRequest & { cardToken: string; disclosureHash: string },
    consent: ConsentInfo,
  ) {
    const gateway = this.requireGateway();
    const card = await this.verify(gateway, input.cardToken);
    const now = new Date();
    const result = await this.db.tx(auth.tenantId, async (tx) => {
      const a = await this.lockAccount(tx, auth.tenantId);
      if (!['incomplete', 'ended', 'suspended'].includes(a.state))
        throw conflict(
          'CONFLICT',
          'This workspace already has a subscription. Change it from Settings, Billing.',
        );
      await this.assertSeats(tx, auth.tenantId, input.seats);
      const tz = (
        await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true } })
      ).timezone;
      const q = this.quoteFor(a, input, now, tz);
      if (q.disclosureHash !== input.disclosureHash)
        throw conflict(
          'CONFLICT',
          'The terms changed while you were reading them. Review them and try again.',
        );
      const cardData = {
        cardTokenCiphertext: encrypt(card.token),
        cardBrand: card.brand,
        cardLast4: card.last4,
        cardExp: card.exp,
      };
      const terms = {
        plan: input.plan as Plan,
        cycle: input.cycle,
        seats: input.seats,
        unitPriceCents: q.unitCents,
        planNext: null,
        cycleNext: null,
        seatsNext: null,
      };
      if (q.kind === 'trial') {
        await tx.billingAccount.update({
          where: { tenantId: auth.tenantId },
          data: {
            ...cardData,
            ...terms,
            state: 'trialing',
            trialEndsAt: q.trialEndsAt,
            trialReminderSentAt: null,
            cancelAtPeriodEnd: false,
            canceledAt: null,
            endedAt: null,
            failedAttempts: 0,
            lastError: null,
          },
        });
      } else {
        // Restart: terms and card saved now, charged straight after this transaction.
        await tx.billingAccount.update({
          where: { tenantId: auth.tenantId },
          data: { ...cardData, ...terms, cancelAtPeriodEnd: false, canceledAt: null },
        });
      }
      await tx.tenant.update({ where: { id: auth.tenantId }, data: { plan: input.plan as Plan } });
      await this.recordConsent(tx, auth, q, consent);
      await this.audit.inTx(tx, auth, {
        action: 'billing.subscribed',
        objectType: 'billing_account',
        objectId: auth.tenantId,
        safeDiff: { plan: input.plan, cycle: input.cycle, seats: input.seats, kind: q.kind },
      });
      return q;
    });
    if (result.kind === 'trial') {
      await this.notify(
        auth.tenantId,
        'trial_started',
        `trial:${result.trialEndsAt?.toISOString()}`,
        (a, tz) => ({
          trialDays: TRIAL_DAYS,
          trialEnd: longDate(a.trialEndsAt!, tz),
          reminderDate: longDate(new Date(a.trialEndsAt!.getTime() - TRIAL_REMINDER_DAYS * 86_400_000), tz),
          termsUrl: `${env().APP_URL}/legal/terms`,
          refundUrl: `${env().APP_URL}/legal/refund-policy`,
        }),
      );
    } else {
      const outcome = await this.chargePeriod(auth.tenantId, 'first', now);
      if (outcome !== 'approved')
        throw new AppError(
          402,
          'PAYMENT_REQUIRED',
          'The card was not charged. Check the details or use another card.',
        );
    }
    return this.summary(auth.tenantId);
  }

  /** Replace the card. A workspace with an unpaid balance is charged straight away. */
  async updateCard(auth: AuthContext, cardToken: string) {
    const card = await this.verify(this.requireGateway(), cardToken);
    const state = await this.db.tx(auth.tenantId, async (tx) => {
      const a = await this.lockAccount(tx, auth.tenantId);
      if (a.state === 'incomplete' || a.state === 'ended')
        throw conflict('CONFLICT', 'Choose a plan to add a card.');
      await tx.billingAccount.update({
        where: { tenantId: auth.tenantId },
        data: {
          cardTokenCiphertext: encrypt(card.token),
          cardBrand: card.brand,
          cardLast4: card.last4,
          cardExp: card.exp,
          lastError: null,
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'billing.card_updated',
        objectType: 'billing_account',
        objectId: auth.tenantId,
        safeDiff: { brand: card.brand },
      });
      return a.state;
    });
    if (state === 'past_due' || state === 'suspended') {
      const outcome = await this.chargePeriod(auth.tenantId, 'retry', new Date(), { force: true });
      if (outcome !== 'approved')
        throw new AppError(
          402,
          'PAYMENT_REQUIRED',
          'The card was saved but the payment did not go through. Try another card.',
        );
    }
    return this.summary(auth.tenantId);
  }

  /** Change plan, cycle or agents: dearer changes apply now (prorated), cheaper ones at the next renewal. */
  async change(auth: AuthContext, input: ChangeRequest & { disclosureHash: string }, consent: ConsentInfo) {
    const gateway = this.requireGateway();
    const now = new Date();
    const plan = await this.db.tx(auth.tenantId, async (tx) => {
      const a = await this.lockAccount(tx, auth.tenantId);
      if (!['trialing', 'active'].includes(a.state))
        throw conflict(
          'CONFLICT',
          a.state === 'past_due'
            ? 'Update your card first: the last payment did not go through.'
            : 'Choose a plan first.',
        );
      await this.assertSeats(tx, auth.tenantId, input.seats);
      const tz = (
        await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true } })
      ).timezone;
      const q = this.quoteFor(a, input, now, tz);
      if (q.kind === 'unchanged') return { q, a };
      if (q.disclosureHash !== input.disclosureHash)
        throw conflict('CONFLICT', 'The price changed while you were reading it. Review it and try again.');
      return { q, a };
    });
    const { q, a } = plan;
    if (q.kind === 'unchanged') return this.summary(auth.tenantId);

    if (q.kind === 'upgrade' && q.dueNowCents > 0) {
      const token = this.cardToken(a);
      const invoice = invoiceFor(auth.tenantId, now, 'proration');
      const r = await gateway.charge({
        token,
        amountCents: q.dueNowCents,
        invoiceNumber: invoice,
        description: `Talkivio ${PLAN_CATALOG[q.plan].name}, change for the rest of the period`,
      });
      await this.recordCharge(auth.tenantId, a, {
        kind: 'proration',
        invoice,
        amountCents: q.dueNowCents,
        result: r,
        terms: q,
        periodStart: now,
        periodEnd: a.currentPeriodEnd,
      });
      if (r.outcome === 'unknown') {
        await this.flagReview(auth.tenantId, r.message);
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'We could not confirm the payment. Nothing was changed; our team will check it and contact you.',
        );
      }
      if (r.outcome !== 'approved')
        throw new AppError(
          402,
          'PAYMENT_REQUIRED',
          r.outcome === 'declined'
            ? `The card was declined (${r.message}). Nothing was changed.`
            : 'The payment service is unavailable. Try again shortly.',
        );
    }

    await this.db.tx(auth.tenantId, async (tx) => {
      const terms = { plan: q.plan as Plan, cycle: q.cycle, seats: q.seats, unitPriceCents: q.unitCents };
      if (q.kind === 'scheduled') {
        await tx.billingAccount.update({
          where: { tenantId: auth.tenantId },
          data: { planNext: q.plan as Plan, cycleNext: q.cycle, seatsNext: q.seats },
        });
      } else {
        await tx.billingAccount.update({
          where: { tenantId: auth.tenantId },
          data: { ...terms, planNext: null, cycleNext: null, seatsNext: null },
        });
        await tx.tenant.update({ where: { id: auth.tenantId }, data: { plan: q.plan as Plan } });
      }
      await this.recordConsent(tx, auth, q, consent);
      await this.audit.inTx(tx, auth, {
        action: 'billing.plan_changed',
        objectType: 'billing_account',
        objectId: auth.tenantId,
        safeDiff: {
          plan: q.plan,
          cycle: q.cycle,
          seats: q.seats,
          kind: q.kind,
          due_now_cents: q.dueNowCents,
        },
      });
    });
    if (q.kind === 'upgrade' && q.dueNowCents > 0)
      await this.sendReceipt(auth.tenantId, invoiceFor(auth.tenantId, now, 'proration'));
    return this.summary(auth.tenantId);
  }

  /** Cancel at the end of the trial or paid period. A workspace with an unpaid balance ends now. */
  async cancel(auth: AuthContext) {
    const now = new Date();
    const r = await this.db.tx(auth.tenantId, async (tx) => {
      const a = await this.lockAccount(tx, auth.tenantId);
      if (a.state === 'ended' || a.state === 'incomplete')
        throw conflict('CONFLICT', 'There is no subscription to cancel.');
      const immediate = a.state === 'past_due' || a.state === 'suspended';
      await tx.billingAccount.update({
        where: { tenantId: auth.tenantId },
        data: immediate
          ? {
              state: 'ended',
              endedAt: now,
              canceledAt: now,
              cancelAtPeriodEnd: false,
              nextAttemptAt: null,
              graceEndsAt: null,
            }
          : { cancelAtPeriodEnd: true, canceledAt: now, planNext: null, cycleNext: null, seatsNext: null },
      });
      await this.audit.inTx(tx, auth, {
        action: 'billing.canceled',
        objectType: 'billing_account',
        objectId: auth.tenantId,
        safeDiff: { state: a.state, immediate },
      });
      return {
        immediate,
        endsAt: immediate ? now : a.state === 'trialing' ? a.trialEndsAt : a.currentPeriodEnd,
      };
    });
    await this.notify(
      auth.tenantId,
      r.immediate ? 'subscription_ended' : 'subscription_canceled',
      `cancel:${now.toISOString()}`,
      (_, tz) => ({ endDate: longDate(r.endsAt ?? now, tz) }),
    );
    return this.summary(auth.tenantId);
  }

  /** Undo a cancellation before the period ends. */
  async resume(auth: AuthContext) {
    await this.db.tx(auth.tenantId, async (tx) => {
      const a = await this.lockAccount(tx, auth.tenantId);
      if (!a.cancelAtPeriodEnd || !['trialing', 'active'].includes(a.state))
        throw conflict('CONFLICT', 'The subscription is not cancelled.');
      await tx.billingAccount.update({
        where: { tenantId: auth.tenantId },
        data: { cancelAtPeriodEnd: false, canceledAt: null },
      });
      await this.audit.inTx(tx, auth, {
        action: 'billing.resumed',
        objectType: 'billing_account',
        objectId: auth.tenantId,
      });
    });
    return this.summary(auth.tenantId);
  }

  async charges(tenantId: string) {
    return this.db.read(tenantId, (tx) =>
      tx.billingCharge.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    );
  }

  /** The account as Settings, Billing shows it. */
  async summary(tenantId: string) {
    if (!this.enabled) return { enabled: false as const };
    return this.db.read(tenantId, async (tx) => {
      const a = await tx.billingAccount.findUnique({ where: { tenantId } });
      if (!a) return { enabled: true as const, exempt: true as const };
      const cycle = a.cycle as BillingCycle;
      const periodCents = periodAmountCents(a.unitPriceCents, cycle, a.seats);
      const nextChargeAt =
        a.cancelAtPeriodEnd || a.state === 'ended' || a.state === 'incomplete'
          ? null
          : a.state === 'trialing'
            ? a.trialEndsAt
            : a.state === 'past_due'
              ? a.nextAttemptAt
              : a.currentPeriodEnd;
      const nextPlan = (a.planNext ?? a.plan) as PlanId;
      const nextCycle = (a.cycleNext ?? a.cycle) as BillingCycle;
      const nextSeats = a.seatsNext ?? a.seats;
      return {
        enabled: true as const,
        exempt: false as const,
        provider: this.gateway!.name,
        state: a.state as BillingState,
        plan: a.plan as PlanId,
        cycle,
        seats: a.seats,
        seatsInUse: await this.seatsInUse(tx, tenantId),
        unitPriceCents: a.unitPriceCents,
        periodCents,
        trialEndsAt: a.trialEndsAt,
        currentPeriodStart: a.currentPeriodStart,
        currentPeriodEnd: a.currentPeriodEnd,
        cancelAtPeriodEnd: a.cancelAtPeriodEnd,
        graceEndsAt: a.graceEndsAt,
        nextChargeAt,
        nextChargeCents: nextChargeAt
          ? periodAmountCents(unitPriceCents(nextPlan, nextCycle), nextCycle, nextSeats)
          : null,
        pending:
          a.planNext || a.cycleNext || a.seatsNext
            ? { plan: nextPlan, cycle: nextCycle, seats: nextSeats }
            : null,
        card: a.cardLast4 ? { brand: a.cardBrand, last4: a.cardLast4, exp: a.cardExp } : null,
        lastError: a.lastError,
        termsVersion: TERMS_VERSION,
      };
    });
  }

  // ─────────────────────────────── The sweep (worker) ───────────────────────────────

  /** Every due account: trial reminders, trial ends, renewals, retries, expired grace periods. */
  async sweep(now = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    const due = await this.db.root.$queryRaw<
      Array<{ tenant_id: string }>
    >`SELECT tenant_id FROM rd_billing_due(${now}, ${TRIAL_REMINDER_DAYS}::int)`;
    for (const { tenant_id } of due) {
      try {
        await this.process(tenant_id, now);
      } catch (err) {
        this.logger.error(`Billing sweep failed for ${tenant_id}: ${(err as Error).message}`);
      }
    }
    return due.length;
  }

  async process(tenantId: string, now = new Date()): Promise<void> {
    const a = await this.claim(tenantId, now);
    if (!a) return;
    let outcome: ChargeResult['outcome'] | null = null;
    try {
      if (a.state === 'trialing' && a.trialEndsAt) {
        if (a.trialEndsAt <= now) {
          if (a.cancelAtPeriodEnd) await this.end(tenantId, a.trialEndsAt);
          else outcome = await this.chargePeriod(tenantId, 'first', now);
        } else if (
          !a.trialReminderSentAt &&
          a.trialEndsAt.getTime() - now.getTime() <= TRIAL_REMINDER_DAYS * 86_400_000
        ) {
          await this.notify(
            tenantId,
            'trial_reminder',
            `reminder:${a.trialEndsAt.toISOString()}`,
            (acc, tz) => ({ trialEnd: longDate(acc.trialEndsAt!, tz) }),
          );
          await this.db.tx(tenantId, (tx) =>
            tx.billingAccount.update({ where: { tenantId }, data: { trialReminderSentAt: now } }),
          );
        }
      } else if (a.state === 'active' && a.currentPeriodEnd && a.currentPeriodEnd <= now) {
        if (a.cancelAtPeriodEnd) await this.end(tenantId, a.currentPeriodEnd);
        else outcome = await this.chargePeriod(tenantId, 'renewal', now);
      } else if (a.state === 'past_due') {
        if (a.graceEndsAt && a.graceEndsAt <= now) await this.suspend(tenantId);
        else if (a.nextAttemptAt && a.nextAttemptAt <= now)
          outcome = await this.chargePeriod(tenantId, 'retry', now);
      }
    } finally {
      // An unreachable gateway leaves its back-off in place; otherwise the account is released for the next sweep.
      if (outcome !== 'unavailable')
        await this.db.tx(tenantId, (tx) =>
          tx.billingAccount.updateMany({
            where: { tenantId, chargingUntil: { not: null } },
            data: { chargingUntil: null },
          }),
        );
    }
  }

  /**
   * Charge the period that is due: the first period after the trial, the next one at renewal, or the unpaid one on a
   * retry. Pending plan, cycle and seat changes apply from this period. Returns the outcome.
   */
  async chargePeriod(
    tenantId: string,
    kind: 'first' | 'renewal' | 'retry',
    now: Date,
    opts: { force?: boolean } = {},
  ): Promise<ChargeResult['outcome']> {
    const gateway = this.requireGateway();
    const a = await this.account(tenantId);
    if (!a) return 'declined';
    // Pending changes take effect when a new period starts.
    const plan = (a.planNext ?? a.plan) as PlanId;
    const cycle = (a.cycleNext ?? a.cycle) as BillingCycle;
    const seats = Math.max(a.seatsNext ?? a.seats, 1);
    const unit = a.planNext || a.cycleNext ? unitPriceCents(plan, cycle) : a.unitPriceCents;
    // The unpaid period begins where the last paid one ended (or the trial ended). A restart, or paying a paused
    // workspace, begins now: the paused days were not served, so they are not charged.
    const restart = a.state === 'ended' || a.state === 'suspended' || a.state === 'incomplete';
    const start = restart ? now : (a.currentPeriodEnd ?? a.trialEndsAt ?? now);
    const end = addPeriod(start, cycle);
    const amount = periodAmountCents(unit, cycle, seats);
    const invoice = invoiceFor(tenantId, start, kind);

    const paid = await this.db.read(tenantId, (tx) =>
      tx.billingCharge.findFirst({ where: { tenantId, invoiceNumber: invoice, status: 'approved' } }),
    );
    let result: ChargeResult;
    if (paid) result = { outcome: 'approved', txnId: paid.providerTxnId, message: 'Already paid' };
    else {
      if (!a.cardTokenCiphertext) result = { outcome: 'declined', txnId: null, message: 'No card on file' };
      else
        result = await gateway.charge({
          token: this.cardToken(a),
          amountCents: amount,
          invoiceNumber: invoice,
          description: `Talkivio ${PLAN_CATALOG[plan].name}, ${agents(seats)}, ${cycle}`,
        });
      await this.recordCharge(tenantId, a, {
        kind,
        invoice,
        amountCents: amount,
        result,
        terms: { plan, cycle, seats },
        periodStart: start,
        periodEnd: end,
      });
    }

    if (result.outcome === 'approved') {
      await this.db.tx(tenantId, async (tx) => {
        await tx.billingAccount.update({
          where: { tenantId },
          data: {
            state: 'active',
            plan: plan as Plan,
            cycle,
            seats,
            unitPriceCents: unit,
            planNext: null,
            cycleNext: null,
            seatsNext: null,
            currentPeriodStart: start,
            currentPeriodEnd: end,
            failedAttempts: 0,
            nextAttemptAt: null,
            graceEndsAt: null,
            lastError: null,
          },
        });
        await tx.tenant.update({ where: { id: tenantId }, data: { plan: plan as Plan } });
        await this.audit.inTx(
          tx,
          { tenantId, ...SYSTEM },
          {
            action: 'billing.charged',
            objectType: 'billing_account',
            objectId: tenantId,
            safeDiff: { kind, invoice, amount_cents: amount },
          },
        );
      });
      if (!paid) await this.sendReceipt(tenantId, invoice);
      return 'approved';
    }
    if (result.outcome === 'unavailable') {
      await this.db.tx(tenantId, (tx) =>
        tx.billingAccount.update({
          where: { tenantId },
          data: {
            chargingUntil: new Date(now.getTime() + UNAVAILABLE_BACKOFF_MS),
            lastError: result.message,
          },
        }),
      );
      return 'unavailable';
    }
    if (result.outcome === 'unknown') {
      await this.flagReview(tenantId, result.message);
      return 'unknown';
    }
    if (restart) {
      // A restart that is declined changes nothing: the owner is told at once and can try another card.
      await this.db.tx(tenantId, (tx) =>
        tx.billingAccount.update({ where: { tenantId }, data: { lastError: result.message.slice(0, 500) } }),
      );
      return 'declined';
    }
    // Declined: past due, retried on a schedule until the grace period ends.
    const attempts = a.state === 'past_due' ? a.failedAttempts + 1 : 1;
    const graceEndsAt =
      a.state === 'past_due' && a.graceEndsAt
        ? a.graceEndsAt
        : new Date(now.getTime() + PAYMENT_GRACE_DAYS * 86_400_000);
    const retryHours = RETRY_AFTER_HOURS[Math.min(attempts - 1, RETRY_AFTER_HOURS.length - 1)]!;
    await this.db.tx(tenantId, async (tx) => {
      await tx.billingAccount.update({
        where: { tenantId },
        data: {
          state: 'past_due',
          failedAttempts: attempts,
          graceEndsAt,
          nextAttemptAt: new Date(now.getTime() + retryHours * 3_600_000),
          lastError: result.message.slice(0, 500),
        },
      });
      await this.audit.inTx(
        tx,
        { tenantId, ...SYSTEM },
        {
          action: 'billing.charge_failed',
          objectType: 'billing_account',
          objectId: tenantId,
          outcome: 'failure',
          safeDiff: { kind, invoice, attempts },
        },
      );
    });
    if (attempts === 1 && !opts.force)
      await this.notify(tenantId, 'payment_failed', `failed:${invoice}`, (_, tz) => ({
        amount: formatUsd(amount),
        reason: result.message,
        graceEnd: longDate(graceEndsAt, tz),
      }));
    return 'declined';
  }

  // ─────────────────────────────── Internals ───────────────────────────────

  private async verify(gateway: PaymentGateway, token: string): Promise<CardDetails> {
    if (typeof token !== 'string' || !token || token.length > 200)
      throw badRequest('Add a card', { card_token: ['Required'] });
    try {
      return await gateway.verifyCard(token);
    } catch (err) {
      throw this.gatewayFailure(err);
    }
  }

  private gatewayFailure(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof GatewayError && err.customerFacing)
      return new AppError(402, 'PAYMENT_REQUIRED', err.message);
    this.logger.error(`Payment gateway error: ${(err as Error).message}`);
    return new AppError(
      503,
      'SERVICE_UNAVAILABLE',
      'The payment service is unavailable. Try again shortly.',
      { retryable: true },
    );
  }

  private cardToken(a: BillingAccount): string {
    if (!a.cardTokenCiphertext) throw new AppError(402, 'PAYMENT_REQUIRED', 'Add a card first.');
    return decrypt(a.cardTokenCiphertext);
  }

  private async lockAccount(tx: Tx, tenantId: string): Promise<BillingAccount> {
    await tx.$queryRaw`SELECT 1 FROM billing_accounts WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const a = await tx.billingAccount.findUnique({ where: { tenantId } });
    if (!a) throw new AppError(404, 'NOT_FOUND', 'This workspace has no subscription');
    return a;
  }

  private async assertSeats(tx: Tx, tenantId: string, seats: number): Promise<void> {
    if (!Number.isInteger(seats) || seats < 1 || seats > 500)
      throw badRequest('Choose between 1 and 500 agents', { seats: ['Between 1 and 500'] });
    const inUse = await this.seatsInUse(tx, tenantId);
    if (seats < inUse)
      throw badRequest(
        `Your workspace has ${agents(inUse)}. Remove agents in Team first, or pay for at least ${inUse}.`,
        { seats: [`At least ${inUse}`] },
      );
  }

  /** Take the account for this worker (or none if another holds it or it is waiting for a review). */
  private async claim(tenantId: string, now: Date): Promise<BillingAccount | null> {
    return this.db.tx(tenantId, async (tx) => {
      const n = await tx.billingAccount.updateMany({
        where: {
          tenantId,
          needsReview: false,
          OR: [{ chargingUntil: null }, { chargingUntil: { lt: now } }],
        },
        data: { chargingUntil: new Date(now.getTime() + CLAIM_MS) },
      });
      return n.count ? tx.billingAccount.findUnique({ where: { tenantId } }) : null;
    });
  }

  private async end(tenantId: string, at: Date): Promise<void> {
    const a = await this.db.tx(tenantId, async (tx) => {
      const acc = await tx.billingAccount.update({
        where: { tenantId },
        data: {
          state: 'ended',
          endedAt: at,
          cancelAtPeriodEnd: false,
          nextAttemptAt: null,
          graceEndsAt: null,
        },
      });
      await this.audit.inTx(
        tx,
        { tenantId, ...SYSTEM },
        { action: 'billing.ended', objectType: 'billing_account', objectId: tenantId },
      );
      return acc;
    });
    await this.notify(tenantId, 'subscription_ended', `ended:${at.toISOString()}`, (_, tz) => ({
      endDate: longDate(a.endedAt ?? at, tz),
    }));
  }

  private async suspend(tenantId: string): Promise<void> {
    const a = await this.db.tx(tenantId, async (tx) => {
      const acc = await tx.billingAccount.update({
        where: { tenantId },
        data: { state: 'suspended', nextAttemptAt: null },
      });
      await this.audit.inTx(
        tx,
        { tenantId, ...SYSTEM },
        {
          action: 'billing.suspended',
          objectType: 'billing_account',
          objectId: tenantId,
          outcome: 'failure',
        },
      );
      return acc;
    });
    const amount = periodAmountCents(a.unitPriceCents, a.cycle as BillingCycle, a.seats);
    await this.notify(
      tenantId,
      'billing_suspended',
      `suspended:${a.graceEndsAt?.toISOString() ?? ''}`,
      () => ({ amount: formatUsd(amount) }),
    );
  }

  private async flagReview(tenantId: string, message: string): Promise<void> {
    this.logger.error(
      `Billing: charge outcome unknown for ${tenantId} (${message}); account held for manual review`,
    );
    await this.db.tx(tenantId, (tx) =>
      tx.billingAccount.update({
        where: { tenantId },
        data: { needsReview: true, lastError: `Payment outcome unknown: ${message}`.slice(0, 500) },
      }),
    );
  }

  private async recordCharge(
    tenantId: string,
    a: BillingAccount,
    c: {
      kind: string;
      invoice: string;
      amountCents: number;
      result: ChargeResult;
      terms: { plan: PlanId; cycle: BillingCycle; seats: number };
      periodStart: Date | null;
      periodEnd: Date | null;
    },
  ): Promise<void> {
    const status =
      c.result.outcome === 'approved' ? 'approved' : c.result.outcome === 'declined' ? 'declined' : 'error';
    await this.db.tx(tenantId, (tx) =>
      tx.billingCharge.create({
        data: {
          tenantId,
          kind: c.kind,
          invoiceNumber: c.invoice,
          amountCents: c.amountCents,
          status,
          plan: c.terms.plan as Plan,
          cycle: c.terms.cycle,
          seats: c.terms.seats,
          periodStart: c.periodStart,
          periodEnd: c.periodEnd,
          provider: this.gateway!.name,
          providerTxnId: 'txnId' in c.result ? c.result.txnId : null,
          cardLast4: a.cardLast4,
          message: c.result.message.slice(0, 500),
        },
      }),
    );
  }

  private async recordConsent(tx: Tx, auth: AuthContext, q: Quote, consent: ConsentInfo): Promise<void> {
    if (!auth.userId || !q.disclosure) return;
    await tx.billingConsent.create({
      data: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        kind: q.kind,
        termsVersion: TERMS_VERSION,
        disclosure: q.disclosure.slice(0, 4000),
        plan: q.plan as Plan,
        cycle: q.cycle,
        seats: q.seats,
        amountCents: q.dueNowCents || q.periodCents,
        trialEndsAt: q.trialEndsAt,
        ipAddress: consent.ip?.slice(0, 64) ?? null,
        userAgent: consent.userAgent?.slice(0, 400) ?? null,
      },
    });
  }

  private async sendReceipt(tenantId: string, invoice: string): Promise<void> {
    const c = await this.db.read(tenantId, (tx) =>
      tx.billingCharge.findFirst({
        where: { tenantId, invoiceNumber: invoice, status: 'approved' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!c) return;
    await this.notify(tenantId, 'payment_receipt', `receipt:${c.id}`, (_, tz) => ({
      invoice: c.invoiceNumber,
      amount: formatUsd(c.amountCents),
      date: longDate(c.createdAt, tz),
      periodStart: c.periodStart ? longDate(c.periodStart, tz) : '',
      periodEnd: c.periodEnd ? longDate(c.periodEnd, tz) : '',
      plan: PLAN_CATALOG[c.plan as PlanId]?.name ?? c.plan,
      seats: c.seats,
      cycle: c.cycle,
      description:
        c.kind === 'proration'
          ? `Plan change for the rest of the billing period, ${PLAN_CATALOG[c.plan as PlanId]?.name ?? c.plan} plan, ${agents(c.seats)}`
          : '',
    }));
  }

  /** Email the workspace owner with the common billing values plus the template's own. */
  private async notify(
    tenantId: string,
    template:
      | 'trial_started'
      | 'trial_reminder'
      | 'payment_receipt'
      | 'payment_failed'
      | 'billing_suspended'
      | 'subscription_canceled'
      | 'subscription_ended',
    dedupe: string,
    extra: (a: BillingAccount, tz: string) => Record<string, unknown>,
  ): Promise<void> {
    try {
      const ctx = await this.db.read(tenantId, async (tx) => ({
        a: await tx.billingAccount.findUniqueOrThrow({ where: { tenantId } }),
        t: await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true, timezone: true, ownerUserId: true },
        }),
      }));
      const owner = await this.db.root.user.findUnique({
        where: { id: ctx.t.ownerUserId },
        select: { email: true },
      });
      if (!owner) return;
      const cycle = ctx.a.cycle as BillingCycle;
      const vars = {
        workspace: ctx.t.name,
        plan: isPlanId(ctx.a.plan) ? PLAN_CATALOG[ctx.a.plan].name : ctx.a.plan,
        cycle,
        seats: ctx.a.seats,
        amount: formatUsd(periodAmountCents(ctx.a.unitPriceCents, cycle, ctx.a.seats)),
        card: cardLabel(ctx.a),
        url: `${env().APP_URL}/settings/billing`,
        ...extra(ctx.a, ctx.t.timezone),
      };
      await this.mail.sendTemplate(template, owner.email, vars, `${tenantId}:${dedupe}`, tenantId);
    } catch (err) {
      this.logger.error(`Billing email ${template} for ${tenantId} failed: ${(err as Error).message}`);
    }
  }
}

export type BillingSummary = Awaited<ReturnType<BillingService['summary']>>;
export type BillingTx = Prisma.TransactionClient;
