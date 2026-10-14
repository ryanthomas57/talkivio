import { Body, Controller, Get, HttpCode, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { BILLING_CYCLES, PLAN_IDS } from '@talkivio/contracts';
import { z } from 'zod';
import {
  Auth,
  BillingExempt,
  body,
  RecentAuth,
  Require,
  type AppRequest,
  type AuthContext,
} from '../../common/http';
import { BillingService } from './billing.service';

const terms = z.object({
  plan: z.enum(PLAN_IDS),
  cycle: z.enum(BILLING_CYCLES),
  seats: z.coerce.number().int().min(1).max(500),
});
/** The owner's agreement to the exact automatic-renewal wording the quote showed (its hash), not a bare checkbox. */
const agreed = z.object({
  acceptedTerms: z.literal(true, { errorMap: () => ({ message: 'Agree to the terms to continue' }) }),
  disclosureHash: z.string().regex(/^[a-f0-9]{32}$/),
});
const cardToken = z.string().trim().min(4).max(200);
const subscribeSchema = terms.merge(agreed).extend({ cardToken }).strict();
const changeSchema = terms.merge(agreed).strict();
const cardSchema = z.object({ cardToken }).strict();

const consentOf = (req: AppRequest) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

/**
 * Subscription and payment (owner only). Reachable while billing blocks the workspace, since these are how an owner
 * starts the trial, pays a balance or restarts an ended subscription.
 */
@BillingExempt()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** What every member's dashboard needs to know: whether the workspace is usable and why not. */
  @Get('status')
  async status(@Auth() auth: AuthContext) {
    const s = await this.billing.summary(auth.tenantId);
    if (!s.enabled || s.exempt) return { enabled: s.enabled, state: null, plan: null, trialEndsAt: null };
    return { enabled: true, state: s.state, plan: s.plan, trialEndsAt: s.trialEndsAt };
  }

  @Get()
  @Require('billing.manage')
  summary(@Auth() auth: AuthContext) {
    return this.billing.summary(auth.tenantId);
  }

  @Get('charges')
  @Require('billing.manage')
  async charges(@Auth() auth: AuthContext) {
    const rows = await this.billing.charges(auth.tenantId);
    return rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      invoiceNumber: c.invoiceNumber,
      amountCents: c.amountCents,
      currency: c.currency,
      status: c.status,
      plan: c.plan,
      cycle: c.cycle,
      seats: c.seats,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      cardLast4: c.cardLast4,
      createdAt: c.createdAt,
    }));
  }

  /** Price and automatic-renewal wording for a plan, cycle and number of agents. */
  @Get('quote')
  @Require('billing.manage')
  quote(@Auth() auth: AuthContext, @Query(body(terms)) q: z.infer<typeof terms>) {
    return this.billing.quote(auth.tenantId, q);
  }

  /** Session for the gateway's hosted card form (the card number goes from the browser straight to the gateway). */
  @Post('card-session')
  @HttpCode(200)
  @Require('billing.manage')
  cardSession(@Auth() auth: AuthContext) {
    return this.billing.cardSession(auth);
  }

  @Post('subscribe')
  @Require('billing.manage')
  subscribe(
    @Auth() auth: AuthContext,
    @Body(body(subscribeSchema)) input: z.infer<typeof subscribeSchema>,
    @Req() req: AppRequest,
  ) {
    return this.billing.subscribe(auth, input, consentOf(req));
  }

  @Put('card')
  @Require('billing.manage')
  @RecentAuth()
  updateCard(@Auth() auth: AuthContext, @Body(body(cardSchema)) input: z.infer<typeof cardSchema>) {
    return this.billing.updateCard(auth, input.cardToken);
  }

  @Patch('subscription')
  @Require('billing.manage')
  change(
    @Auth() auth: AuthContext,
    @Body(body(changeSchema)) input: z.infer<typeof changeSchema>,
    @Req() req: AppRequest,
  ) {
    return this.billing.change(auth, input, consentOf(req));
  }

  @Post('cancel')
  @HttpCode(200)
  @Require('billing.manage')
  cancel(@Auth() auth: AuthContext) {
    return this.billing.cancel(auth);
  }

  @Post('resume')
  @HttpCode(200)
  @Require('billing.manage')
  resume(@Auth() auth: AuthContext) {
    return this.billing.resume(auth);
  }
}
