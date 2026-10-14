/**
 * Measure catalogue and aggregation for the chats report (ch. 50/51). Every
 * measure carries its population, numerator, denominator, null policy and unit
 * so the UI can document it next to the number and exports can repeat it.
 */
import type { FactView } from './facts';
import { compare, distribution, percent, PERCENTILE_METHOD, type Change } from './stats';

export const MEASURE_KEYS = [
  'requested',
  'assigned',
  'served',
  'missed',
  'abandoned',
  'quick_cancellations',
  'missed_rate',
  'abandoned_rate',
  'wait_to_assignment',
  'first_response_time',
  'service_response_time',
  'chat_duration',
  'ratings_good',
  'ratings_bad',
  'csat',
  'response_rate',
  'invitations_displayed',
  'invitations_accepted',
  'offline_submissions',
] as const;
export type MeasureKey = (typeof MEASURE_KEYS)[number];
export type MeasureKind = 'count' | 'rate' | 'duration';

export interface MeasureDefinition {
  label: string;
  kind: MeasureKind;
  unit: 'chats' | 'ratings' | 'invitations' | 'submissions' | 'percent' | 'seconds';
  population: string;
  definition: string;
  nullPolicy: string;
}

export const DEFINITIONS_VERSION = 1;

const CHAT_POP = 'Chats with requested_at in [from, to), preview chats excluded';
export const MEASURE_DEFINITIONS: Record<MeasureKey, MeasureDefinition> = {
  requested: {
    label: 'Requested chats',
    kind: 'count',
    unit: 'chats',
    population: CHAT_POP,
    definition: 'Count of admitted chat requests.',
    nullPolicy: 'zero_when_no_events',
  },
  assigned: {
    label: 'Assigned chats',
    kind: 'count',
    unit: 'chats',
    population: CHAT_POP,
    definition: 'Chats with first_assigned_at set. Assigned is not served.',
    nullPolicy: 'zero_when_no_events',
  },
  served: {
    label: 'Served chats',
    kind: 'count',
    unit: 'chats',
    population: CHAT_POP,
    definition:
      'Chats with at least one human agent public message (automated messages and internal notes excluded).',
    nullPolicy: 'zero_when_no_events',
  },
  missed: {
    label: 'Missed chats',
    kind: 'count',
    unit: 'chats',
    population: CHAT_POP,
    definition:
      'Closed chats without a human public response after admission. Overlaps abandoned. Visitor cancellations within 10 s are excluded only when the workspace setting analytics.excludeQuickCancellations is on (see quick_cancellations).',
    nullPolicy: 'zero_when_no_events',
  },
  abandoned: {
    label: 'Abandoned chats',
    kind: 'count',
    unit: 'chats',
    population: CHAT_POP,
    definition:
      'Chats the visitor ended, or whose reconnect grace expired, before first assignment. May overlap missed; never add the two.',
    nullPolicy: 'zero_when_no_events',
  },
  quick_cancellations: {
    label: 'Quick visitor cancellations',
    kind: 'count',
    unit: 'chats',
    population: CHAT_POP,
    definition:
      'Visitor ended the chat within 10 s of requesting it, before assignment (disclosed separately).',
    nullPolicy: 'zero_when_no_events',
  },
  missed_rate: {
    label: 'Missed rate',
    kind: 'rate',
    unit: 'percent',
    population: CHAT_POP,
    definition: 'missed ÷ requested × 100.',
    nullPolicy: 'null_when_denominator_zero',
  },
  abandoned_rate: {
    label: 'Abandoned rate',
    kind: 'rate',
    unit: 'percent',
    population: CHAT_POP,
    definition: 'abandoned ÷ requested × 100.',
    nullPolicy: 'null_when_denominator_zero',
  },
  wait_to_assignment: {
    label: 'Wait to assignment',
    kind: 'duration',
    unit: 'seconds',
    population: `${CHAT_POP}; assigned chats only`,
    definition:
      'first_assigned_at − requested_at. Count, median, p90 and p95 from ordered durations (nearest rank).',
    nullPolicy: 'unassigned_excluded_null_when_no_samples',
  },
  first_response_time: {
    label: 'First response time',
    kind: 'duration',
    unit: 'seconds',
    population: `${CHAT_POP}; served chats only`,
    definition:
      'First human agent public message − requested_at (includes queue time). Automated greetings and notes never stop the timer.',
    nullPolicy: 'unanswered_excluded_null_when_no_samples',
  },
  service_response_time: {
    label: 'Service response time',
    kind: 'duration',
    unit: 'seconds',
    population: `${CHAT_POP}; assigned and served chats`,
    definition: 'First human agent public message − first_assigned_at (queue time excluded).',
    nullPolicy: 'unanswered_excluded_null_when_no_samples',
  },
  chat_duration: {
    label: 'Chat duration',
    kind: 'duration',
    unit: 'seconds',
    population: `${CHAT_POP}; closed chats only`,
    definition: 'closed_at − requested_at.',
    nullPolicy: 'open_chats_excluded_null_when_no_samples',
  },
  ratings_good: {
    label: 'Good ratings',
    kind: 'count',
    unit: 'ratings',
    population: CHAT_POP,
    definition: 'Chats whose latest rating is good.',
    nullPolicy: 'zero_when_no_events',
  },
  ratings_bad: {
    label: 'Bad ratings',
    kind: 'count',
    unit: 'ratings',
    population: CHAT_POP,
    definition: 'Chats whose latest rating is bad.',
    nullPolicy: 'zero_when_no_events',
  },
  csat: {
    label: 'Customer satisfaction',
    kind: 'rate',
    unit: 'percent',
    population: `${CHAT_POP}; rated chats only`,
    definition:
      'Latest good ratings ÷ (latest good + bad ratings) × 100. Unrated chats excluded; a changed rating counts once.',
    nullPolicy: 'null_when_no_ratings',
  },
  response_rate: {
    label: 'Rating response rate',
    kind: 'rate',
    unit: 'percent',
    population: `${CHAT_POP}; served chats`,
    definition: 'Served chats with a rating ÷ served chats × 100.',
    nullPolicy: 'null_when_no_served_chats',
  },
  invitations_displayed: {
    label: 'Invitations displayed',
    kind: 'count',
    unit: 'invitations',
    population: 'Distinct invitations with displayed_at in [from, to)',
    definition:
      'Proactive invitations shown to visitors. Agent and tag filters do not apply (null when set).',
    nullPolicy: 'null_when_filter_not_applicable',
  },
  invitations_accepted: {
    label: 'Invitations accepted',
    kind: 'count',
    unit: 'invitations',
    population: CHAT_POP,
    definition: 'Distinct invitations whose accepted chat is in the chat population.',
    nullPolicy: 'zero_when_no_events',
  },
  offline_submissions: {
    label: 'Offline submissions',
    kind: 'count',
    unit: 'submissions',
    population: 'Offline form submissions with created_at in [from, to), a separate population from chats',
    definition: 'Count of offline submissions. Agent and tag filters do not apply (null when set).',
    nullPolicy: 'null_when_filter_not_applicable',
  },
};

