'use client';
/** Trigger write commands shared by the list and the editor. */
import type { DslDefinition } from '@talkivio/contracts';
import { tStatic } from '@/i18n';
import { api } from '@/lib/api';
import { uuid } from '@/lib/ids';
import { fixDetail, resnake, type TriggerDetail, type TriggerSummary } from './triggers-api';

/**
 * Enable or disable the published revision. When the published revision is the
 * head, this is POST /publish {revision, enabled} (no definition change). When an
 * unpublished draft exists, publishing would also ship the draft, so activation
 * goes through PATCH {enabled} with If-Match instead.
 */
export async function setTriggerEnabled(t: Pick<TriggerSummary, 'id' | 'publishedRevision' | 'currentRevision' | 'version'>, enabled: boolean): Promise<TriggerDetail> {
  if (!t.publishedRevision) throw new Error(tStatic('triggers.commands.publishFirst'));
  if (t.publishedRevision === t.currentRevision) {
    return fixDetail(await api.post<TriggerDetail>(`/triggers/${t.id}/publish`, { revision: t.currentRevision, enabled }));
  }
  return fixDetail(await api.patch<TriggerDetail>(`/triggers/${t.id}`, { enabled }, { ifMatch: t.version }));
}

export async function publishTrigger(id: string, revision: number, enabled: boolean): Promise<TriggerDetail> {
  return fixDetail(await api.post<TriggerDetail>(`/triggers/${id}/publish`, { revision, enabled }));
}

export async function createTrigger(input: { name: string; description: string | null; definition: DslDefinition }, idempotencyKey = uuid()): Promise<TriggerDetail> {
  // `definition` is wire-form already; toWire leaves its snake_case keys untouched.
  return fixDetail(await api.post<TriggerDetail>('/triggers', input, { idempotencyKey }));
}

export async function saveTriggerDraft(id: string, definition: DslDefinition, version: number): Promise<{ trigger: TriggerSummary; draft: { revision: number; definition: DslDefinition; publishedAt: string | null } }> {
  const r = await api.put<{ trigger: TriggerSummary; draft: { revision: number; definition: DslDefinition; publishedAt: string | null } }>(`/triggers/${id}/draft`, { definition }, { ifMatch: version });
  return { ...r, draft: { ...r.draft, definition: resnake<DslDefinition>(r.draft.definition) } };
}

export async function patchTriggerMeta(id: string, patch: { name?: string; description?: string | null }, version: number): Promise<TriggerDetail> {
  return fixDetail(await api.patch<TriggerDetail>(`/triggers/${id}`, patch, { ifMatch: version }));
}

export async function restoreTriggerRevision(id: string, revision: number): Promise<TriggerDetail> {
  return fixDetail(await api.post<TriggerDetail>(`/triggers/${id}/restore`, { revision }));
}

export async function archiveTrigger(id: string, version: number): Promise<void> {
  await api.delete(`/triggers/${id}`, { ifMatch: version });
}
