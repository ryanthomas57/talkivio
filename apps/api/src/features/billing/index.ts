/**
 * Feature module registration for "billing". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 */
import type { Provider, Type } from '@nestjs/common';
import { env } from '../../config/env';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingWorker } from './billing.worker';
import { ConvergeGateway } from './converge.gateway';
import { FakeGateway } from './fake.gateway';
import { PAYMENT_GATEWAY } from './gateway';
import { PlanGate } from './plan-gate';

/** The configured gateway, or null when billing is off (BILLING_PROVIDER=none). */
const gatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  useFactory: () => {
    const e = env();
    if (e.BILLING_PROVIDER === 'converge') return new ConvergeGateway(e);
    if (e.BILLING_PROVIDER === 'fake') return new FakeGateway();
    return null;
  },
};

export const BILLING_PROVIDERS: Provider[] = [gatewayProvider, BillingService, BillingWorker, PlanGate];
export const BILLING_CONTROLLERS: Type<unknown>[] = [BillingController];
