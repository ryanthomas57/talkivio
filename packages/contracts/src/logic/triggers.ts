/**
 * Trigger rules engine (pure). The API builds a TriggerContext from live state and
 * evaluates enabled triggers for an event; actions are executed by the API.
 */
import type { Priority } from '../enums';

export const TRIGGER_EVENTS = ['page_enter', 'chat_requested', 'visitor_message'] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export const TRIGGER_EVENT_LABELS: Record<TriggerEvent, string> = {
  page_enter: 'Visitor loads a page with the widget',
  chat_requested: 'Visitor starts a chat',
  visitor_message: 'Visitor sends a chat message',
};

export type FieldType = 'string' | 'number' | 'boolean' | 'list' | 'enum';

export interface TriggerFieldDef {
  key: string;
  label: string;
  type: FieldType;
  group: 'Visitor' | 'Page' | 'Chat' | 'Account' | 'Time';
  options?: Array<{ value: string; label: string }>;
  /** Value grows over time (used to schedule re-evaluation). */
  temporal?: boolean;
  events?: TriggerEvent[];
}

export const TRIGGER_FIELDS: TriggerFieldDef[] = [
  { key: 'page.url', label: 'Page URL', type: 'string', group: 'Page' },
  { key: 'page.title', label: 'Page title', type: 'string', group: 'Page' },
  { key: 'page.time_on_page', label: 'Time on page (seconds)', type: 'number', group: 'Page', temporal: true },
  { key: 'visitor.referrer', label: 'Referrer', type: 'string', group: 'Visitor' },
  { key: 'visitor.landing_page', label: 'Landing page', type: 'string', group: 'Visitor' },
  { key: 'visitor.search_terms', label: 'Search terms', type: 'string', group: 'Visitor' },
  { key: 'visitor.name', label: 'Visitor name', type: 'string', group: 'Visitor' },
  { key: 'visitor.email', label: 'Visitor email', type: 'string', group: 'Visitor' },
  { key: 'visitor.tags', label: 'Visitor tags', type: 'list', group: 'Visitor' },
  { key: 'visitor.country_code', label: 'Country code (ISO)', type: 'string', group: 'Visitor' },
  { key: 'visitor.city', label: 'City', type: 'string', group: 'Visitor' },
  { key: 'visitor.language', label: 'Browser language', type: 'string', group: 'Visitor' },
  {
    key: 'visitor.device_type',
    label: 'Device type',
    type: 'enum',
    group: 'Visitor',
    options: [
      { value: 'desktop', label: 'Desktop' },
      { value: 'mobile', label: 'Mobile' },
      { value: 'tablet', label: 'Tablet' },
    ],
  },
  { key: 'visitor.browser', label: 'Browser', type: 'string', group: 'Visitor' },
  { key: 'visitor.os', label: 'Operating system', type: 'string', group: 'Visitor' },
  { key: 'visitor.visit_count', label: 'Number of visits', type: 'number', group: 'Visitor' },
  { key: 'visitor.page_views', label: 'Pages viewed this visit', type: 'number', group: 'Visitor' },
  { key: 'visitor.time_on_site', label: 'Time on site (seconds)', type: 'number', group: 'Visitor', temporal: true },
  { key: 'visitor.is_returning', label: 'Returning visitor', type: 'boolean', group: 'Visitor' },
  { key: 'visitor.previous_chats', label: 'Previous chats', type: 'number', group: 'Visitor' },
  { key: 'visitor.is_chatting', label: 'Currently chatting', type: 'boolean', group: 'Chat' },
  { key: 'chat.message', label: 'Chat message text', type: 'string', group: 'Chat', events: ['chat_requested', 'visitor_message'] },
  { key: 'chat.department_id', label: 'Chat department', type: 'string', group: 'Chat' },
  { key: 'chat.served', label: 'Chat is being served', type: 'boolean', group: 'Chat' },
  { key: 'chat.wait_time', label: 'Seconds waiting for an agent', type: 'number', group: 'Chat', temporal: true, events: ['chat_requested', 'visitor_message'] },
  { key: 'account.online', label: 'Account is online', type: 'boolean', group: 'Account' },
  { key: 'account.online_agents', label: 'Online agents', type: 'number', group: 'Account' },
  { key: 'department.online', label: 'Selected department is online', type: 'boolean', group: 'Account' },
  { key: 'website.id', label: 'Website', type: 'string', group: 'Account' },
  { key: 'time.hour', label: 'Hour of day (0–23)', type: 'number', group: 'Time' },
  {
    key: 'time.day_of_week',
    label: 'Day of week',
    type: 'enum',
    group: 'Time',
    options: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => ({ value: d, label: d.toUpperCase() })),
  },
];

export const TRIGGER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_true',
  'is_false',
  'includes',
  'excludes',
  'is_set',
  'not_set',
] as const;
export type TriggerOperator = (typeof TRIGGER_OPERATORS)[number];

export const OPERATOR_LABELS: Record<TriggerOperator, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  matches: 'matches regex',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  is_true: 'is true',
  is_false: 'is false',
  includes: 'includes',
  excludes: 'does not include',
  is_set: 'is present',
  not_set: 'is empty',
};

export const OPERATORS_BY_TYPE: Record<FieldType, TriggerOperator[]> = {
  string: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'matches', 'is_set', 'not_set'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['is_true', 'is_false'],
  list: ['includes', 'excludes', 'is_set', 'not_set'],
  enum: ['eq', 'neq'],
};

export interface TriggerCondition {
  field: string;
  operator: TriggerOperator;
  value?: string | number | boolean | null;
}

export interface TriggerConditions {
  match: 'all' | 'any';
  rules: TriggerCondition[];
}

