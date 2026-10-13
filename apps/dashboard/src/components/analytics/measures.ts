/**
 * Presentation helpers for analytics measures (ch. 50/51): value formatting by
 * kind, numerator/denominator wording, null-policy explanations and
 * period-over-period change text. Definitions themselves always come from the
 * API response — nothing here invents a number. Copy comes from the 'analytics'
 * catalog (tStatic follows the UI locale during render).
 */
import { tStatic as t, type MessageKey } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { toCamelKey } from '@/lib/wire';
import type { ChatsReport, MeasureKind, MeasureUnit, MeasureValue, ReportedMeasure } from './types';

export type MeasureGroup = 'volume' | 'rates' | 'speed' | 'quality' | 'invitations' | 'other';

const GROUP_OF: Record<string, MeasureGroup> = {
  requested: 'volume',
  assigned: 'volume',
  served: 'volume',
  missed: 'volume',
  abandoned: 'volume',
  quick_cancellations: 'volume',
  offline_submissions: 'volume',
  missed_rate: 'rates',
  abandoned_rate: 'rates',
  wait_to_assignment: 'speed',
  first_response_time: 'speed',
  service_response_time: 'speed',
  chat_duration: 'speed',
  csat: 'quality',
  response_rate: 'quality',
  ratings_good: 'quality',
  ratings_bad: 'quality',
  invitations_displayed: 'invitations',
  invitations_accepted: 'invitations',
};

/** Message keys: render with t(). `description` is null when the group has none. */
export const GROUP_LABELS: Record<MeasureGroup, { title: MessageKey; description: MessageKey | null }> = {
  volume: { title: 'analytics.group.volume', description: 'analytics.group.volumeHint' },
  rates: { title: 'analytics.group.rates', description: 'analytics.group.ratesHint' },
  speed: { title: 'analytics.group.speed', description: 'analytics.group.speedHint' },
  quality: { title: 'analytics.group.quality', description: 'analytics.group.qualityHint' },
  invitations: { title: 'analytics.group.invitations', description: 'analytics.group.invitationsHint' },
  other: { title: 'analytics.group.other', description: null },
};

export const GROUP_ORDER: MeasureGroup[] = ['volume', 'rates', 'speed', 'quality', 'invitations', 'other'];

/** Dashboard labels by snake_case wire key; unknown measures fall back to the API label. */
const MEASURE_LABEL: Record<string, MessageKey> = {
  requested: 'analytics.measure.requested',
  assigned: 'analytics.measure.assigned',
  served: 'analytics.measure.served',
  missed: 'analytics.measure.missed',
  abandoned: 'analytics.measure.abandoned',
  quick_cancellations: 'analytics.measure.quickCancellations',
  missed_rate: 'analytics.measure.missedRate',
  abandoned_rate: 'analytics.measure.abandonedRate',
  wait_to_assignment: 'analytics.measure.waitToAssignment',
  first_response_time: 'analytics.measure.firstResponseTime',
  service_response_time: 'analytics.measure.serviceResponseTime',
  chat_duration: 'analytics.measure.chatDuration',
  ratings_good: 'analytics.measure.ratingsGood',
  ratings_bad: 'analytics.measure.ratingsBad',
  csat: 'analytics.measure.csat',
  response_rate: 'analytics.measure.responseRate',
  invitations_displayed: 'analytics.measure.invitationsDisplayed',
  invitations_accepted: 'analytics.measure.invitationsAccepted',
  offline_submissions: 'analytics.measure.offlineSubmissions',
};

export function measureLabel(m: Pick<ReportedMeasure, 'key' | 'label'>): string {
  const key = MEASURE_LABEL[m.key];
  return key ? t(key) : m.label;
}

export function groupOf(wireKey: string): MeasureGroup {
  return GROUP_OF[wireKey] ?? 'other';
}

/** Look up a measure by its snake_case wire key (response objects are camelCased). */
export function measureOf(report: Pick<ChatsReport, 'measures'>, wireKey: string): ReportedMeasure | undefined {
  return report.measures[toCamelKey(wireKey)];
}

export function seriesValue(measures: Record<string, MeasureValue>, wireKey: string): MeasureValue | undefined {
  return measures[toCamelKey(wireKey)];
}

const pad2 = (n: number) => formatNumber(n, { minimumIntegerDigits: 2 });

/** "2m 41s", "42 s", "4.2 s", "1h 05m". */
export function formatSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (s < 10) return t('analytics.dur.s', { s: formatNumber(Math.round(s * 10) / 10) });
  const total = Math.round(s);
  if (total < 60) return t('analytics.dur.s', { s: formatNumber(total) });
  const m = Math.floor(total / 60);
  if (m < 60) return t('analytics.dur.ms', { m: formatNumber(m), s: pad2(total % 60) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('analytics.dur.hm', { h: formatNumber(h), m: pad2(m % 60) });
  return t('analytics.dur.dh', { d: formatNumber(Math.floor(h / 24)), h: formatNumber(h % 24) });
}

/** Spoken duration for assistive tech: "2 minutes 41 seconds". */
export function spokenSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return t('analytics.spoken.none');
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const parts: string[] = [];
  if (h) parts.push(t('analytics.spoken.hours', { n: h }));
  if (m) parts.push(t('analytics.spoken.minutes', { n: m }));
  if (sec || !parts.length) parts.push(t('analytics.spoken.seconds', { n: s < 10 ? Math.round(s * 10) / 10 : sec }));
  return parts.join(t('analytics.spoken.joiner'));
}

