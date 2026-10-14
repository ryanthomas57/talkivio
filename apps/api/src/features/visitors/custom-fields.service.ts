import { lockForUpdate } from '../../db/row-lock';
import { Injectable } from '@nestjs/common';
import type { CustomFieldDefinition, Prisma } from '@prisma/client';
import { z } from 'zod';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { AppError, badRequest, conflict, notFound, zodError, type AuthContext } from '../../common/http';
import { EMAIL_RE, staleVersion } from './visitor-common';

/**
 * Custom field definitions (ch. 17/37/43): typed, bounded, never executable.
 * Values live flat in `visitors.custom_fields` as scalars only; every write —
 * from agents or the widget SDK — is checked against the active definitions.
 */
export const CUSTOM_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'enum'] as const;

/** Who set a custom-field value: the site's page through the SDK (unverified), a staff member, or an automation. */
export type FieldSource = 'visitor' | 'agent' | 'trigger';
export interface FieldProvenance {
  source: FieldSource;
  /** Membership id (agent) or trigger id (trigger); null for the visitor's page. */
  by: string | null;
  at: string;
}

/**
 * Provenance after a write: every changed key that still has a value is attributed to this writer; removed keys
 * lose their entry. Entries for untouched keys are kept.
 */
export function trackSources(
  stored: unknown,
  changedKeys: string[],
  next: Record<string, unknown>,
  source: FieldSource,
  by: string | null,
  at = new Date(),
): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {};
  for (const [k, v] of Object.entries((stored ?? {}) as Record<string, unknown>)) {
    if (k in next && v && typeof v === 'object' && typeof (v as FieldProvenance).source === 'string')
      out[k] = v as FieldProvenance;
  }
  for (const key of changedKeys) {
    if (key in next) out[key] = { source, by, at: at.toISOString() };
    else delete out[key];
  }
  return out;
}
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Keys that would shadow identity, authority or routing concepts (SEC03). */
const RESERVED_KEYS = new Set([
  'id',
  'name',
  'email',
  'phone',
  'display_name',
  'verified',
  'vip',
  'priority',
  'role',
  'visibility',
  'internal',
  'tenant_id',
  'site_id',
  'visitor_id',
  'department_id',
  'owner',
  'tags',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z
  .string()
  .regex(ISO_DATE, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');

const validationSchemas: Record<CustomFieldType, z.ZodTypeAny> = {
  string: z
    .object({
      minLength: z.number().int().min(0).max(2000).optional(),
      maxLength: z.number().int().min(1).max(2000).optional(),
      format: z.enum(['email', 'url', 'phone']).optional(),
    })
    .strict()
    .refine(
      (v) => v.minLength === undefined || v.maxLength === undefined || v.minLength <= v.maxLength,
      'min_length must not exceed max_length',
    ),
  number: z
    .object({
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      integer: z.boolean().optional(),
    })
    .strict()
    .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, 'min must not exceed max'),
  boolean: z.object({}).strict(),
  date: z
    .object({ min: isoDate.optional(), max: isoDate.optional() })
    .strict()
    .refine((v) => !v.min || !v.max || v.min <= v.max, 'min must not be after max'),
  enum: z
    .object({
      options: z
        .array(
          z
            .object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(100) })
            .strict(),
        )
        .min(1)
        .max(100)
        .refine((o) => new Set(o.map((x) => x.value)).size === o.length, 'Option values must be unique'),
    })
    .strict(),
};

export function parseValidation(type: CustomFieldType, raw: unknown): Record<string, unknown> {
  const r = validationSchemas[type].safeParse(raw ?? {});
  if (!r.success) {
    const err = zodError(r.error);
    const fe: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(err.extra.fieldErrors ?? {}))
      fe[k === '_' ? 'validation' : `validation.${k}`] = v;
    throw badRequest('The validation rules are not valid for this field type', fe);
  }
  return r.data as Record<string, unknown>;
}

export type FieldScalar = string | number | boolean;

