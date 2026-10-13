import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenantDb } from '../db/tenant-db';
import { sha256 } from './crypto';
import { AppError, conflict } from './http';

const TTL_MS = 24 * 3600 * 1000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function validateIdempotencyKey(key: string | undefined | null): string | null {
  if (!key) return null;
  if (key.length < 16 || key.length > 128 || !/^[\w-]+$/.test(key)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Idempotency-Key must be 16–128 URL-safe characters', { fieldErrors: { idempotency_key: ['Invalid key'] } });
  }
  return key;
}

/**
 * Command idempotency (ch. 40): the same key and payload replays the original
 * response for 24 h; the same key with a different payload is a 409.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: TenantDb) {}

  async run<T>(
    tenantId: string,
    actorScope: string,
    routeKey: string,
    key: string | null,
    request: unknown,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    if (!key) return { ...(await fn()), replayed: false };
    const keyHash = sha256(key);
    const requestHash = sha256(canonical(request));
    const where = { tenantId_actorScope_routeKey_keyHash: { tenantId, actorScope, routeKey, keyHash } };
    // Claim the key with INSERT … ON CONFLICT DO NOTHING so two concurrent identical
    // requests never both run the command: the loser observes the winner's row.
    const claim = () =>
      this.db.tx(tenantId, async (tx) => {
        const row = await tx.commandIdempotency.findUnique({ where });
        if (row && row.expiresAt < new Date()) await tx.commandIdempotency.delete({ where: { id: row.id } });
        else if (row) return row;
        const { count } = await tx.commandIdempotency.createMany({
          data: [{ tenantId, actorScope, routeKey, keyHash, requestHash, state: 'processing', expiresAt: new Date(Date.now() + TTL_MS) }],
          skipDuplicates: true,
        });
        return count === 1 ? null : tx.commandIdempotency.findUnique({ where });
      });
    let existing = await claim();
    // A concurrent duplicate is still running: wait briefly for its committed response.
    for (let i = 0; existing && existing.state !== 'complete' && existing.requestHash === requestHash && i < 25; i++) {
      await new Promise((r) => setTimeout(r, 120));
      existing = await this.db.read(tenantId, (tx) => tx.commandIdempotency.findUnique({ where }));
      if (!existing) existing = await claim();
    }
    if (existing) {
      if (existing.requestHash !== requestHash) throw conflict('IDEMPOTENCY_MISMATCH', 'This idempotency key was used with a different request');
      if (existing.state !== 'complete') throw conflict('IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed', true);
      return { status: existing.responseStatus ?? 200, body: existing.responseBody as T, replayed: true };
    }
    try {
      const result = await fn();
      await this.db.tx(tenantId, (tx) =>
        tx.commandIdempotency.update({
          where: { tenantId_actorScope_routeKey_keyHash: { tenantId, actorScope, routeKey, keyHash } },
          data: { state: 'complete', responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue },
        }),
      );
      return { ...result, replayed: false };
    } catch (err) {
      await this.db
        .tx(tenantId, (tx) => tx.commandIdempotency.deleteMany({ where: { tenantId, actorScope, routeKey, keyHash, state: 'processing' } }))
        .catch(() => undefined);
      throw err;
    }
  }
}
