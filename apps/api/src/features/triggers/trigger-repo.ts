import { Logger } from '@nestjs/common';
import { validateDslDefinition, type DslEvent, type DslTriggerSpec, type DslValidationContext } from '@talkivio/contracts';
import type { Tx } from '../../db/tenant-db';

const logger = new Logger('TriggerRepo');

export interface PublishedTrigger extends DslTriggerSpec {
  name: string;
}

/**
 * Enabled, published revisions for one event — the exact input of the shared
 * interpreter for both the production engine and the simulator.
 */
export async function loadPublishedTriggers(tx: Tx, tenantId: string, event: DslEvent, excludeId?: string): Promise<PublishedTrigger[]> {
  const rows = await tx.trigger.findMany({
    where: { tenantId, eventType: event, enabled: true, archivedAt: null, publishedRevision: { not: null }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  if (!rows.length) return [];
  const revs = await tx.triggerRevision.findMany({
    where: { tenantId, OR: rows.map((t) => ({ triggerId: t.id, revision: t.publishedRevision! })) },
  });
  const byKey = new Map(revs.map((r) => [`${r.triggerId}:${r.revision}`, r]));
  const out: PublishedTrigger[] = [];
  for (const t of rows) {
    const rev = byKey.get(`${t.id}:${t.publishedRevision}`);
    if (!rev) continue;
    // Re-check the stored grammar (defence in depth); a corrupt revision never runs.
    const v = validateDslDefinition(rev.definition);
    if (!v.ok || v.definition.event !== event) {
      logger.warn(`Skipping trigger ${t.id} r${rev.revision}: stored definition no longer valid`);
      continue;
    }
    out.push({ id: t.id, name: t.name, revision: rev.revision, createdAt: t.createdAt.getTime(), definition: v.definition });
  }
  return out;
}

function customType(dataType: string): 'string' | 'number' | 'boolean' {
  const t = dataType.toLowerCase();
  if (t === 'number' || t === 'integer' || t === 'decimal') return 'number';
  if (t === 'boolean' || t === 'bool' || t === 'checkbox') return 'boolean';
  return 'string';
}

/** Tenant reference data used to reject cross-tenant ids and untrusted fields on save/publish. */
export async function validationContext(tx: Tx, tenantId: string): Promise<DslValidationContext> {
  const [departments, sites, fields] = await Promise.all([
    tx.department.findMany({ where: { tenantId, archivedAt: null }, select: { id: true } }),
    tx.site.findMany({ where: { tenantId, archivedAt: null }, select: { id: true } }),
    tx.customFieldDefinition.findMany({ where: { tenantId, archivedAt: null }, select: { key: true, dataType: true, publicWritable: true } }),
  ]);
  return {
    departmentIds: departments.map((d) => d.id),
    siteIds: sites.map((s) => s.id),
    customFields: Object.fromEntries(fields.map((f) => [f.key, { type: customType(f.dataType), trusted: !f.publicWritable }])),
  };
}
