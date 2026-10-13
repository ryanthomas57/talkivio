import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { RedisService } from '../../common/redis.service';
import { WorkerService } from '../../worker/worker.service';
import { ExportJobsQueue, ExportsService } from './exports.service';

/** Export/transcript job consumer (worker process only) + `exports-sweep` maintenance. */
@Injectable()
export class ExportsWorker implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ExportWorker');
  private worker: Worker | null = null;

  constructor(
    private readonly exports: ExportsService,
    private readonly redis: RedisService,
    private readonly workers: WorkerService,
  ) {}

  onModuleInit(): void {
    this.workers.onMaintenance('exports-sweep', () => this.exports.sweep());
  }

  onApplicationBootstrap(): void {
    if (process.env.TALKIVIO_PROCESS !== 'worker') return;
    this.worker = new Worker<{ tenantId: string; jobId: string }>(
      ExportJobsQueue.NAME,
      (job) => this.exports.runJob(job.data.tenantId, job.data.jobId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
      { connection: this.redis.create('worker:exports', { forBullMQ: true }), prefix: 'rd', concurrency: 2, lockDuration: 120_000 },
    );
    this.worker.on('failed', (job, err) => this.logger.warn(`Export job ${job?.data.jobId} attempt ${job?.attemptsMade} failed: ${err.message}`));
    this.worker.on('error', (err) => this.logger.error(`Export worker error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