/** Validate one value against a definition. Returns an error message or the normalized value. */
export function checkValue(
  def: Pick<CustomFieldDefinition, 'dataType' | 'validation'>,
  value: unknown,
): { ok: true; value: FieldScalar } | { ok: false; error: string } {
  if (value !== null && typeof value === 'object')
    return { ok: false, error: 'Nested objects and arrays are not allowed' };
  const v = (def.validation ?? {}) as Record<string, unknown>;
  switch (def.dataType as CustomFieldType) {
    case 'string': {
      if (typeof value !== 'string') return { ok: false, error: 'Must be text' };
      const s = value.trim();
      const max = typeof v.maxLength === 'number' ? v.maxLength : 500;
      if (s.length > max) return { ok: false, error: `At most ${max} characters` };
      if (typeof v.minLength === 'number' && s.length < v.minLength)
        return { ok: false, error: `At least ${v.minLength} characters` };
      if (v.format === 'email' && !EMAIL_RE.test(s)) return { ok: false, error: 'Must be an email address' };
      if (v.format === 'phone' && !/^[+()\d\s.-]{3,40}$/.test(s))
        return { ok: false, error: 'Must be a phone number' };
      if (v.format === 'url') {
        try {
          const u = new URL(s);
          if (u.protocol !== 'https:' && u.protocol !== 'http:')
            return { ok: false, error: 'Must be an http(s) URL' };
        } catch {
          return { ok: false, error: 'Must be an http(s) URL' };
        }
      }
      return { ok: true, value: s };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { ok: false, error: 'Must be a number' };
      if (v.integer === true && !Number.isInteger(value))
        return { ok: false, error: 'Must be a whole number' };
      if (typeof v.min === 'number' && value < v.min)
        return { ok: false, error: `Must be at least ${v.min}` };
      if (typeof v.max === 'number' && value > v.max) return { ok: false, error: `Must be at most ${v.max}` };
      return { ok: true, value };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'Must be true or false' };
    case 'date': {
      if (
        typeof value !== 'string' ||
        !ISO_DATE.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      )
        return { ok: false, error: 'Must be a date (YYYY-MM-DD)' };
      if (typeof v.min === 'string' && value < v.min)
        return { ok: false, error: `Must be on or after ${v.min}` };
      if (typeof v.max === 'string' && value > v.max)
        return { ok: false, error: `Must be on or before ${v.max}` };
      return { ok: true, value };
    }
    case 'enum': {
      const options = Array.isArray(v.options) ? (v.options as Array<{ value: string }>) : [];
      if (typeof value !== 'string' || !options.some((o) => o.value === value))
        return { ok: false, error: 'Choose one of the allowed options' };
      return { ok: true, value };
    }
    default:
      return { ok: false, error: 'Unsupported field type' };
  }
}

