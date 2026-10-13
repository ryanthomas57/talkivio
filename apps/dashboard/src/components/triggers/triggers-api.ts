'use client';
/**
 * Trigger REST contracts (ch. 33/45/77) and the key-casing rule for DSL documents.
 *
 * DSL definitions are stored and validated in their snake_case wire form
 * (`stop_processing`, `cooldown_seconds`, `ignore_case`, `department_id` …). The
 * generic client converts every response key to camelCase, which would corrupt
 * them, so:
 *   - The editor keeps the definition as a `DslDefinition` in wire form at all times
 *     and validates it with the shared `validateDslDefinition`.
 *   - Requests send it unchanged: `toWire` only rewrites keys containing upper-case
 *     letters, and DSL keys never do, so the body reaches the API verbatim (the API
 *     keeps `definition` / `snapshot` verbatim too).
 *   - Responses are converted back with `resnake()` (camelCase → snake_case). Every
 *     DSL grammar key is lower-case letters separated by single underscores, so the
 *     round trip is lossless for definitions and actions.
 *   - Snapshot keys echoed by the simulator (`page.visible_dwell_seconds`,
 *     `custom.<key>`) can contain `_<digit>`, which the camel conversion cannot
 *     reverse, so they are looked up with `toCamelKey(field)` instead (`echoValue`).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DslAction, DslConditionTrace, DslDefinition, DslEvent, DslSuppressionReason, DslTriggerReason } from '@talkivio/contracts';
import { useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { api, type Paged } from '@/lib/api';
import type { DurableEvent } from '@/lib/realtime';
import { toCamelKey, toSnakeKey } from '@/lib/wire';
import { useSession } from '@/stores/session';

export interface TriggerSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  event: DslEvent;
  priority: number;
  currentRevision: number;
  publishedRevision: number | null;
  draftPending: boolean;
  lastMatchedAt: string | null;
  matchCount: number;
  errorCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TriggerListItem extends TriggerSummary {
  /** Head (current draft) revision's definition, in wire form after `resnake`. */
  definition: DslDefinition | null;
}

export interface RevisionResource {
  revision: number;
  dslVersion: number;
  definition: DslDefinition;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
}

export interface RevisionMeta {
  revision: number;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
}

export interface TriggerDetail extends TriggerSummary {
  draft: RevisionResource | null;
  published: RevisionResource | null;
  revisions: RevisionMeta[];
}

export interface SimulatedTrigger {
  triggerId: string;
  name: string | null;
  candidate: boolean;
  /** 0 for the candidate when unsaved editor state was simulated. */
  revision: number;
  priority: number;
  position: number;
  evaluated: boolean;
  matched: boolean;
  fired: boolean;
  reason: DslTriggerReason;
  stopProcessing: boolean;
  allResult: boolean;
  anyResult: boolean;
  all: DslConditionTrace[];
  any: DslConditionTrace[];
}

export interface SimulationResult {
  event: DslEvent;
  triggerId: string;
  /** null = the unsaved editor definition was simulated (no revision). */
  revision: number | null;
  /** Validated snapshot echoed by the API — keys are camelCased by the transport; read with `echoValue`. */
  snapshot: Record<string, unknown>;
  triggers: SimulatedTrigger[];
  effects: Array<{ triggerId: string; revision: number; actionIndex: number; action: DslAction }>;
  suppressed: Array<{ triggerId: string; revision: number; actionIndex: number; type: DslAction['type']; reason: DslSuppressionReason }>;
  stoppedBy: string | null;
  blocked: boolean;
  writes: boolean;
}

export interface TriggerRunEffect {
  id: string;
  actionIndex: number;
  actionType: string;
  status: string;
  reason: string | null;
  executedAt: string | null;
}

export interface TriggerRun {
  id: string;
  triggerId: string;
  triggerRevision: number;
  eventId: string;
  eventType: string;
  visitorSessionId: string | null;
  chatId: string | null;
  matched: boolean;
  causationId: string | null;
  depth: number;
  executedAt: string;
  /** Safe trace recorded by the engine (camelCased by the transport). */
  result: { reason?: string; fired?: boolean; blocked?: boolean; stoppedBy?: string | null; allResult?: boolean; anyResult?: boolean } | null;
  effects: TriggerRunEffect[];
}

export interface InvitationFunnel {
  campaignId: string;
  from: string | null;
  to: string | null;
  eligible: number;
  displayed: number;
  accepted: number;
  served: number;
  dismissed: number;
  expired: number;
}

/** Custom field definition (GET /custom-fields). */
export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  dataType: string;
  publicWritable: boolean;
  archivedAt?: string | null;
}

export const tk = {
  root: ['triggers'] as const,
  list: (event: string | null) => ['triggers', 'list', event ?? 'all'] as const,
  detail: (id: string) => ['triggers', 'detail', id] as const,
  revision: (id: string, revision: number) => ['triggers', 'revision', id, revision] as const,
  runs: (id: string, from: string, to: string) => ['triggers', 'runs', id, from, to] as const,
  funnel: (id: string, from: string | null) => ['triggers', 'funnel', id, from ?? 'all'] as const,
  customFields: ['custom-fields'] as const,
};

/** camelCase keys → snake_case, deeply (lossless for DSL grammar keys; see header). */
export function resnake<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => resnake(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[toSnakeKey(k)] = resnake(v);
    return out as T;
  }
  return value as T;
}

/** Read a field from the simulator's echoed snapshot (keys were camelCased in transit). */
export function echoValue(snapshot: Record<string, unknown> | null | undefined, field: string): unknown {
  if (!snapshot) return undefined;
  const k = toCamelKey(field);
  return k in snapshot ? snapshot[k] : snapshot[field];
}

