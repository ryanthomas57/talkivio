import { Injectable, Logger } from '@nestjs/common';
import { hmacSha256 } from '../../common/crypto';
import { AuditService } from '../../common/audit.service';
import { env } from '../../config/env';
import { TenantDb } from '../../db/tenant-db';
import { type ErasureCounts, ErasureService } from './erasure.service';
import { PrivacyObjectStore } from './object-store';

/**
 * Erasure tombstone ledger (ch. 53/75, PRIV02). Pseudonymous subject hashes only
 * (HMAC with the deployment secret; no raw identifiers). Written twice:
 *  - `subject_tombstones` in PostgreSQL (restored together with the database), and
 *  - an append-only ledger object per erasure in object storage
 *    (`exports` area, `privacy-ledger/<tenant>/<request>.json`), which is OUTSIDE the
 *    database backup scope. Operators must exclude this prefix from export expiry
 *    lifecycle rules.
 * After restoring a backup, `scripts/replay-tombstones.mjs` replays every ledger entry
 * before the environment accepts traffic. Replay is idempotent.
 */
export type SubjectHashKind = 'v' | 'i' | 'e';
export interface LedgerEntry {
  version: 1;
  tenantId: string;
  requestId: string;
  erasedAt: string;
  subjects: string[]; // `${kind}:${hex}`
}

export const LEDGER_AREA = 'exports' as const;
export const LEDGER_PREFIX = 'privacy-ledger/';

function secret(): string {
  return `tombstone:${env().APP_SECRET}`;
}
export const visitorHash = (tenantId: string, visitorId: string) =>
  `v:${hmacSha256(secret(), `visitor:${tenantId}:${visitorId}`)}`;
export const identityHash = (tenantId: string, issuerId: string, subjectHash: string) =>
  `i:${hmacSha256(secret(), `identity:${tenantId}:${issuerId}:${subjectHash}`)}`;
export const emailHash = (tenantId: string, emailLookupHash: string) =>
  `e:${hmacSha256(secret(), `email:${tenantId}:${emailLookupHash}`)}`;

export interface ReplayReport {
  dryRun: boolean;
  tenants: number;
  ledgerEntries: number;
  dbTombstones: number;
  visitorsMatched: number;
  visitorsChanged: number;
  offlineSubmissionsErased: number;
  tombstonesRestored: number;
  counts: ErasureCounts;
  failures: string[];
}

@Injectable()
export class TombstoneService {
  private readonly logger = new Logger('Tombstones');
  constructor(
    private readonly db: TenantDb,
    private readonly objects: PrivacyObjectStore,
    private readonly erasure: ErasureService,
    private readonly audit: AuditService,
  ) {}

  /** Hashes for a subject, computed before identifiers are deleted. */
  async subjectHashes(tenantId: string, visitorId: string): Promise<string[]> {
    return this.db.read(tenantId, async (tx) => {
      const v = await tx.visitor.findFirst({
        where: { tenantId, id: visitorId },
        select: { emailLookupHash: true },
      });
      const ids = await tx.visitorIdentity.findMany({
        where: { tenantId, visitorId },
        select: { issuerId: true, subjectHash: true },
      });
      return [
        visitorHash(tenantId, visitorId),
        ...ids.map((i) => identityHash(tenantId, i.issuerId, i.subjectHash)),
        ...(v?.emailLookupHash && v.emailLookupHash !== 'erased'
          ? [emailHash(tenantId, v.emailLookupHash)]
          : []),
      ];
    });
  }

  ledgerKey(tenantId: string, requestId: string): string {
    return `${LEDGER_PREFIX}${tenantId}/${requestId}.json`;
  }