export interface MeasureValue {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  n: number;
  median?: number | null;
  p90?: number | null;
  p95?: number | null;
}

export type MeasureSet = Record<MeasureKey, MeasureValue>;

export interface AggregateOptions {
  excludeQuickCancellations: boolean;
}

const count = (n: number): MeasureValue => ({ value: n, numerator: n, denominator: null, n });
const nullable = (n: number | null): MeasureValue => ({
  value: n,
  numerator: n,
  denominator: null,
  n: n ?? 0,
});
const rate = (num: number, den: number): MeasureValue => ({
  value: percent(num, den),
  numerator: num,
  denominator: den,
  n: den,
});
const sec = (a: number, b: number) => (b - a) / 1000;

function dur(values: number[]): MeasureValue {
  const d = distribution(values);
  return {
    value: d.median,
    numerator: null,
    denominator: null,
    n: d.n,
    median: d.median,
    p90: d.p90,
    p95: d.p95,
  };
}

/**
 * Aggregate one population. `offline`/`invitationsDisplayed` are counts from
 * their own populations, or null when the active filters do not apply to them.
 */
export function aggregate(
  facts: readonly FactView[],
  offline: number | null,
  invitationsDisplayed: number | null,
  opts: AggregateOptions,
): MeasureSet {
  let assigned = 0;
  let served = 0;
  let missed = 0;
  let abandoned = 0;
  let quick = 0;
  let good = 0;
  let bad = 0;
  let servedRated = 0;
  const wait: number[] = [];
  const first: number[] = [];
  const service: number[] = [];
  const duration: number[] = [];
  const invitations = new Set<string>();
  for (const f of facts) {
    if (f.firstAssignedAt !== null) {
      assigned++;
      wait.push(sec(f.requestedAt, f.firstAssignedAt));
    }
    if (f.served) {
      served++;
      if (f.firstResponseAt !== null) {
        first.push(sec(f.requestedAt, f.firstResponseAt));
        if (f.firstAssignedAt !== null && f.firstResponseAt >= f.firstAssignedAt)
          service.push(sec(f.firstAssignedAt, f.firstResponseAt));
      }
      if (f.rating) servedRated++;
    }
    if (f.quickCancel) quick++;
    if (f.missed && !(opts.excludeQuickCancellations && f.quickCancel)) missed++;
    if (f.abandoned) abandoned++;
    if (f.closedAt !== null) duration.push(sec(f.requestedAt, f.closedAt));
    if (f.rating === 'good') good++;
    else if (f.rating === 'bad') bad++;
    if (f.invitationId) invitations.add(f.invitationId);
  }
  const requested = facts.length;
  return {
    requested: count(requested),
    assigned: count(assigned),
    served: count(served),
    missed: count(missed),
    abandoned: count(abandoned),
    quick_cancellations: count(quick),
    missed_rate: rate(missed, requested),
    abandoned_rate: rate(abandoned, requested),
    wait_to_assignment: dur(wait),
    first_response_time: dur(first),
    service_response_time: dur(service),
    chat_duration: dur(duration),
    ratings_good: count(good),
    ratings_bad: count(bad),
    csat: rate(good, good + bad),
    response_rate: rate(servedRated, served),
    invitations_displayed: nullable(invitationsDisplayed),
    invitations_accepted: count(invitations.size),
    offline_submissions: nullable(offline),
  };
}

export interface ReportedMeasure extends MeasureValue, MeasureDefinition {
  key: MeasureKey;
  percentileMethod?: string;
  comparison: (MeasureValue & Change) | null;
}

/** Combine the current and previous period with definitions and change labels. */
export function describe(
  current: MeasureSet,
  previous: MeasureSet | null,
): Record<MeasureKey, ReportedMeasure> {
  const out = {} as Record<MeasureKey, ReportedMeasure>;
  for (const key of MEASURE_KEYS) {
    const def = MEASURE_DEFINITIONS[key];
    const cur = current[key];
    let comparison: ReportedMeasure['comparison'] = null;
    if (previous) {
      const prev = previous[key];
      const base = (m: MeasureValue) =>
        def.kind === 'count' ? (m.value ?? 0) : def.kind === 'rate' ? (m.denominator ?? 0) : m.n;
      comparison = { ...prev, ...compare(cur.value, prev.value, base(prev), base(cur)) };
    }
    out[key] = {
      key,
      ...def,
      ...cur,
      ...(def.kind === 'duration' ? { percentileMethod: PERCENTILE_METHOD } : {}),
      comparison,
    };
  }
  return out;
}