function fixRevision(r: RevisionResource | null): RevisionResource | null {
  return r ? { ...r, definition: resnake<DslDefinition>(r.definition) } : null;
}

export function fixDetail(d: TriggerDetail): TriggerDetail {
  return { ...d, draft: fixRevision(d.draft), published: fixRevision(d.published) };
}

export function fixListItem(t: TriggerListItem): TriggerListItem {
  return { ...t, definition: t.definition ? resnake<DslDefinition>(t.definition) : null };
}

export function fixSimulation(r: SimulationResult): SimulationResult {
  return { ...r, effects: r.effects.map((e) => ({ ...e, action: resnake<DslAction>(e.action) })) };
}

/** One revision with its full definition (GET /triggers/{id}/revisions/{revision}); revisions are immutable once published. */
export async function fetchRevision(id: string, revision: number): Promise<RevisionResource> {
  return fixRevision(await api.get<RevisionResource>(`/triggers/${id}/revisions/${revision}`))!;
}

export function useRevision(id: string, revision: number | null) {
  return useQuery({ queryKey: tk.revision(id, revision ?? 0), queryFn: () => fetchRevision(id, revision!), enabled: revision !== null, staleTime: 30_000 });
}

export async function fetchTrigger(id: string): Promise<TriggerDetail> {
  return fixDetail(await api.get<TriggerDetail>(`/triggers/${id}`));
}

export function useTrigger(id: string | null) {
  return useQuery({ queryKey: tk.detail(id ?? 'none'), queryFn: () => fetchTrigger(id!), enabled: !!id, staleTime: 5_000 });
}

/** Every non-archived trigger (pages through the cursor; tenants rarely have more than a few dozen). */
export async function fetchAllTriggers(event: string | null): Promise<TriggerListItem[]> {
  const out: TriggerListItem[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const p: Paged<TriggerListItem> = await api.page<TriggerListItem>('/triggers', { event: event ?? undefined, cursor: cursor ?? undefined, limit: 100 });
    out.push(...p.items.map(fixListItem));
    if (!p.hasMore || !p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return out;
}

export function useTriggers(event: string | null) {
  return useQuery({ queryKey: tk.list(event), queryFn: () => fetchAllTriggers(event), staleTime: 10_000 });
}

/** Trusted custom fields are usable in conditions; any defined field can be written by set_visitor_field. */
export function useCustomFields(enabled = true) {
  return useQuery({ queryKey: tk.customFields, queryFn: () => api.get<CustomFieldDef[]>('/custom-fields'), enabled, staleTime: 60_000 });
}

/** Same mapping the API uses (trigger-repo `customType`). */
export function customFieldType(dataType: string): 'string' | 'number' | 'boolean' {
  const t = dataType.toLowerCase();
  if (t === 'number' || t === 'integer' || t === 'decimal') return 'number';
  if (t === 'boolean' || t === 'bool' || t === 'checkbox') return 'boolean';
  return 'string';
}

export function hasInvitation(def: DslDefinition | null | undefined): boolean {
  return !!def?.actions.some((a) => a.type === 'display_invitation');
}

export type TriggerStatus = 'draft' | 'enabled' | 'disabled';

export function triggerStatus(t: Pick<TriggerSummary, 'publishedRevision' | 'enabled'>): TriggerStatus {
  if (!t.publishedRevision) return 'draft';
  return t.enabled ? 'enabled' : 'disabled';
}

/** `trigger.published` (durable, staff, scope team:all): publish, enable/disable and archive. No definition in the payload. */
export interface TriggerPublishedPayload {
  triggerId: string;
  revision: number | null;
  enabled: boolean;
  event: string;
  priority: number;
}

/** `trigger.updated` (durable, staff, scope team:all): created, renamed, draft saved, revision restored. */
export interface TriggerUpdatedPayload {
  triggerId: string;
  change: 'created' | 'details' | 'draft_saved' | 'restored';
  currentRevision: number;
  version: number;
}

export type TriggerChange = { type: 'trigger.published'; event: DurableEvent<TriggerPublishedPayload> } | { type: 'trigger.updated'; event: DurableEvent<TriggerUpdatedPayload> };

/**
 * Keep trigger screens fresh: subscribe to `team:all` and refetch lists (and the
 * changed trigger) on `trigger.published` / `trigger.updated` or after a reconnect.
 * `onChange` lets the editor react to a change of the trigger it has open.
 */
export function useTriggersRealtime(onChange?: (c: TriggerChange) => void): void {
  const qc = useQueryClient();
  const canTeam = useSession((s) => s.permissions.has('agents.view'));
  useScopes(canTeam ? [{ kind: 'team', id: 'all' }] : null);
  const refresh = (triggerId: string | undefined) => {
    void qc.invalidateQueries({ queryKey: tk.root, predicate: (q) => q.queryKey[1] === 'list' });
    if (triggerId) void qc.invalidateQueries({ queryKey: tk.detail(triggerId) });
  };
  useRealtimeEvent<TriggerPublishedPayload>('trigger.published', (e) => {
    refresh(e.payload?.triggerId);
    onChange?.({ type: 'trigger.published', event: e });
  });
  useRealtimeEvent<TriggerUpdatedPayload>('trigger.updated', (e) => {
    refresh(e.payload?.triggerId);
    onChange?.({ type: 'trigger.updated', event: e });
  });
  useResync(() => void qc.invalidateQueries({ queryKey: tk.root }));
}
