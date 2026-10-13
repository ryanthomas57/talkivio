/**
 * Analytics report shapes (camelCase after wire conversion). They mirror
 * `apps/api/src/features/analytics/{analytics.service,measures,stats,export.service}.ts`.
 * Measure keys arrive camelCased inside `measures` (e.g. `firstResponseTime`),
 * while `measureKeys` / `measure.key` keep the snake_case wire names.
 */

export type MeasureKind = 'count' | 'rate' | 'duration';
export type MeasureUnit = 'chats' | 'ratings' | 'invitations' | 'submissions' | 'percent' | 'seconds';
export type ChangeLabel = 'comparable' | 'new' | 'not_comparable';
export type GroupBy = 'hour' | 'day' | 'week';

export interface MeasureValue {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  n: number;
  median?: number | null;
  p90?: number | null;
  p95?: number | null;
}

export interface MeasureChange {
  change: number | null;
  changePct: number | null;
  label: ChangeLabel;
}

export interface ReportedMeasure extends MeasureValue {
  key: string;
  label: string;
  kind: MeasureKind;
  unit: MeasureUnit;
  population: string;
  definition: string;
  nullPolicy: string;
  percentileMethod?: string;
  comparison: (MeasureValue & MeasureChange) | null;
}

export interface ReportFreshness {
  asOf: string;
  updatedAt?: string | null;
  sourceWatermark: string | null;
  lagMs: number;
  pendingFacts?: number;
  status?: 'fresh' | 'lagging';
  stale: boolean;
  source: 'facts' | 'raw';
  cached?: boolean;
}

export interface ReportRange {
  from: string;
  to: string;
  timezone: string;
  timezoneLabel: string;
  utcOffsets?: string[];
  groupBy?: GroupBy;
  halfOpen: true;
}

export interface SeriesPoint {
  key: string;
  start: string;
  end: string;
  unitHours: number;
  measures: Record<string, MeasureValue>;
}

export interface ChatsReport {
  report: 'chats';
  definitionsVersion: number;
  range: ReportRange;
  comparisonRange: { from: string; to: string } | null;
  filters: Record<string, string | null>;
  scope: { departmentIds: 'all' | string[] };
  measureKeys: string[];
  measures: Record<string, ReportedMeasure>;
  series: SeriesPoint[];
  freshness: ReportFreshness;
}

export interface Distribution {
  n: number;
  median: number | null;
  p90: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  unit?: 'seconds';
  nullPolicy?: string;
}

export interface AgentReportRow {
  membershipId: string;
  displayName: string;
  role: string;
  enabled: boolean;
  capacity: number;
  departmentIds: string[];
  handledChats: number;
  ownedSeconds: number;
  replies: number;
  repliedChats: number;
  transfersIn: number;
  transfersOut: number;
  firstResponses: number;
  firstResponseTime: Distribution;
  responseTime: Distribution;
  onlineSeconds: number;
  availableSlotSeconds: number;
  occupiedSlotSeconds: number;
  utilization: { value: number | null; raw: number | null; numerator: number; denominator: number; unit: 'percent'; cappedForReporting: boolean; invariantViolation: boolean };
  ratings: { good: number; bad: number; csat: { value: number | null; numerator: number; denominator: number; n: number } };
}

export interface AgentsReport {
  report: 'agents';
  definitionsVersion: number;
  range: ReportRange;
  filters: Record<string, string | null>;
  scope: { departmentIds: 'all' | string[] };
  definitions: Record<string, string>;
  agents: AgentReportRow[];
  totals: {
    agents: number;
    distinctChatsHandled: number;
    handledChatsSum: number;
    replies: number;
    firstResponses: number;
    ownedSeconds: number;
    onlineSeconds: number;
    availableSlotSeconds: number;
    occupiedSlotSeconds: number;
    utilization: number | null;
  };
  freshness: ReportFreshness;
}

export interface Funnel {
  eligible: number;
  displayed: number;
  accepted: number;
  served: number;
  displayRate: number | null;
  acceptanceRate: number | null;
  serveRate: number | null;
}

export interface InvitationsReport {
  report: 'invitations';
  definitionsVersion: number;
  range: ReportRange;
  filters: Record<string, string | null>;
  scope: { departmentIds: 'all' | string[] };
  definitions: Record<string, string>;
  totals: Funnel;
  campaigns: Array<Funnel & { campaignId: string; name: string | null }>;
  freshness: ReportFreshness;
}

export type ExportState = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | string;

export interface ExportResource {
  id: string;
  report: 'chats' | 'agents' | 'invitations';
  format: 'csv';
  state: ExportState;
  progress: number | null;
  attempts: number;
  filters: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  rowCount: number | null;
  bytes: number | null;
  sha256: string | null;
  filename: string | null;
  sourceWatermark: string | null;
  totals: Record<string, number | null> | null;
  errorCode: string | null;
  downloadPath: string | null;
}
