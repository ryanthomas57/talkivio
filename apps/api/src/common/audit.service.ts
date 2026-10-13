import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db/tenant-db';
import { TenantDb } from '../db/tenant-db';
import type { AuthContext } from './http';

export interface AuditEntry {
  action: string;
  objectType: string;
  objectId?: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  /** Safe before/after diff: field names and non-personal values only (ch. 54). */
  safeDiff?: Record<string, unknown>;
}

export type AuditActor = Pick<AuthContext, 'tenantId' | 'userId' | 'tokenId' | 'actorName' | 'requestId' | 'ipHash'>;

const REDACT = /pass|token|secret|code|key|email|phone|body|message|comment/i;

function sanitize(diff: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!diff) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(diff)) {
    if (REDACT.test(k)) out[k] = '[changed]';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = sanitize(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** Append-only audit trail (the application role cannot update or delete rows). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  constructor(private readonly db: TenantDb) {}

  private data(actor: AuditActor, e: AuditEntry): Prisma.AuditEventUncheckedCreateInput {
    return {
      tenantId: actor.tenantId,
      actorType: actor.tokenId ? 'integration_token' : actor.userId ? 'user' : 'system',
      actorId: actor.userId ?? actor.tokenId ?? null,
      actorName: actor.actorName,
      action: e.action,
      objectType: e.objectType,
      objectId: e.objectId ?? null,
      outcome: e.outcome ?? 'success',
      safeDiff: sanitize(e.safeDiff) as Prisma.InputJsonValue | undefined,
      requestId: actor.requestId || null,
      ipHash: actor.ipHash,
    };
  }

  /** Record within an existing transaction (preferred: audit commits with the change). */
  async inTx(tx: Tx, actor: AuditActor, e: AuditEntry): Promise<void> {
    await tx.auditEvent.create({ data: this.data(actor, e) });
  }

  async log(actor: AuditActor, e: AuditEntry): Promise<void> {
    try {
      await this.db.tx(actor.tenantId, (tx) => tx.auditEvent.create({ data: this.data(actor, e) }));
    } catch (err) {
      this.logger.error(`Audit write failed (${e.action}): ${(err as Error).message}`);
    }
  }

  system(tenantId: string, e: AuditEntry): Promise<void> {
    return this.log({ tenantId, userId: null, tokenId: null, actorName: 'System', requestId: '', ipHash: null }, e);
  }
}
