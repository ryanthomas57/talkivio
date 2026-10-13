/**
 * Deterministic routing decisions (ch. 30). Pure functions shared by the API,
 * worker and tests; the transactional orchestration lives in the API.
 */

export interface RoutingCandidate {
  membershipId: string;
  capacity: number;
  /** Chats owned and active. */
  active: number;
  /** Collaborations counting toward capacity (default one slot each). */
  collaborations: number;
  /** Unexpired assigned/transfer offers (reservations). */
  reserved: number;
  /** ms epoch of the last assignment, or null if never assigned. */
  lastAssignmentAt: number | null;
}

export function usedSlots(c: RoutingCandidate): number {
  return c.active + c.collaborations + c.reserved;
}

export function freeSlots(c: RoutingCandidate): number {
  return c.capacity - usedSlots(c);
}

export function normalizedLoad(c: RoutingCandidate): number {
  return c.capacity > 0 ? usedSlots(c) / c.capacity : Number.POSITIVE_INFINITY;
}

/**
 * Assigned-mode selection: least normalized load, then earliest last assignment
 * (never-assigned first), then membership id ascending. Reproducible for equal inputs.
 */
export function compareCandidates(a: RoutingCandidate, b: RoutingCandidate): number {
  const la = normalizedLoad(a);
  const lb = normalizedLoad(b);
  if (la !== lb) return la - lb;
  const ta = a.lastAssignmentAt ?? -1;
  const tb = b.lastAssignmentAt ?? -1;
  if (ta !== tb) return ta - tb;
  return a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0;
}

export function selectCandidate(candidates: RoutingCandidate[]): RoutingCandidate | null {
  const eligible = candidates.filter((c) => freeSlots(c) > 0);
  if (!eligible.length) return null;
  return [...eligible].sort(compareCandidates)[0];
}

/** Aging: effective priority = min(100, base + floor(wait/60s)). */
export function effectivePriority(basePriority: number, waitSeconds: number): number {
  return Math.min(100, basePriority + Math.floor(Math.max(0, waitSeconds) / 60));
}

export interface QueueItem {
  id: string;
  priority: number;
  requestedAt: number;
}

/** Queue order frozen at `now`: effective priority desc, requested_at asc, id asc. */
export function sortQueue<T extends QueueItem>(items: T[], now: number): T[] {
  return [...items].sort((a, b) => {
    const pa = effectivePriority(a.priority, (now - a.requestedAt) / 1000);
    const pb = effectivePriority(b.priority, (now - b.requestedAt) / 1000);
    if (pa !== pb) return pb - pa;
    if (a.requestedAt !== b.requestedAt) return a.requestedAt - b.requestedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Detect a cycle in department fallback edges (A → B → A is invalid). */
export function hasFallbackCycle(edges: Record<string, string | null | undefined>, start: string): boolean {
  const seen = new Set<string>();
  let cur: string | null | undefined = start;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = edges[cur];
  }
  return false;
}