/** A 0–100 percentage in the UI locale: "42.5%". */
export function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return formatNumber(v / 100, { style: 'percent', maximumFractionDigits: 1 });
}

export function formatValue(kind: MeasureKind, v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (kind === 'rate') return formatPct(v);
  if (kind === 'duration') return formatSeconds(v);
  return formatNumber(v);
}

const UNIT_LABEL: Partial<Record<MeasureUnit, MessageKey>> = {
  chats: 'analytics.unit.chats',
  ratings: 'analytics.unit.ratings',
  invitations: 'analytics.unit.invitations',
  submissions: 'analytics.unit.submissions',
};

export function unitLabel(unit: MeasureUnit, value: number | null, kind: MeasureKind): string {
  if (kind === 'duration') return t('analytics.unit.median');
  if (unit === 'percent') return '';
  const key = UNIT_LABEL[unit];
  return key ? t(key, { count: value ?? 0 }) : unit;
}

const RATIO: Record<string, MessageKey> = {
  missed_rate: 'analytics.ratio.missedRate',
  abandoned_rate: 'analytics.ratio.abandonedRate',
  csat: 'analytics.ratio.csat',
  response_rate: 'analytics.ratio.responseRate',
};

/** "1 good ÷ 3 rated" for rates. */
export function ratioText(m: { key: string; numerator: number | null; denominator: number | null }): string {
  return t(RATIO[m.key] ?? 'analytics.ratio.plain', { num: formatNumber(m.numerator ?? 0), den: formatNumber(m.denominator ?? 0) });
}

const NULL_POLICY_TEXT: Record<string, MessageKey> = {
  zero_when_no_events: 'analytics.nullPolicy.zeroWhenNoEvents',
  null_when_denominator_zero: 'analytics.nullPolicy.denominatorZero',
  unassigned_excluded_null_when_no_samples: 'analytics.nullPolicy.unassignedExcluded',
  unanswered_excluded_null_when_no_samples: 'analytics.nullPolicy.unansweredExcluded',
  open_chats_excluded_null_when_no_samples: 'analytics.nullPolicy.openExcluded',
  null_when_no_ratings: 'analytics.nullPolicy.noRatings',
  null_when_no_served_chats: 'analytics.nullPolicy.noServedChats',
  null_when_filter_not_applicable: 'analytics.nullPolicy.filterNotApplicable',
  null_when_no_samples: 'analytics.nullPolicy.noSamples',
};

/** Known policies are explained in the UI language; an unknown policy code is shown as-is. */
export function nullPolicyText(policy: string): string {
  const key = NULL_POLICY_TEXT[policy];
  return key ? t(key) : policy.replace(/_/g, ' ');
}

export interface ChangeInfo {
  direction: 'up' | 'down' | 'flat';
  text: string;
  detail: string;
}

const signOf = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±');

function absChange(kind: MeasureKind, change: number): string {
  const sign = signOf(change);
  const v = Math.abs(change);
  if (kind === 'rate') return t('analytics.change.pts', { value: `${sign}${formatNumber(v, { maximumFractionDigits: 1 })}` });
  if (kind === 'duration') return `${sign}${formatSeconds(v)}`;
  return `${sign}${formatNumber(v)}`;
}

/**
 * Period-over-period change (ch. 51): percent only when the previous base is
 * non-zero; "new" when the previous period had no data; otherwise nothing or the
 * absolute difference with the reason no percentage is shown.
 */
export function changeInfo(m: ReportedMeasure): ChangeInfo | null {
  const c = m.comparison;
  if (!c) return null;
  const prevValue = formatValue(m.kind, c.value);
  const prev = m.kind === 'duration' ? t('analytics.change.valueWithN', { value: prevValue, n: c.n }) : prevValue;
  if (c.label === 'comparable' && c.changePct !== null) {
    const direction = c.changePct > 0 ? 'up' : c.changePct < 0 ? 'down' : 'flat';
    const pct = `${signOf(c.changePct)}${formatNumber(Math.abs(c.changePct) / 100, { style: 'percent', maximumFractionDigits: 1 })}`;
    return {
      direction,
      text: t('analytics.change.pctVsPrevious', { change: pct }),
      detail: c.change !== null ? t('analytics.change.detailWithAbs', { abs: absChange(m.kind, c.change), prev }) : t('analytics.change.detail', { prev }),
    };
  }
  if (c.label === 'new') {
    if (m.value === null || m.value === 0) return null;
    return { direction: 'flat', text: t('analytics.change.newThisPeriod'), detail: t('analytics.change.detailNew', { prev }) };
  }
  if (c.change !== null && c.change !== 0) {
    return { direction: c.change > 0 ? 'up' : 'down', text: t('analytics.change.pctVsPrevious', { change: absChange(m.kind, c.change) }), detail: t('analytics.change.detailZero', { prev }) };
  }
  return null;
}
