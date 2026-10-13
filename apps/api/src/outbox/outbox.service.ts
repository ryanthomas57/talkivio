import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { afterCommit, type Tx } from '../db/tenant-db';
import { toWire } from '../common/wire';
import { activeTraceparent } from '../common/tracing';

/**
 * Scope kinds (ADR 0003). `audience` decides which socket room family receives
 * the frame: staff rooms (agents with permission), public rooms (the visitor's
 * own projection) or internal (no socket delivery; consumed by workers).
 */
export type ScopeKind = 'chat' | 'queue' | 'visitor' | 'config' | 'agent' | 'team' | 'tenant';
export type Audience = 'staff' | 'public' | 'internal';

export interface OutboxScope {
  kind: ScopeKind;
  id: string;
  audience: Audience;
  /** Optional per-scope projection (e.g. public payload without internal fields). */
  payload?: unknown;
}

export interface OutboxInput {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payload: unknown;
  scopes: OutboxScope[];
  causationId?: string | null;
  schemaVersion?: number;
  /**
   * Deterministic event id for "at most once per fact" events (e.g. one
   * `chat.queued` per chat version). A repeat append with the same id is a no-op.
   */
  eventId?: string;
}

/** RFC 4122-shaped (version 5 style) UUID derived from a stable name. */
export function deterministicEventId(name: string): string {
  const h = createHash('sha256').update(`talkivio:event:${name}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Room naming shared by publisher, gateway subscriptions and replay. */
export function roomFor(tenantId: string, kind: ScopeKind, id: string, audience: Audience): string {
  return `${audience === 'public' ? 'p' : 's'}:${tenantId}:${kind}:${id}`;
}

export function encodeEventCursor(seq: bigint | number): string {
  return `c1.${BigInt(seq).toString(36)}`;
}

export function decodeEventCursor(cursor: string | null | undefined): bigint | null {
  if (!cursor || !cursor.startsWith('c1.')) return null;
  try {
    return BigInt(parseInt(cursor.slice(3), 36));
  } catch {
    return null;
  }
}

/** Redis pub/sub channel that wakes the outbox publisher right after a commit (polling stays as the fallback). */
export const OUTBOX_NUDGE_CHANNEL = 'rd:outbox:nudge';
let nudger: (() => void) | null = null;
let nudgeQueued = false;
/** Wired once per process (RedisService) so committed outbox rows are published without waiting for the next poll. */
export function setOutboxNudger(fn: (() => void) | null): void {
  nudger = fn;
}
function nudgeAfterCommit(): void {
  if (!nudger || nudgeQueued) return;
  nudgeQueued = true;
  // One publish per tick, however many transactions committed in it.
  setImmediate(() => {
    nudgeQueued = false;
    nudger?.();
  });
}

/** Every domain event is appended inside the command transaction (ch. 03). */
@Injectable()
export class OutboxService {
  async append(tx: Tx, tenantId: string, input: OutboxInput): Promise<string> {
    const eventId = input.eventId ?? randomUUID();
    const scopes: OutboxScope[] = [...input.scopes, { kind: 'tenant', id: tenantId, audience: 'internal' }];
    const traceParent = activeTraceparent();
    await tx.outboxEvent.createMany({
      skipDuplicates: !!input.eventId,
      data: scopes.map((s) => ({
        eventId,
        tenantId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        aggregateVersion: input.aggregateVersion,
        eventType: input.eventType,
        schemaVersion: input.schemaVersion ?? 1,
        scopeKind: s.kind,
        scopeId: s.id,
        audience: s.audience,
        payload: toWire(s.payload ?? input.payload) as Prisma.InputJsonValue,
        causationId: input.causationId ?? null,
        traceParent,
      })),
    });
    afterCommit(tx, nudgeAfterCommit);
    return eventId;
  }
}
