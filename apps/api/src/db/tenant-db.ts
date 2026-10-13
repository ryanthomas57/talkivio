import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

export interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  timeoutMs?: number;
  /** Retries for serialization failures / deadlocks (ch. 31: at most 3). */
  retries?: number;
}

const RETRYABLE_CODES = new Set(['P2034', '40001', '40P01']);

/** Callbacks that run once the transaction they were registered on has committed (never on rollback/retry). */
const commitHooks = new WeakMap<object, Array<() => void>>();
export function afterCommit(tx: Tx, fn: () => void): void {
  const list = commitHooks.get(tx);
  if (!list) commitHooks.set(tx, [fn]);
  else if (!list.includes(fn)) list.push(fn);
}

export function isRetryableTxError(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code && RETRYABLE_CODES.has(e.code)) return true;
  if (e?.meta?.code && RETRYABLE_CODES.has(e.meta.code)) return true;
  return /deadlock detected|could not serialize access/i.test(e?.message ?? '');
}

/**
 * Database access under row level security. The client connects as the
 * non-owner application role; every tenant operation runs inside a transaction
 * that sets `app.tenant_id` transaction-locally (see docs/adr/0002).
 */
@Injectable()
export class TenantDb implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TenantDb');
  /** Global-scope client (users, sessions, auth tokens, SECURITY DEFINER entry points). */
  readonly root: PrismaClient;

  constructor() {
    this.root = new PrismaClient({
      log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
      // 'minimal' keeps Prisma error messages free of the rendered invocation (argument values).
      errorFormat: 'minimal',
      transactionOptions: { maxWait: 5000, timeout: 15000 },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.root.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.root.$disconnect();
  }

  /** Run `fn` in a transaction bound to `tenantId`. Retries transient serialization/deadlock failures. */
  async tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        const committed: { tx: Tx | null } = { tx: null };
        const result = await this.root.$transaction(
          async (tx) => {
            committed.tx = tx;
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            return fn(tx);
          },
          { isolationLevel: opts.isolationLevel, timeout: opts.timeoutMs ?? 15000 },
        );
        for (const hook of (committed.tx && commitHooks.get(committed.tx)) || []) {
          try {
            hook();
          } catch (e) {
            this.logger.warn(`after-commit hook failed: ${(e as Error).message}`);
          }
        }
        return result;
      } catch (err) {
        if (attempt < retries && isRetryableTxError(err)) {
          const delay = 20 * 2 ** attempt + Math.floor(Math.random() * 25);
          this.logger.warn(`Retrying tenant transaction after ${(err as Error).message?.slice(0, 80)} (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /** Read-only convenience wrapper (same isolation as `tx`). */
  read<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx(tenantId, fn, { retries: 1 });
  }

  /** Iterate active tenants (explicit tenant scope for maintenance jobs). */
  async activeTenantIds(): Promise<string[]> {
    const rows = await this.root.$queryRaw<Array<{ id: string }>>`SELECT id FROM rd_active_tenants()`;
    return rows.map((r) => r.id);
  }
}
