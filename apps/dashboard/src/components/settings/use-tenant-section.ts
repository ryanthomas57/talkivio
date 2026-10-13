'use client';
/**
 * One independently saved card of workspace settings (`PATCH /tenants/current`).
 *
 * - The draft remembers the server values it started from (`base`). Only fields
 *   that differ from `base` are sent, together with `expectedVersion`.
 * - VERSION_CONFLICT keeps the draft and reports `conflict`; Reload refetches the
 *   tenant. If this card's own server values changed meanwhile, the draft is
 *   discarded (and `stale` is set) so another editor's change is never overwritten.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { isolate, useT } from '@/i18n';
import { api } from '@/lib/api';
import type { Tenant } from '@/lib/types';
import { useSession } from '@/stores/session';
import { describeFailure, fieldError, isEqual, snakePath, type FieldErrors } from './form-kit';

export interface TenantPatchBody {
  name?: string;
  timezone?: string;
  retentionDays?: number;
  settings?: Record<string, Record<string, unknown>>;
}

export interface TenantSectionOptions<T extends Record<string, unknown>> {
  /** Translated card title (used in the saved toast). */
  title: string;
  select: (t: Tenant) => T;
  /** Build the PATCH body from the changed fields only. */
  toPatch: (changed: Partial<T>, value: T) => TenantPatchBody;
  /** Error path per field, e.g. `settings.chat.idleTimeoutMinutes` (matched against server field errors). */
  paths: Record<keyof T, string>;
  validate?: (value: T) => Partial<Record<keyof T, string | null>>;
}

export interface TenantSection<T extends Record<string, unknown>> {
  value: T;
  set: (patch: Partial<T>) => void;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  stale: boolean;
  message: string | null;
  error: (key: keyof T) => string | undefined;
  save: () => Promise<boolean>;
  discard: () => void;
  reload: () => Promise<void>;
}

export function useTenantSection<T extends Record<string, unknown>>(opts: TenantSectionOptions<T>): TenantSection<T> {
  const t = useT();
  const tenant = useSession((s) => s.tenant);
  const setTenant = useSession((s) => s.setTenant);
  const { select, toPatch, paths, validate, title } = opts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const baseline = useMemo(() => (tenant ? select(tenant) : null), [tenant]);
  const [draft, setDraft] = useState<{ base: T; value: T } | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  // Server values for this card changed under an open draft (after Reload): drop the draft.
  useEffect(() => {
    if (!baseline || !draft) return;
    if (!isEqual(draft.base, baseline)) {
      setDraft(null);
      setStale(true);
    }
  }, [baseline, draft]);

  const value = (draft?.value ?? baseline) as T;
  const dirty = !!draft && !isEqual(draft.value, draft.base);

  const set = useCallback(
    (patch: Partial<T>) => {
      if (!baseline) return;
      setStale(false);
      setMessage(null);
      setDraft((d) => ({ base: d?.base ?? baseline, value: { ...(d?.value ?? baseline), ...patch } }));
      // Clear errors for the touched fields as the user edits them.
      setErrors((prev) => {
        const keys = Object.keys(patch).map((k) => snakePath(paths[k as keyof T]));
        if (!keys.some((k) => Object.keys(prev).some((p) => p === k || p.startsWith(`${k}.`)))) return prev;
        return Object.fromEntries(Object.entries(prev).filter(([p]) => !keys.some((k) => p === k || p.startsWith(`${k}.`))));
      });
    },
    [baseline, paths],
  );

  const discard = useCallback(() => {
    setDraft(null);
    setErrors({});
    setMessage(null);
    setConflict(false);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const current = useSession.getState().tenant;
    if (!draft || !current) return true;
    if (isEqual(draft.value, draft.base)) {
      setDraft(null);
      return true;
    }
    const local = validate?.(draft.value) ?? {};
    const localErrors: FieldErrors = {};
    for (const [k, msg] of Object.entries(local)) if (msg) localErrors[snakePath(paths[k as keyof T])] = [msg as string];
    if (Object.keys(localErrors).length) {
      setErrors(localErrors);
      setMessage(t('settings.tenant.checkFields'));
      return false;
    }
    const changed = Object.fromEntries(Object.entries(draft.value).filter(([k, v]) => !isEqual(v, draft.base[k]))) as Partial<T>;
    setSaving(true);
    setMessage(null);
    setErrors({});
    setConflict(false);
    try {
      const next = await api.patch<Tenant>('/tenants/current', { ...toPatch(changed, draft.value), expectedVersion: current.version });
      setTenant(next);
      setDraft(null);
      toast.success(t('settings.tenant.saved', { section: isolate(title) }));
      return true;
    } catch (e) {
      const f = describeFailure(e);
      setConflict(f.conflict);
      setMessage(f.message);
      setErrors(f.fieldErrors);
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, validate, paths, toPatch, setTenant, title, t]);

  const reload = useCallback(async () => {
    await useSession.getState().refreshTenant();
    setConflict(false);
    setMessage(null);
  }, []);

  const error = useCallback((key: keyof T) => fieldError(errors, paths[key]), [errors, paths]);

  return { value, set, dirty, saving, conflict, stale, message, error, save, discard, reload };
}
