'use client';
/**
 * Custom field definitions (ch. 17/37/43) — mirrors `CustomFieldResource` in
 * `apps/api/src/features/visitors/custom-fields.service.ts`. Values are flat
 * scalars stored per visitor and validated server side against these rules.
 */
import { useQuery } from '@tanstack/react-query';
import { tStatic, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useSession } from '@/stores/session';

export const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'enum'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Catalog keys for the field types, translated at render time. */
export const TYPE_LABEL: Record<FieldType, MessageKey> = {
  string: 'customFields.type.string',
  number: 'customFields.type.number',
  boolean: 'customFields.type.boolean',
  date: 'customFields.type.date',
  enum: 'customFields.type.enum',
};

export interface EnumOption {
  value: string;
  label: string;
}

/** Union of every type's rule set (only the keys valid for the field's type are sent). */
export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'url' | 'phone';
  min?: number | string;
  max?: number | string;
  integer?: boolean;
  options?: EnumOption[];
}

export interface CustomField {
  id: string;
  key: string;
  label: string;
  dataType: FieldType;
  publicWritable: boolean;
  visibleToVisitor: boolean;
  validation: FieldValidation;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const customFieldKeys = {
  all: (archived: boolean) => ['custom-fields', archived ? 'all' : 'active'] as const,
  root: ['custom-fields'] as const,
};

/** Active definitions (readable with `tenant.read`). */
export function useCustomFields(includeArchived = false) {
  const can = useSession((s) => s.permissions.has('tenant.read'));
  return useQuery({
    queryKey: customFieldKeys.all(includeArchived),
    queryFn: () => api.get<CustomField[]>('/custom-fields', includeArchived ? { includeArchived: 'true' } : undefined),
    enabled: can,
    staleTime: 60_000,
  });
}

/** Human summary of a definition's rules, in the UI language (list items joined with " · "). */
export function describeRules(f: Pick<CustomField, 'dataType' | 'validation'>): string {
  const t = tStatic;
  const v = f.validation ?? {};
  const parts: string[] = [];
  switch (f.dataType) {
    case 'string':
      if (v.format) parts.push(t(v.format === 'url' ? 'customFields.rules.url' : v.format === 'email' ? 'customFields.rules.email' : 'customFields.rules.phone'));
      if (v.minLength !== undefined) parts.push(t('customFields.rules.minChars', { n: v.minLength }));
      parts.push(t('customFields.rules.maxChars', { n: v.maxLength ?? 500 }));
      break;
    case 'number':
      if (v.integer) parts.push(t('customFields.rules.wholeNumber'));
      if (v.min !== undefined) parts.push(t('customFields.rules.atLeast', { n: typeof v.min === 'number' ? formatNumber(v.min) : v.min }));
      if (v.max !== undefined) parts.push(t('customFields.rules.atMost', { n: typeof v.max === 'number' ? formatNumber(v.max) : v.max }));
      break;
    case 'date':
      if (v.min) parts.push(t('customFields.rules.from', { date: String(v.min) }));
      if (v.max) parts.push(t('customFields.rules.until', { date: String(v.max) }));
      break;
    case 'enum':
      parts.push(t('customFields.rules.options', { count: v.options?.length ?? 0 }));
      break;
    default:
      break;
  }
  return parts.join(' · ') || t('customFields.rules.none');
}
