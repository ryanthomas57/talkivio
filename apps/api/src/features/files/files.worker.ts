import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { RedisService } from '../../common/redis.service';
import { env } from '../../config/env';
import { QUEUES } from '../../core/queue.service';
import { WorkerService } from '../../worker/worker.service';
import { ScannerUnavailableError, clamdPing } from './clamav';
import { FilesService } from './files.service';

/**
 * Scan pipeline wiring. The BullMQ consumer for the `scans` queue runs only in the
 * worker process; maintenance (`files-sweep`) is registered with the shared worker.
 */
@Injectable()
export class FilesWorker implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('FileScanner');
  private worker: Worker | null = null;

  constructor(
    private readonly files: FilesService,
    private readonly redis: RedisService,
    private readonly workers: WorkerService,
  ) {}

  onModuleInit(): void {
    const e = env();
    if (e.SCAN_MODE === 'dev_unscanned') {
      if (e.NODE_ENV === 'production') throw new Error('SCAN_MODE=dev_unscanned is refused in production. Configure ClamAV (CLAMAV_HOST/CLAMAV_PORT).');
      this.logger.warn(
        '⚠️  SCAN_MODE=dev_unscanned — uploaded files are NOT malware-scanned. They are marked clean after type/magic-byte validation ' +
          "with scan_result='unscanned-dev'. Development only.",
      );
    }
    this.workers.onMaintenance('files-sweep', () => this.files.sweep());
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.TALKIVIO_PROCESS !== 'worker') return;
    const e = env();
    this.worker = new Worker<{ tenantId: string; attachmentId: string }>(QUEUES.scans, (job) => this.files.runScan(job.data.tenantId, job.data.attachmentId), {
      connection: this.redis.create('worker:scans', { forBullMQ: true }),
      prefix: 'rd',
      concurrency: 4,
    });
    this.worker.on('failed', (job, err) => {
      if (err instanceof ScannerUnavailableError || err.name === 'ScannerUnavailableError') {
        this.logger.warn(`Scanner unavailable for attachment ${job?.data.attachmentId} (attempt ${job?.attemptsMade}): ${err.message}; file stays pending`);
      } else {
        this.logger.error(`Scan job failed for attachment ${job?.data.attachmentId}: ${err.message}`);
      }
    });
    this.worker.on('error', (err) => this.logger.error(`Scan worker error: ${err.message}`));
    if (e.SCAN_MODE === 'clamav') {
      const up = await clamdPing(e.CLAMAV_HOST, e.CLAMAV_PORT);
      if (up) this.logger.log(`ClamAV reachable at ${e.CLAMAV_HOST}:${e.CLAMAV_PORT}`);
      else this.logger.warn(`ClamAV not reachable at ${e.CLAMAV_HOST}:${e.CLAMAV_PORT}; uploads will stay pending until it is`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