  /** Write the external ledger object (idempotent) and confirm it is readable. */
  async writeLedger(entry: LedgerEntry): Promise<boolean> {
    const key = this.ledgerKey(entry.tenantId, entry.requestId);
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        tenant_id: entry.tenantId,
        request_id: entry.requestId,
        erased_at: entry.erasedAt,
        subjects: entry.subjects,
      }),
    );
    await this.objects.write(LEDGER_AREA, key, body, 'application/json');
    const back = await this.objects.read(LEDGER_AREA, key, 1024 * 1024);
    return !!back && back.equals(body);
  }

  /** Insert DB tombstones that are not present yet (append-only). */
  async writeDbTombstones(entry: LedgerEntry): Promise<number> {
    return this.db.tx(entry.tenantId, async (tx) => {
      const existing = new Set(
        (
          await tx.subjectTombstone.findMany({
            where: { tenantId: entry.tenantId, erasureRequestId: entry.requestId },
            select: { subjectHash: true },
          })
        ).map((t) => t.subjectHash),
      );
      const missing = entry.subjects.filter((h) => !existing.has(h));
      if (missing.length) {
        await tx.subjectTombstone.createMany({
          data: missing.map((subjectHash) => ({
            tenantId: entry.tenantId,
            subjectHash,
            erasureRequestId: entry.requestId,
            erasedAt: new Date(entry.erasedAt),
          })),
        });
      }
      return missing.length;
    });
  }

  async readLedger(tenantFilter?: string): Promise<LedgerEntry[]> {
    const keys = await this.objects.list(
      LEDGER_AREA,
      tenantFilter ? `${LEDGER_PREFIX}${tenantFilter}/` : LEDGER_PREFIX,
    );
    const out: LedgerEntry[] = [];
    for (const key of keys.filter((k) => k.endsWith('.json'))) {
      const raw = await this.objects.read(LEDGER_AREA, key, 1024 * 1024);
      if (!raw) continue;
      try {
        const j = JSON.parse(raw.toString('utf8')) as {
          version: number;
          tenant_id: string;
          request_id: string;
          erased_at: string;
          subjects: string[];
        };
        if (j.version !== 1 || !Array.isArray(j.subjects)) continue;
        out.push({
          version: 1,
          tenantId: j.tenant_id,
          requestId: j.request_id,
          erasedAt: j.erased_at,
          subjects: j.subjects.filter((s) => /^[vie]:[0-9a-f]{64}$/.test(s)),
        });
      } catch {
        this.logger.warn(`Unreadable ledger object ${key}`);
      }
    }
    return out;
  }

  /**
   * Re-apply every recorded erasure: match visitors/identities/offline submissions by
   * pseudonymous hash, re-run the idempotent erasure steps (mode `replay`: no events,
   * no chat commands), and restore missing DB tombstones from the external ledger.
   */
  async replay(
    opts: { tenantId?: string; dryRun?: boolean; source?: 'ledger' | 'db' | 'both' } = {},
  ): Promise<ReplayReport> {
    const source = opts.source ?? 'both';
    const report: ReplayReport = {
      dryRun: !!opts.dryRun,
      tenants: 0,
      ledgerEntries: 0,
      dbTombstones: 0,
      visitorsMatched: 0,
      visitorsChanged: 0,
      offlineSubmissionsErased: 0,
      tombstonesRestored: 0,
      counts: {},
      failures: [],
    };
    const byTenant = new Map<string, { hashes: Set<string>; entries: LedgerEntry[] }>();
    const bucket = (t: string) => {
      let b = byTenant.get(t);
      if (!b) byTenant.set(t, (b = { hashes: new Set(), entries: [] }));
      return b;
    };
    if (source !== 'db') {
      const ledger = await this.readLedger(opts.tenantId);
      report.ledgerEntries = ledger.length;
      for (const e of ledger) {
        bucket(e.tenantId).entries.push(e);
        for (const h of e.subjects) bucket(e.tenantId).hashes.add(h);
      }
    }
    const tenants = opts.tenantId ? [opts.tenantId] : await this.db.activeTenantIds();
    if (source !== 'ledger') {
      for (const tenantId of tenants) {
        const rows = await this.db.read(tenantId, (tx) =>
          tx.subjectTombstone.findMany({ where: { tenantId }, select: { subjectHash: true } }),
        );
        report.dbTombstones += rows.length;
        for (const r of rows) bucket(tenantId).hashes.add(r.subjectHash);
      }
    }
    for (const [tenantId, b] of byTenant) {
      if (!tenants.includes(tenantId)) continue; // tenant no longer exists in this database
      report.tenants += 1;
      const matched = new Set<string>();
      // Visitors (by id hash and email hash for offline submissions) in bounded pages.
      let cursor: string | undefined;
      const emailHits: string[] = [];
      for (;;) {
        const page = await this.db.read(tenantId, (tx) =>
          tx.visitor.findMany({
            where: { tenantId },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 5000,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          }),
        );
        for (const v of page) if (b.hashes.has(visitorHash(tenantId, v.id))) matched.add(v.id);
        if (page.length < 5000) break;
        cursor = page[page.length - 1].id;
      }
      const identities = await this.db.read(tenantId, (tx) =>
        tx.visitorIdentity.findMany({
          where: { tenantId },
          select: { visitorId: true, issuerId: true, subjectHash: true },
        }),
      );
      for (const i of identities)
        if (b.hashes.has(identityHash(tenantId, i.issuerId, i.subjectHash))) matched.add(i.visitorId);
      const offline = await this.db.read(tenantId, (tx) =>
        tx.offlineSubmission.findMany({
          where: { tenantId, status: { not: 'erased' } },
          select: { id: true, emailLookupHash: true },
        }),
      );
      for (const o of offline) if (b.hashes.has(emailHash(tenantId, o.emailLookupHash))) emailHits.push(o.id);
      report.visitorsMatched += matched.size;
      if (opts.dryRun) {
        report.offlineSubmissionsErased += emailHits.length;
        continue;
      }
      for (const visitorId of matched) {
        const scope = await this.erasure.scope(tenantId, visitorId);
        if (!scope) continue;
        const r = await this.erasure.run(scope, { mode: 'replay' });
        const changed = Object.values(r.counts).some((n) => n > 0);
        if (changed) report.visitorsChanged += 1;
        for (const [k, n] of Object.entries(r.counts)) report.counts[k] = (report.counts[k] ?? 0) + n;
        report.failures.push(...r.failures.map((f) => `${tenantId}:${f}`));
      }
      if (emailHits.length) {
        report.offlineSubmissionsErased += await this.db.tx(
          tenantId,
          (tx) => tx.$executeRaw`
          UPDATE offline_submissions SET name = NULL, email_ciphertext = '', email_lookup_hash = 'erased', message = '[erased]',
                 custom_fields = '{}'::jsonb, status = 'erased', version = version + 1
           WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${emailHits}::uuid[]) AND status <> 'erased'`,
        );
      }
      for (const e of b.entries) report.tombstonesRestored += await this.writeDbTombstones(e);
      if (matched.size || emailHits.length) {
        await this.audit.system(tenantId, {
          action: 'privacy.tombstones_replayed',
          objectType: 'tenant',
          objectId: tenantId,
          safeDiff: { visitors_matched: matched.size, offline_matched: emailHits.length },
        });
      }
    }
    return report;
  }
}