export type TriggerAction =
  | { type: 'send_message'; senderName: string; message: string }
  | { type: 'wait'; seconds: number }
  | { type: 'set_name'; name: string }
  | { type: 'add_tags'; tags: string[] }
  | { type: 'remove_tags'; tags: string[] }
  | { type: 'set_department'; departmentId: string }
  | { type: 'set_priority'; priority: Priority }
  | { type: 'add_note'; note: string }
  | { type: 'open_widget' }
  | { type: 'ban_visitor'; reason: string };

export type TriggerActionType = TriggerAction['type'];

export const TRIGGER_ACTION_LABELS: Record<TriggerActionType, string> = {
  send_message: 'Send message to visitor',
  wait: 'Wait',
  set_name: 'Set visitor name',
  add_tags: 'Add tags',
  remove_tags: 'Remove tags',
  set_department: 'Set department',
  set_priority: 'Set chat priority',
  add_note: 'Append visitor note',
  open_widget: 'Open the chat window',
  ban_visitor: 'Ban visitor',
};

export const TRIGGER_RUN_MODES = ['always', 'once_per_visitor', 'once_per_session'] as const;
export type TriggerRunMode = (typeof TRIGGER_RUN_MODES)[number];

export type TriggerContextValues = Record<string, string | number | boolean | string[] | null | undefined>;

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const regexCache = new Map<string, RegExp | null>();
function safeRegex(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  // Guard against pathological patterns: cap length and reject nested quantifiers.
  if (src.length <= 200 && !/(\+|\*|\{\d+,?\d*\})\)(\+|\*|\{)/.test(src)) {
    try {
      re = new RegExp(src, 'i');
    } catch {
      re = null;
    }
  }
  regexCache.set(src, re);
  return re;
}

export function evaluateCondition(rule: TriggerCondition, ctx: TriggerContextValues): boolean {
  const actual = ctx[rule.field];
  const expected = rule.value;
  const a = toStr(actual).toLowerCase();
  const e = toStr(expected).toLowerCase();
  switch (rule.operator) {
    case 'eq':
      if (typeof actual === 'number') return actual === toNum(expected);
      return a === e;
    case 'neq':
      if (typeof actual === 'number') return actual !== toNum(expected);
      return a !== e;
    case 'contains':
      return e.length > 0 && a.includes(e);
    case 'not_contains':
      return !a.includes(e) || e.length === 0;
    case 'starts_with':
      return a.startsWith(e);
    case 'ends_with':
      return a.endsWith(e);
    case 'matches': {
      const re = safeRegex(toStr(expected));
      return re ? re.test(toStr(actual)) : false;
    }
    case 'gt':
      return toNum(actual) > toNum(expected);
    case 'gte':
      return toNum(actual) >= toNum(expected);
    case 'lt':
      return toNum(actual) < toNum(expected);
    case 'lte':
      return toNum(actual) <= toNum(expected);
    case 'is_true':
      return actual === true || a === 'true';
    case 'is_false':
      return !(actual === true || a === 'true');
    case 'includes':
      return Array.isArray(actual) ? actual.some((t) => t.toLowerCase() === e) : a.split(',').includes(e);
    case 'excludes':
      return Array.isArray(actual) ? !actual.some((t) => t.toLowerCase() === e) : !a.split(',').includes(e);
    case 'is_set':
      return Array.isArray(actual) ? actual.length > 0 : a.length > 0;
    case 'not_set':
      return Array.isArray(actual) ? actual.length === 0 : a.length === 0;
    default:
      return false;
  }
}

export function evaluateConditions(conditions: TriggerConditions, ctx: TriggerContextValues): boolean {
  if (!conditions.rules.length) return true;
  return conditions.match === 'all'
    ? conditions.rules.every((r) => evaluateCondition(r, ctx))
    : conditions.rules.some((r) => evaluateCondition(r, ctx));
}

/**
 * For temporal fields (time on page / site), work out how many seconds from now the
 * failing rules could start passing, so the engine can schedule a re-evaluation.
 * Returns null when waiting would not help.
 */
export function secondsUntilTemporalMatch(conditions: TriggerConditions, ctx: TriggerContextValues): number | null {
  const temporal = new Set(TRIGGER_FIELDS.filter((f) => f.temporal).map((f) => f.key));
  let maxWait = 0;
  let anyTemporal = false;
  for (const rule of conditions.rules) {
    if (!temporal.has(rule.field)) {
      const ok = evaluateCondition(rule, ctx);
      if (conditions.match === 'all' && !ok) return null;
      if (conditions.match === 'any' && ok) return 0;
      continue;
    }
    if (evaluateCondition(rule, ctx)) {
      if (conditions.match === 'any') return 0;
      continue;
    }
    if (rule.operator !== 'gt' && rule.operator !== 'gte' && rule.operator !== 'eq') {
      if (conditions.match === 'all') return null;
      continue;
    }
    anyTemporal = true;
    const current = toNum(ctx[rule.field]);
    const target = toNum(rule.value) + (rule.operator === 'gt' ? 1 : 0);
    const wait = Math.max(0, target - (Number.isFinite(current) ? current : 0));
    if (conditions.match === 'all') maxWait = Math.max(maxWait, wait);
    else maxWait = maxWait === 0 ? wait : Math.min(maxWait, wait);
  }
  if (!anyTemporal) return null;
  return maxWait > 0 && maxWait <= 3600 ? maxWait : null;
}

/** Extract search keywords from a search-engine referrer, when present. */
export function extractSearchTerms(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    for (const key of ['q', 'query', 'p', 'text', 'wd']) {
      const v = u.searchParams.get(key);
      if (v) return v;
    }
  } catch {
    return null;
  }
  return null;
}
