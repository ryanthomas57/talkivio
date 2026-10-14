import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { env } from '../../config/env';
import { WorkerService } from '../../worker/worker.service';
import { BillingService } from './billing.service';

/**
 * Runs the billing sweep from the worker's maintenance queue every BILLING_SWEEP_SECONDS (once per tick across the
 * cluster): trial reminders, trial ends, renewals, retries and suspensions.
 */
@Injectable()
export class BillingWorker implements OnModuleInit {
  private readonly logger = new Logger('BillingSweep');

  constructor(
    private readonly worker: WorkerService,
    private readonly billing: BillingService,
  ) {}

  onModuleInit(): void {
    if (!this.billing.enabled) return;
    this.worker.onMaintenance(
      'billing-sweep',
      async () => {
        const n = await this.billing.sweep();
        if (n) this.logger.log(`Billing sweep handled ${n} account${n === 1 ? '' : 's'}`);
      },
      env().BILLING_SWEEP_SECONDS * 1000,
    );
  }
}
