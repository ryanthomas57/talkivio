import './config/role-worker';
import './config/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PinoNestLogger, rootLogger } from './common/logger';
import { BillingService } from './features/billing/billing.service';
import { WorkerModule } from './modules';

/**
 * One billing sweep, then exit: the same work the worker does every BILLING_SWEEP_SECONDS (trial reminders, trial
 * ends, renewals, retries, suspensions). For operations ("run billing now") and the billing end-to-end test.
 *   node dist/billing-sweep.js
 */
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: new PinoNestLogger() });
  const billing = app.get(BillingService);
  if (!billing.enabled) {
    rootLogger().warn('Billing is off (BILLING_PROVIDER=none): nothing to do');
    return;
  }
  const n = await billing.sweep();
  rootLogger().info(`Billing sweep handled ${n} account${n === 1 ? '' : 's'}`);
}

// Every effect of the sweep (rows, queued emails) is committed when it returns; exit without the long-running
// queue consumers' graceful shutdown, which this one-shot process never needed.
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
