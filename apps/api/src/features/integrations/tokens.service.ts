import { Injectable } from '@nestjs/common';
import type { IntegrationCredential } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import { type AuthContext, badRequest, conflict, denied } from '../../common/http';
import { TOKEN_SCOPE_PERMISSIONS, TOKEN_SCOPES } from '../../common/permissions';
import { TenantDb } from '../../db/tenant-db';
import { integrationsConfig } from './config';

const DAY = 86_400_000;
export const DEFAULT_TOKEN_TTL_MS = 90 * DAY;
export const MAX_TOKEN_TTL_MS = 365 * DAY;

export interface TokenResource {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: 'active' | 'expired' | 'revoked';
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export function tokenResource(c: IntegrationCredential, creatorName: string | null = null): TokenResource {
  const status = c.revokedAt || !c.enabled ? 'revoked' : c.expiresAt < new Date() ? 'expired' : 'active';
  return {
    id: c.id,
    name: c.name,
    prefix: c.prefix,
    scopes: c.scopes,
    status,
    createdBy: c.createdBy,
    createdByName: creatorName,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    lastUsedAt: c.lastUsedAt,
    rotatedAt: c.rotatedAt,
    revokedAt: c.revokedAt,
  };
}

/** `rdt_<8 hex prefix>_<43 char secret>`; only sha256(token) is stored (rd_resolve_api_token). */
function mintToken(): { token: string; prefix: string; hash: string } {
  const prefix = `rdt_${randomBytes(4).toString('hex')}`;
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: sha256(token) };
}

/**
 * Tenant-scoped integration tokens (ch. 55). Secrets are shown once; the auth
 * guard re-resolves the hash on every request, so revocation and rotation take
 * effect immediately (well inside the 60 s requirement).
 */
@Injectable()
export class IntegrationTokensService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, includeRevoked: boolean): Promise<TokenResource[]> {
    const rows = await this.db.read(auth.tenantId, (tx) =>
      tx.integrationCredential.findMany({
        where: { tenantId: auth.tenantId, kind: 'api_token', ...(includeRevoked ? {} : { revokedAt: null }) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
    );
    const names = await this.creatorNames(rows);
    return rows.map((r) => tokenResource(r, r.createdBy ? (names.get(r.createdBy) ?? null) : null));
  }

  private async creatorNames(rows: IntegrationCredential[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
    return new Map((ids.length ? await this.db.root.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : []).map((u) => [u.id, u.displayName]));
  }

  private async withCreator(row: IntegrationCredential): Promise<TokenResource> {
    return tokenResource(row, row.createdBy ? ((await this.creatorNames([row])).get(row.createdBy) ?? null) : null);
  }

  /** Scope catalogue for the token form: what each scope grants and whether the caller may grant it. */
  scopes(auth: AuthContext): Array<{ scope: string; permissions: string[]; grantable: boolean }> {
    return TOKEN_SCOPES.map((scope) => ({ scope, permissions: [...(TOKEN_SCOPE_PERMISSIONS[scope] ?? [])], grantable: this.scopeViolations(auth, [scope]).length === 0 }));
  }

  /** Scopes may never grant a permission the creator lacks. */
  scopeViolations(auth: AuthContext, scopes: string[]): string[] {
    return scopes.filter((s) => (TOKEN_SCOPE_PERMISSIONS[s] ?? []).some((p) => !auth.permissions.has(p)));
  }

  async create(
    auth: AuthContext,
    input: { name: string; scopes: string[]; expiresAt?: string | null },
  ): Promise<{ resource: TokenResource; token: string }> {
    const scopes = [...new Set(input.scopes)].sort();
    const unknown = scopes.filter((s) => !TOKEN_SCOPES.includes(s));
    if (unknown.length)
      throw badRequest('Unknown token scope', { scopes: [`Allowed scopes: ${TOKEN_SCOPES.join(', ')}`] });
    if (!auth.userId) throw denied('Integration tokens are created by a signed-in administrator');
    if (this.scopeViolations(auth, scopes).length)
      throw denied('A token cannot have more access than you do');
    const now = Date.now();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(now + DEFAULT_TOKEN_TTL_MS);
    if (Number.isNaN(expiresAt.getTime()))
      throw badRequest('Invalid expiry', { expires_at: ['Use an RFC 3339 timestamp'] });
    if (expiresAt.getTime() < now + 3600_000)
      throw badRequest('Expiry must be at least one hour away', {
        expires_at: ['Must be at least one hour in the future'],
      });
    if (expiresAt.getTime() > now + MAX_TOKEN_TTL_MS)
      throw badRequest('Expiry is too far away', { expires_at: ['Maximum lifetime is 365 days'] });
    const minted = mintToken();
    const row = await this.db.tx(auth.tenantId, async (tx) => {
      const active = await tx.integrationCredential.count({
        where: { tenantId: auth.tenantId, kind: 'api_token', revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (active >= integrationsConfig().maxActiveTokensPerTenant)
        throw conflict('CONFLICT', 'Too many active integration tokens. Revoke unused tokens first.');
      const created = await tx.integrationCredential.create({
        data: {
          tenantId: auth.tenantId,
          kind: 'api_token',
          name: input.name,
          prefix: minted.prefix,
          secretHash: minted.hash,
          scopes,
          createdBy: auth.userId,
          expiresAt,
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'integration_token.created',
        objectType: 'integration_token',
        objectId: created.id,
        safeDiff: { name: created.name, scopes, expires_at: expiresAt.toISOString(), prefix: minted.prefix },
      });
      return created;
    });
    return { resource: await this.withCreator(row), token: minted.token };
  }

  async revoke(auth: AuthContext, id: string): Promise<boolean> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const row = await tx.integrationCredential.findFirst({
        where: { tenantId: auth.tenantId, id, kind: 'api_token' },
      });
      if (!row) return false;
      if (row.revokedAt) return true; // idempotent
      await tx.integrationCredential.update({
        where: { id },
        data: { revokedAt: new Date(), enabled: false },
      });
      await this.audit.inTx(tx, auth, {
        action: 'integration_token.revoked',
        objectType: 'integration_token',
        objectId: id,
        safeDiff: { name: row.name, prefix: row.prefix },
      });
      return true;
    });
  }

  async rotate(auth: AuthContext, id: string): Promise<{ resource: TokenResource; token: string } | null> {
    const minted = mintToken();
    const row = await this.db.tx(auth.tenantId, async (tx) => {
      const current = await tx.integrationCredential.findFirst({
        where: { tenantId: auth.tenantId, id, kind: 'api_token' },
      });
      if (!current) return null;
      if (current.revokedAt || !current.enabled)
        throw conflict('CONFLICT', 'A revoked token cannot be rotated');
      if (current.expiresAt < new Date())
        throw conflict('TOKEN_EXPIRED', 'An expired token cannot be rotated; create a new one');
      if (this.scopeViolations(auth, current.scopes).length)
        throw denied('A token cannot have more access than you do');
      const updated = await tx.integrationCredential.update({
        where: { id },
        data: { secretHash: minted.hash, prefix: minted.prefix, rotatedAt: new Date() },
      });
      await this.audit.inTx(tx, auth, {
        action: 'integration_token.rotated',
        objectType: 'integration_token',
        objectId: id,
        safeDiff: { name: current.name, previous_prefix: current.prefix, prefix: minted.prefix },
      });
      return updated;
    });
    return row ? { resource: await this.withCreator(row), token: minted.token } : null;
  }
}
