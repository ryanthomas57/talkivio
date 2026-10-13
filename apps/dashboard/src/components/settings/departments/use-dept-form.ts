'use client';
/**
 * Draft for one department tab with versioned PATCH (`expectedVersion` = the
 * version the draft started from). A newer server version that leaves this tab's
 * fields unchanged is adopted silently; one that changes them is reported as
 * `remoteChanged` so another editor's work is never overwritten.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { Department } from '@/lib/types';
import { describeFailure, isEqual, type FieldErrors } from '../form-kit';
import type { DepartmentResource } from './dept-shared';

/** `savedMessage` is the translated toast shown after a successful save. */
export function useDeptForm<T extends Record<string, unknown>>(dept: DepartmentResource, select: (d: DepartmentResource) => T, opts: { savedMessage: string; onDirtyChange: (d: boolean) => void }) {
  const qc = useQueryClient();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const server = useMemo(() => select(dept), [dept]);
  const [draft, setDraft] = useState<{ base: T; baseVersion: number; value: T } | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [rebased, setRebased] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const value = draft?.value ?? server;
  const dirty = !!draft && !isEqual(draft.value, draft.base);
  const { onDirtyChange, savedMessage } = opts;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!draft || dept.version === draft.baseVersion) return;
    if (isEqual(select(dept), draft.base)) {
      setDraft({ ...draft, baseVersion: dept.version });
      // Our save lost a version race on fields this tab doesn't touch: the edits still apply.
      if (conflict) {
        setConflict(false);
        setRebased(true);
      }
    } else setRemoteChanged(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept, draft]);

  const set = useCallback(
    (patch: Partial<T>) => {
      setDraft((d) => ({ base: d?.base ?? server, baseVersion: d?.baseVersion ?? dept.version, value: { ...(d?.value ?? server), ...patch } }));
      setErrors({});
    },
    [server, dept.version],
  );

  const discard = useCallback(() => {
    setDraft(null);
    setRemoteChanged(false);
    setConflict(false);
    setRebased(false);
    setMessage(null);
    setErrors({});
  }, []);

  /** PATCH the changed fields; `extra` lets a tab adjust the body (e.g. trimming). */
  const save = useCallback(
    async (build?: (changed: Partial<T>, value: T) => Record<string, unknown>): Promise<boolean> => {
      if (!draft || isEqual(draft.value, draft.base)) return true;
      const changed = Object.fromEntries(Object.entries(draft.value).filter(([k, v]) => !isEqual(v, draft.base[k]))) as Partial<T>;
      setSaving(true);
      setMessage(null);
      setConflict(false);
      setRebased(false);
      setErrors({});
      try {
        const next = await api.patch<Department>(`/departments/${dept.id}`, { ...(build ? build(changed, draft.value) : changed), expectedVersion: draft.baseVersion });
        qc.setQueryData<Department[]>(qk.departments, (list) => list?.map((d) => (d.id === next.id ? next : d)));
        setDraft(null);
        setRemoteChanged(false);
        toast.success(savedMessage);
        void qc.invalidateQueries({ queryKey: qk.departments });
        return true;
      } catch (e) {
        const f = describeFailure(e);
        setConflict(f.conflict);
        setMessage(f.message);
        setErrors(f.fieldErrors);
        if (f.conflict) void qc.invalidateQueries({ queryKey: qk.departments });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [draft, dept.id, qc, savedMessage],
  );

  const reload = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: qk.departments });
    discard();
  }, [qc, discard]);

  return { value, set, dirty, saving, conflict, rebased, remoteChanged, message, errors, setErrors, setMessage, save, discard, reload };
}