export interface CustomFieldResource {
  id: string;
  key: string;
  label: string;
  dataType: string;
  publicWritable: boolean;
  visibleToVisitor: boolean;
  validation: Record<string, unknown>;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export function customFieldResource(d: CustomFieldDefinition): CustomFieldResource {
  return {
    id: d.id,
    key: d.key,
    label: d.label,
    dataType: d.dataType,
    publicWritable: d.publicWritable,
    visibleToVisitor: d.visibleToVisitor,
    validation: (d.validation ?? {}) as Record<string, unknown>,
    archivedAt: d.archivedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    version: d.version,
  };
}

const MAX_FIELDS_PER_WRITE = 50;
const MAX_STORED_BYTES = 16 * 1024;

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, includeArchived: boolean): Promise<CustomFieldResource[]> {
    const rows = await this.db.read(auth.tenantId, (tx) =>
      tx.customFieldDefinition.findMany({
        where: { tenantId: auth.tenantId, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ archivedAt: 'asc' }, { key: 'asc' }],
      }),
    );
    return rows.map(customFieldResource);
  }

  async create(
    auth: AuthContext,
    input: {
      key: string;
      label: string;
      dataType: CustomFieldType;
      validation?: unknown;
      publicWritable?: boolean;
      visibleToVisitor?: boolean;
    },
  ): Promise<CustomFieldResource> {
    const key = input.key.trim().toLowerCase();
    if (!CUSTOM_FIELD_KEY_RE.test(key))
      throw badRequest('Use a lowercase key with letters, digits and underscores (max 64)', {
        key: ['Invalid key'],
      });
    if (RESERVED_KEYS.has(key)) throw badRequest('That key is reserved', { key: ['Reserved key'] });
    const validation = parseValidation(input.dataType, input.validation);
    return this.db.tx(auth.tenantId, async (tx) => {
      const existing = await tx.customFieldDefinition.findUnique({
        where: { tenantId_key: { tenantId: auth.tenantId, key } },
      });
      if (existing)
        throw conflict(
          'CONFLICT',
          `A custom field “${key}” already exists${existing.archivedAt ? ' (archived)' : ''}`,
        );
      const count = await tx.customFieldDefinition.count({
        where: { tenantId: auth.tenantId, archivedAt: null },
      });
      if (count >= 200) throw conflict('PLAN_LIMIT', 'At most 200 active custom fields');
      const d = await tx.customFieldDefinition.create({
        data: {
          tenantId: auth.tenantId,
          key,
          label: input.label.trim(),
          dataType: input.dataType,
          validation: validation as Prisma.InputJsonValue,
          publicWritable: input.publicWritable ?? false,
          visibleToVisitor: input.visibleToVisitor ?? false,
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'custom_field.created',
        objectType: 'custom_field',
        objectId: d.id,
        safeDiff: {
          field_key: key,
          data_type: d.dataType,
          public_writable: d.publicWritable,
          visible_to_visitor: d.visibleToVisitor,
        },
      });
      return customFieldResource(d);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
    patch: {
      label?: string;
      dataType?: CustomFieldType;
      validation?: unknown;
      publicWritable?: boolean;
      visibleToVisitor?: boolean;
    },
  ): Promise<CustomFieldResource> {
    return this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'custom_field_definitions', auth.tenantId, id);
      const d = await tx.customFieldDefinition.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!d) throw notFound('Custom field');
      if (d.version !== expectedVersion) throw staleVersion();
      if (d.archivedAt) throw conflict('CONFLICT', 'Archived fields cannot be edited');
      const nextType = patch.dataType ?? (d.dataType as CustomFieldType);
      if (nextType !== d.dataType && (await this.populated(tx, auth.tenantId, d.key))) {
        throw conflict(
          'CONFLICT',
          'This field already has values; changing its type would destroy them. Create a new field instead.',
        );
      }
      const validation =
        patch.validation !== undefined || nextType !== d.dataType
          ? parseValidation(nextType, patch.validation ?? (nextType === d.dataType ? d.validation : {}))
          : undefined;
      const updated = await tx.customFieldDefinition.updateMany({
        where: { tenantId: auth.tenantId, id, version: expectedVersion },
        data: {
          ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
          ...(nextType !== d.dataType ? { dataType: nextType } : {}),
          ...(validation ? { validation: validation as Prisma.InputJsonValue } : {}),
          ...(patch.publicWritable !== undefined ? { publicWritable: patch.publicWritable } : {}),
          ...(patch.visibleToVisitor !== undefined ? { visibleToVisitor: patch.visibleToVisitor } : {}),
          version: { increment: 1 },
        },
      });
      if (!updated.count) throw staleVersion();
      const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      await this.audit.inTx(tx, auth, {
        action: 'custom_field.updated',
        objectType: 'custom_field',
        objectId: id,
        safeDiff: {
          field_key: d.key,
          changed,
          ...(nextType !== d.dataType ? { data_type: { from: d.dataType, to: nextType } } : {}),
        },
      });
      return customFieldResource(await tx.customFieldDefinition.findUniqueOrThrow({ where: { id } }));
    });
  }

  async archive(auth: AuthContext, id: string): Promise<CustomFieldResource> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const d = await tx.customFieldDefinition.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!d) throw notFound('Custom field');
      if (d.archivedAt) return customFieldResource(d);
      const a = await tx.customFieldDefinition.update({
        where: { id },
        data: { archivedAt: new Date(), version: { increment: 1 } },
      });
      await this.audit.inTx(tx, auth, {
        action: 'custom_field.archived',
        objectType: 'custom_field',
        objectId: id,
        safeDiff: { field_key: d.key },
      });
      return customFieldResource(a);
    });
  }

  private async populated(tx: Tx, tenantId: string, key: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ hit: boolean }>>`
      SELECT (EXISTS (SELECT 1 FROM visitors WHERE tenant_id = ${tenantId}::uuid AND (custom_fields -> ${key}) IS NOT NULL)
           OR EXISTS (SELECT 1 FROM offline_submissions WHERE tenant_id = ${tenantId}::uuid AND (custom_fields -> ${key}) IS NOT NULL)) AS hit`;
    return !!rows[0]?.hit;
  }

  async activeDefinitions(tx: Tx, tenantId: string): Promise<Map<string, CustomFieldDefinition>> {
    const defs = await tx.customFieldDefinition.findMany({ where: { tenantId, archivedAt: null } });
    return new Map(defs.map((d) => [d.key, d]));
  }

  /**
   * Merge a custom-field patch into a stored map. `null` removes a key. Unknown,
   * archived or (for public writers) non-public keys are rejected with field
   * errors; nested objects/arrays are never stored.
   */
  async applyPatch(
    tx: Tx,
    tenantId: string,
    stored: unknown,
    patch: unknown,
    opts: { publicOnly: boolean },
  ): Promise<{ next: Record<string, FieldScalar>; changedKeys: string[] }> {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
      throw badRequest('custom_fields must be an object of field values', {
        custom_fields: ['Must be an object'],
      });
    const entries = Object.entries(patch as Record<string, unknown>);
    if (entries.length > MAX_FIELDS_PER_WRITE)
      throw badRequest(`At most ${MAX_FIELDS_PER_WRITE} fields per update`, {
        custom_fields: ['Too many fields'],
      });
    const defs = await this.activeDefinitions(tx, tenantId);
    const errors: Record<string, string[]> = {};
    const next: Record<string, FieldScalar> = {};
    for (const [k, v] of Object.entries((stored ?? {}) as Record<string, unknown>))
      if (v !== null && typeof v !== 'object') next[k] = v as FieldScalar;
    const changedKeys: string[] = [];
    for (const [key, value] of entries) {
      const def = defs.get(key);
      if (!def || (opts.publicOnly && !def.publicWritable)) {
        errors[`custom_fields.${key}`] = ['Unknown field'];
        continue;
      }
      if (value === null) {
        if (key in next) changedKeys.push(key);
        delete next[key];
        continue;
      }
      const r = checkValue(def, value);
      if (!r.ok) {
        errors[`custom_fields.${key}`] = [r.error];
        continue;
      }
      if (next[key] !== r.value) changedKeys.push(key);
      next[key] = r.value;
    }
    if (Object.keys(errors).length) throw badRequest('Some custom fields are not allowed or invalid', errors);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_STORED_BYTES)
      throw new AppError(422, 'VALIDATION_FAILED', 'Custom field values are too large', {
        fieldErrors: { custom_fields: ['Too large'] },
      });
    return { next, changedKeys };
  }

  /** Values a visitor may see about themselves (visible_to_visitor definitions only). */
  async visitorVisible(tx: Tx, tenantId: string, stored: unknown): Promise<Record<string, FieldScalar>> {
    const defs = await this.activeDefinitions(tx, tenantId);
    const out: Record<string, FieldScalar> = {};
    for (const [k, v] of Object.entries((stored ?? {}) as Record<string, unknown>)) {
      if (defs.get(k)?.visibleToVisitor && v !== null && typeof v !== 'object') out[k] = v as FieldScalar;
    }
    return out;
  }
}
