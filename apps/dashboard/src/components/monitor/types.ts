/** Monitor snapshot (camelCase) — mirrors `MonitorSnapshot` in apps/api/src/features/analytics/monitor.service.ts. */
import type { EffectiveStatus } from '@/lib/types';

export type WaitLevel = 'none' | 'ok' | 'warning' | 'critical';

export interface MonitorThresholds {
  queueWarningSeconds: number;
  queueCriticalSeconds: number;
  staleAfterMs: number;
}

export interface DepartmentLoad {
  departmentId: string | null;
  name: string;
  queued: number;
  oldestWaitSeconds: number | null;
  oldestWaitLevel: WaitLevel;
  active: number;
  offeredReservations: number;
  responseBacklog: number;
  onlineAgents: number;
  availableAgents: number;
  busy: boolean;
}

export interface AgentGridRow {
  membershipId: string;
  displayName: string;
  role: string;
  effectiveStatus: EffectiveStatus;
  desiredStatus: string;
  connected: boolean;
  capacity: number;
  activeChats: number;
  collaborations: number;
  reservedOffers: number;
  loadPct: number | null;
  atCapacity: boolean;
  available: boolean;
  responseBacklog: number;
  oldestUnansweredAt: string | null;
  oldestUnansweredSeconds: number | null;
  departmentIds: string[];
}

export interface MonitorSnapshot {
  asOf: string;
  sourceWatermark: string | null;
  freshnessMs: number;
  stale: boolean;
  scope: { departmentIds: 'all' | string[]; departmentId: string | null; siteId: string | null };
  thresholds: MonitorThresholds;
  counters: {
    queued: number;
    oldestWaitSeconds: number | null;
    oldestRequestedAt: string | null;
    oldestWaitLevel: WaitLevel;
    oldestWaitWarning: boolean;
    oldestWaitCritical: boolean;
    active: number;
    availableAgents: number;
    onlineAgents: number;
    offeredReservations: number;
    responseBacklog: number;
    csat: { value: number | null; numerator: number; denominator: number; n: number; window: 'today'; windowStart: string; timezone: string };
  };
  busyDepartments: DepartmentLoad[];
  departments: DepartmentLoad[];
  agents: AgentGridRow[];
}
