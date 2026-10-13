'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { visitorKeys, type VisitorProfile, type VisitorTag } from './types';

/** One visitor record (GET /visitors/{id}) with helpers that keep the cache coherent. */
export function useVisitorProfile(id: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: visitorKeys.profile(id ?? ''),
    queryFn: () => api.get<VisitorProfile>(`/visitors/${id}`),
    enabled: !!id,
    staleTime: 10_000,
    retry: (n, e) => (e as { status?: number }).status !== 404 && (e as { status?: number }).status !== 403 && n < 2,
  });

  const setProfile = useCallback((p: unknown) => id && qc.setQueryData(visitorKeys.profile(id), p as VisitorProfile), [qc, id]);

  /** Tags are their own sub-resource; the response carries the bumped visitor version (the If-Match token). */
  const saveTags = useCallback(
    async (tagIds: string[]) => {
      if (!id) return;
      const r = await api.put<{ visitorId: string; tags: VisitorTag[]; version: number }>(`/visitors/${id}/tags`, { tagIds });
      qc.setQueryData<VisitorProfile>(visitorKeys.profile(id), (p) => (p ? { ...p, tags: r.tags, version: r.version } : p));
      await qc.invalidateQueries({ queryKey: visitorKeys.profile(id), exact: true });
    },
    [qc, id],
  );

  return { ...q, setProfile, saveTags };
}
