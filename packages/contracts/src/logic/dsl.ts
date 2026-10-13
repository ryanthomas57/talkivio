/**
 * Trigger DSL v1 (ch. 32/33): strict validator + pure, deterministic interpreter.
 *
 * The same functions run in the API engine (production), the simulator endpoint
 * and the dashboard editor, so a simulation can never disagree with production.
 * There is no eval, no user-supplied regular expression and no I/O here: the
 * caller passes an immutable snapshot of authoritative server state.
 *
 * Wire/storage format is snake_case JSON exactly as documented in ch. 32, e.g.
 *   {"dsl_version":1,"event":"chat.requested","priority":100,
 *    "all":[{"field":"page.path","op":"starts_with","value":"/pricing"}],
 *    "any":[],"actions":[{"type":"add_tag","tag":"pricing"}],
 *    "stop_processing":true,"cooldown_seconds":0}
 */

export const DSL_VERSION = 1 as const;
/** Causation depth limit (ch. 33): events caused by trigger effects deeper than this are not evaluated. */
export const DSL_MAX_DEPTH = 3;
export const DSL_MAX_ACTIONS = 20;
export const DSL_MAX_CONDITIONS = 50;
export const DSL_MAX_STRING = 2000;
export const DSL_MAX_LIST = 100;
export const DSL_PRIORITY_MAX = 1000;
export const DSL_MAX_COOLDOWN_SECONDS = 30 * 86_400;
/** Upper bound for durable timer thresholds (seconds). */
export const DSL_MAX_TIMER_SECONDS = 3600;

export const DSL_EVENTS = [
  'visitor.session.started',
  'visitor.page.changed',
  'visitor.timer.elapsed',
  'chat.requested',
  'message.created',
  'chat.queued',
  'chat.closed',
  'offline.submitted',
] as const;
export type DslEvent = (typeof DSL_EVENTS)[number];

export const DSL_EVENT_LABELS: Record<DslEvent, string> = {
  'visitor.session.started': 'Visitor starts a browsing session',
  'visitor.page.changed': 'Visitor opens a page',
  'visitor.timer.elapsed': 'Time on page / site elapsed',
  'chat.requested': 'Visitor requests a chat',
  'message.created': 'Visitor sends a message',
  'chat.queued': 'Chat enters the queue',
  'chat.closed': 'Chat ends',
  'offline.submitted': 'Offline form submitted',
};

const VISITOR_EVENTS: readonly DslEvent[] = ['visitor.session.started', 'visitor.page.changed', 'visitor.timer.elapsed'];
const CHAT_EVENTS: readonly DslEvent[] = ['chat.requested', 'message.created', 'chat.queued', 'chat.closed'];
/** Events whose chat can still be routed (set_department / set_priority / greeting). */
const PRE_ASSIGNMENT_EVENTS: readonly DslEvent[] = ['chat.requested', 'chat.queued', 'message.created'];

export const DSL_OPERATORS = ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'] as const;
export type DslOperator = (typeof DSL_OPERATORS)[number];

export type DslFieldType = 'string' | 'number' | 'boolean' | 'list' | 'id' | 'enum';
export type DslScalar = string | number | boolean;

export interface DslFieldSpec {
  key: string;
  type: DslFieldType;
  label: string;
  enumValues?: readonly string[];
  /** Events that provide the field; omitted = every event. */
  events?: readonly DslEvent[];
}

export const DSL_CHAT_STATUSES = ['queued', 'offered', 'active', 'closed'] as const;

/** Field allowlist (ch. 32). Trusted custom fields are addressed as `custom.<key>`. */
export const DSL_FIELDS: readonly DslFieldSpec[] = [
  { key: 'site.id', type: 'id', label: 'Website' },
  { key: 'department.id', type: 'id', label: 'Department' },
  { key: 'visitor.verified', type: 'boolean', label: 'Visitor identity verified' },
  { key: 'visitor.country', type: 'string', label: 'Visitor country (ISO code, when permitted)' },
  { key: 'visitor.tags', type: 'list', label: 'Visitor tags' },
  { key: 'visitor.returning', type: 'boolean', label: 'Returning visitor' },
  { key: 'page.path', type: 'string', label: 'Page path' },
  { key: 'referrer.origin', type: 'string', label: 'Referrer origin' },
  { key: 'session.time_on_site_seconds', type: 'number', label: 'Time on site (seconds)' },
  { key: 'page.visible_dwell_seconds', type: 'number', label: 'Visible time on page (seconds)' },
  { key: 'chat.wait_seconds', type: 'number', label: 'Chat wait (seconds)', events: CHAT_EVENTS },
  { key: 'chat.status', type: 'enum', label: 'Chat status', enumValues: DSL_CHAT_STATUSES, events: CHAT_EVENTS },
  { key: 'message.text', type: 'string', label: 'Visitor message text', events: ['chat.requested', 'message.created'] },
  { key: 'schedule.is_open', type: 'boolean', label: 'Within operating hours' },
  { key: 'eligible_agent_count', type: 'number', label: 'Agents available now' },
];
export const DSL_CUSTOM_PREFIX = 'custom.';
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_BY_KEY = new Map(DSL_FIELDS.map((f) => [f.key, f]));

const OPS_BY_TYPE: Record<DslFieldType, readonly DslOperator[]> = {
  string: ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'exists', 'missing'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'exists', 'missing'],
  boolean: ['eq', 'neq', 'exists', 'missing'],
  list: ['contains', 'in', 'not_in', 'exists', 'missing'],
  id: ['eq', 'neq', 'in', 'not_in', 'exists', 'missing'],
  enum: ['eq', 'neq', 'in', 'not_in', 'exists', 'missing'],
};
export function dslOperatorsFor(type: DslFieldType): readonly DslOperator[] {
  return OPS_BY_TYPE[type];
}

export interface DslCondition {
  field: string;
  op: DslOperator;
  value?: DslScalar | DslScalar[];
  /** Case-insensitive comparison for string operators. */
  ignore_case?: boolean;
}

export type DslTagTarget = 'chat' | 'visitor';

export type DslAction =
  | { type: 'set_department'; department_id: string }
  | { type: 'set_priority'; priority: number }
  | { type: 'add_tag'; tag: string; target: DslTagTarget }
  | { type: 'remove_tag'; tag: string; target: DslTagTarget }
  | { type: 'send_public_message'; text: string; attribution: string }
  | {
      type: 'display_invitation';
      message: string;
      attribution: string;
      department_id: string | null;
      expires_in_seconds: number;
      max_per_session: number;
      dismiss_cooldown_hours: number;
    }
  | { type: 'set_visitor_field'; key: string; value: DslScalar | null }
  | { type: 'notify_department'; department_id: string; text: string }
  | { type: 'create_webhook_job'; event_name: string }
  | { type: 'block_admission'; reason: string };
export type DslActionType = DslAction['type'];

export const DSL_ACTION_TYPES = [
  'set_department',
  'set_priority',
  'add_tag',
  'remove_tag',
  'send_public_message',
  'display_invitation',
  'set_visitor_field',
  'notify_department',
  'create_webhook_job',
  'block_admission',
] as const satisfies readonly DslActionType[];

export const DSL_ACTION_LABELS: Record<DslActionType, string> = {
  set_department: 'Route to department',
  set_priority: 'Set queue priority',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  send_public_message: 'Send automated message',
  display_invitation: 'Show chat invitation',
  set_visitor_field: 'Set visitor field',
  notify_department: 'Notify department',
  create_webhook_job: 'Send webhook event',
  block_admission: 'Block chat admission',
};

const ALL_EVENTS: readonly DslEvent[] = DSL_EVENTS;
/** Events on which each action is meaningful (validated on save/publish). */
export const DSL_ACTION_EVENTS: Record<DslActionType, readonly DslEvent[]> = {
  set_department: PRE_ASSIGNMENT_EVENTS,
  set_priority: PRE_ASSIGNMENT_EVENTS,
  add_tag: ALL_EVENTS,
  remove_tag: ALL_EVENTS,
  send_public_message: PRE_ASSIGNMENT_EVENTS,
  display_invitation: VISITOR_EVENTS,
  set_visitor_field: ALL_EVENTS,
  notify_department: ALL_EVENTS,
  create_webhook_job: ALL_EVENTS,
  block_admission: ['chat.requested', 'message.created'],
};

/** Actions that reach the visitor or change routing; suppressed by a terminal block_admission. */
const BLOCKED_BY_ADMISSION_BLOCK: ReadonlySet<DslActionType> = new Set(['send_public_message', 'display_invitation', 'set_department', 'set_priority']);

export interface DslDefinition {
  dsl_version: 1;
  event: DslEvent;
  priority: number;
  all: DslCondition[];
  any: DslCondition[];
  actions: DslAction[];
  stop_processing: boolean;
  cooldown_seconds: number;
}

/** Flat map of allowlisted field → value; `null`/absent means missing. */
export type DslSnapshot = Readonly<Record<string, DslScalar | readonly string[] | null | undefined>>;

// ─────────────────────────── Validation ───────────────────────────

export interface DslIssue {
  path: string;
  code: string;
  message: string;
}

export interface DslCustomFieldDef {
  type: 'string' | 'number' | 'boolean';
  /** Trusted = not writable by the visitor's browser. Only trusted fields may be used. */
  trusted: boolean;
}

/** Tenant-scoped reference data; when supplied every referenced id must be in these sets. */
export interface DslValidationContext {
  departmentIds?: Iterable<string>;
  siteIds?: Iterable<string>;
  customFields?: Record<string, DslCustomFieldDef>;
}

export type DslValidationResult = { ok: true; definition: DslDefinition; issues: [] } | { ok: false; issues: DslIssue[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isFiniteNumber(v) && Number.isInteger(v);

/** Count Unicode code points (limits are code points, not UTF-16 units). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function hasControlChars(s: string, allowNewlines: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7f) return true;
    if (c < 0x20 && !(allowNewlines && (c === 0x0a || c === 0x0d || c === 0x09))) return true;
  }
  return false;
}

class Issues {
  readonly list: DslIssue[] = [];
  add(path: string, code: string, message: string): void {
    if (this.list.length < 100) this.list.push({ path, code, message });
  }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, issues: Issues): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.add(path ? `${path}.${k}` : k, 'unknown_key', `Unknown key "${k}"`);
}

function toSet(it: Iterable<string> | undefined): Set<string> | null {
  if (!it) return null;
  return new Set([...it].map((x) => x.toLowerCase()));
}

/** Resolve the type of a field for an event; returns an error code when not allowed. */
export function dslFieldType(
  field: string,
  event: DslEvent | null,
  ctx?: DslValidationContext,
  operand?: unknown,
): { type: DslFieldType; custom: boolean } | { error: string; message: string } {
  const spec = FIELD_BY_KEY.get(field);
  if (spec) {
    if (event && spec.events && !spec.events.includes(event)) return { error: 'field_unavailable', message: `"${field}" is not available for ${event}` };
    return { type: spec.type, custom: false };
  }
  if (field.startsWith(DSL_CUSTOM_PREFIX)) {
    const key = field.slice(DSL_CUSTOM_PREFIX.length);
    if (!CUSTOM_KEY_RE.test(key)) return { error: 'unknown_field', message: `"${field}" is not a valid custom field` };
    if (ctx?.customFields) {
      const def = ctx.customFields[key];
      if (!def) return { error: 'unknown_field', message: `Custom field "${key}" does not exist` };
      if (!def.trusted) return { error: 'untrusted_field', message: `Custom field "${key}" can be set by the visitor and cannot be used in triggers` };
      return { type: def.type, custom: true };
    }
    // Without definitions (pure validation): infer from the operand.
    const sample = Array.isArray(operand) ? operand[0] : operand;
    return { type: typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'string', custom: true };
  }
  return { error: 'unknown_field', message: `"${field}" is not an allowed field` };
}

function validScalar(type: DslFieldType, v: unknown, field: string, enumValues?: readonly string[]): string | null {
  switch (type) {
    case 'number':
      return isFiniteNumber(v) ? null : 'must be a finite number';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'id':
      return typeof v === 'string' && UUID_RE.test(v) ? null : 'must be an id (UUID)';
    case 'enum':
      return typeof v === 'string' && (enumValues ?? []).includes(v) ? null : `must be one of ${(enumValues ?? []).join(', ')}`;
    case 'list':
    case 'string': {
      if (typeof v !== 'string') return 'must be text';
      if (!v.length) return 'must not be empty';
      if (codePointLength(v) > DSL_MAX_STRING) return `must be at most ${DSL_MAX_STRING} characters`;
      if (hasControlChars(v, false)) return 'must not contain control characters';
      if (field === 'visitor.tags' && !TAG_RE.test(v)) return 'must be a tag slug (lowercase letters, digits, - and _)';
      if (field === 'visitor.country' && !COUNTRY_RE.test(v)) return 'must be a two-letter country code';
      return null;
    }
  }
}

function normalizeScalar(field: string, type: DslFieldType, v: DslScalar): DslScalar {
  if (typeof v !== 'string') return v;
  if (field === 'visitor.country') return v.toUpperCase();
  if (type === 'id') return v.toLowerCase();
  return v;
}

function validateCondition(raw: unknown, path: string, event: DslEvent | null, ctx: DslValidationContext | undefined, issues: Issues): DslCondition | null {
  if (!isPlainObject(raw)) {
    issues.add(path, 'invalid_type', 'Condition must be an object');
    return null;
  }
  checkKeys(raw, ['field', 'op', 'value', 'ignore_case'], path, issues);
  const field = raw.field;
  const op = raw.op;
  if (typeof field !== 'string' || !field) {
    issues.add(`${path}.field`, 'required', 'Field is required');
    return null;
  }
  if (typeof op !== 'string' || !(DSL_OPERATORS as readonly string[]).includes(op)) {
    issues.add(`${path}.op`, 'invalid_enum', `Unknown operator "${String(op)}"`);
    return null;
  }
  const resolved = dslFieldType(field, event, ctx, raw.value);
  if ('error' in resolved) {
    issues.add(`${path}.field`, resolved.error, resolved.message);
    return null;
  }
  const { type } = resolved;
  const operator = op as DslOperator;
  if (!OPS_BY_TYPE[type].includes(operator)) {
    issues.add(`${path}.op`, 'illegal_operator', `Operator "${operator}" cannot be used with ${type} field "${field}"`);
    return null;
  }
  const enumValues = FIELD_BY_KEY.get(field)?.enumValues;
  const out: DslCondition = { field, op: operator };
  if (raw.ignore_case !== undefined) {
    if (typeof raw.ignore_case !== 'boolean') issues.add(`${path}.ignore_case`, 'invalid_type', 'ignore_case must be true or false');
    else if (type !== 'string' && type !== 'list') issues.add(`${path}.ignore_case`, 'illegal_option', 'ignore_case only applies to text fields');
    else if (raw.ignore_case) out.ignore_case = true;
  }
  if (operator === 'exists' || operator === 'missing') {
    if (raw.value !== undefined) issues.add(`${path}.value`, 'unexpected_value', `"${operator}" does not take a value`);
    return out;
  }
  if (raw.value === undefined || raw.value === null) {
    issues.add(`${path}.value`, 'required', 'Value is required');
    return null;
  }
  if (operator === 'in' || operator === 'not_in') {
    if (!Array.isArray(raw.value) || raw.value.length === 0 || raw.value.length > DSL_MAX_LIST) {
      issues.add(`${path}.value`, 'invalid_type', `"${operator}" needs a list of 1–${DSL_MAX_LIST} values`);
      return null;
    }
    const itemType: DslFieldType = type === 'list' ? 'string' : type;
    const values: DslScalar[] = [];
    raw.value.forEach((v, i) => {
      const err = validScalar(itemType, v, field, enumValues);
      if (err) issues.add(`${path}.value.${i}`, 'invalid_value', `Value ${err}`);
      else values.push(normalizeScalar(field, itemType, v as DslScalar));
    });
    out.value = values;
    return out;
  }
  if (Array.isArray(raw.value)) {
    issues.add(`${path}.value`, 'invalid_type', `"${operator}" takes a single value`);
    return null;
  }
  let scalarType: DslFieldType = type;
  if (type === 'list') scalarType = 'string'; // contains
  if (['contains', 'starts_with', 'ends_with'].includes(operator)) scalarType = 'string';
  if (['gt', 'gte', 'lt', 'lte'].includes(operator)) scalarType = 'number';
  const err = validScalar(scalarType, raw.value, field, enumValues);
  if (err) {
    issues.add(`${path}.value`, 'invalid_value', `Value ${err}`);
    return null;
  }
  out.value = normalizeScalar(field, scalarType, raw.value as DslScalar);
  return out;
}

function text(raw: Record<string, unknown>, key: string, path: string, issues: Issues, opts: { max: number; required: boolean; multiline?: boolean; fallback?: string }): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (opts.required) issues.add(join(path, key), 'required', `${key} is required`);
    return opts.fallback;
  }
  if (typeof v !== 'string' || !v.trim()) {
    issues.add(join(path, key), 'invalid_type', `${key} must be non-empty text`);
    return undefined;
  }
  if (codePointLength(v) > opts.max) issues.add(join(path, key), 'too_long', `${key} must be at most ${opts.max} characters`);
  if (hasControlChars(v, !!opts.multiline)) issues.add(join(path, key), 'invalid_value', `${key} must be plain text without control characters`);
  return v.trim();
}

function intField(raw: Record<string, unknown>, key: string, path: string, issues: Issues, min: number, max: number, fallback?: number): number | undefined {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (fallback === undefined) issues.add(join(path, key), 'required', `${key} is required`);
    return fallback;
  }
  if (!isInt(v) || v < min || v > max) {
    issues.add(join(path, key), 'invalid_value', `${key} must be a whole number between ${min} and ${max}`);
    return undefined;
  }
  return v;
}

function refId(raw: Record<string, unknown>, key: string, path: string, issues: Issues, known: Set<string> | null, what: string, nullable = false): string | null | undefined {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (nullable) return null;
    issues.add(join(path, key), 'required', `${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    issues.add(join(path, key), 'invalid_value', `${key} must be an id`);
    return undefined;
  }
  const id = v.toLowerCase();
  if (known && !known.has(id)) {
    issues.add(join(path, key), 'unknown_reference', `${what} does not exist in this workspace`);
    return undefined;
  }
  return id;
}

const ACTION_KEYS: Record<DslActionType, readonly string[]> = {
  set_department: ['type', 'department_id'],
  set_priority: ['type', 'priority'],
  add_tag: ['type', 'tag', 'target'],
  remove_tag: ['type', 'tag', 'target'],
  send_public_message: ['type', 'text', 'attribution'],
  display_invitation: ['type', 'message', 'attribution', 'department_id', 'expires_in_seconds', 'max_per_session', 'dismiss_cooldown_hours'],
  set_visitor_field: ['type', 'key', 'value'],
  notify_department: ['type', 'department_id', 'text'],
  create_webhook_job: ['type', 'event_name'],
  block_admission: ['type', 'reason'],
};

export const DSL_DEFAULT_ATTRIBUTION = 'Team';

function validateAction(raw: unknown, path: string, event: DslEvent | null, ctx: DslValidationContext | undefined, depts: Set<string> | null, issues: Issues): DslAction | null {
  if (!isPlainObject(raw)) {
    issues.add(path, 'invalid_type', 'Action must be an object');
    return null;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !(DSL_ACTION_TYPES as readonly string[]).includes(type)) {
    issues.add(`${path}.type`, 'invalid_enum', `Unknown action "${String(type)}"`);
    return null;
  }
  const t = type as DslActionType;
  const before = issues.list.length;
  checkKeys(raw, ACTION_KEYS[t], path, issues);
  if (event && !DSL_ACTION_EVENTS[t].includes(event)) {
    issues.add(`${path}.type`, 'action_unavailable', `"${t}" cannot run on ${event}`);
  }
  let action: DslAction | null = null;
  switch (t) {
    case 'set_department': {
      const id = refId(raw, 'department_id', path, issues, depts, 'Department');
      if (id) action = { type: t, department_id: id };
      break;
    }
    case 'set_priority': {
      const p = intField(raw, 'priority', path, issues, 0, 100);
      if (p !== undefined) action = { type: t, priority: p };
      break;
    }
    case 'add_tag':
    case 'remove_tag': {
      const tag = raw.tag;
      if (typeof tag !== 'string' || !TAG_RE.test(tag)) issues.add(`${path}.tag`, 'invalid_value', 'tag must be a slug: lowercase letters, digits, - and _ (max 64)');
      const chatCapable = !!event && CHAT_EVENTS.includes(event);
      // Default target: the chat on chat events, otherwise the visitor.
      let target: DslTagTarget = chatCapable ? 'chat' : 'visitor';
      if (raw.target !== undefined) {
        if (raw.target !== 'chat' && raw.target !== 'visitor') issues.add(`${path}.target`, 'invalid_enum', 'target must be chat or visitor');
        else target = raw.target;
      }
      if (target === 'chat' && event && !chatCapable) issues.add(`${path}.target`, 'action_unavailable', `${event} has no chat to tag`);
      if (typeof tag === 'string' && TAG_RE.test(tag)) action = { type: t, tag, target };
      break;
    }
    case 'send_public_message': {
      const body = text(raw, 'text', path, issues, { max: DSL_MAX_STRING, required: true, multiline: true });
      const attribution = text(raw, 'attribution', path, issues, { max: 80, required: false, fallback: DSL_DEFAULT_ATTRIBUTION });
      if (body && attribution) action = { type: t, text: body, attribution };
      break;
    }
    case 'display_invitation': {
      const message = text(raw, 'message', path, issues, { max: 500, required: true, multiline: true });
      const attribution = text(raw, 'attribution', path, issues, { max: 80, required: false, fallback: DSL_DEFAULT_ATTRIBUTION });
      const dept = refId(raw, 'department_id', path, issues, depts, 'Department', true);
      const expires = intField(raw, 'expires_in_seconds', path, issues, 30, 3600, 600);
      const cap = intField(raw, 'max_per_session', path, issues, 1, 5, 1);
      const cooldown = intField(raw, 'dismiss_cooldown_hours', path, issues, 0, 720, 24);
      if (message && attribution && dept !== undefined && expires !== undefined && cap !== undefined && cooldown !== undefined) {
        action = { type: t, message, attribution, department_id: dept, expires_in_seconds: expires, max_per_session: cap, dismiss_cooldown_hours: cooldown };
      }
      break;
    }
    case 'set_visitor_field': {
      const key = raw.key;
      const value = raw.value;
      if (typeof key !== 'string' || !CUSTOM_KEY_RE.test(key)) {
        issues.add(`${path}.key`, 'invalid_value', 'key must be a custom field key');
        break;
      }
      const def = ctx?.customFields?.[key];
      if (ctx?.customFields && !def) {
        issues.add(`${path}.key`, 'unknown_reference', `Custom field "${key}" does not exist`);
        break;
      }
      if (value === undefined) {
        issues.add(`${path}.value`, 'required', 'value is required (use null to clear)');
        break;
      }
      if (value !== null) {
        const expected = def?.type ?? (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');
        const err = validScalar(expected, value, 'custom');
        if (err) {
          issues.add(`${path}.value`, 'invalid_value', `value ${err}`);
          break;
        }
      }
      action = { type: t, key, value: value as DslScalar | null };
      break;
    }
    case 'notify_department': {
      const id = refId(raw, 'department_id', path, issues, depts, 'Department');
      const body = text(raw, 'text', path, issues, { max: 500, required: true });
      if (id && body) action = { type: t, department_id: id, text: body };
      break;
    }
    case 'create_webhook_job': {
      const name = raw.event_name;
      if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) issues.add(`${path}.event_name`, 'invalid_value', 'event_name must be a lowercase identifier (max 64)');
      else action = { type: t, event_name: name };
      break;
    }
    case 'block_admission': {
      const reason = text(raw, 'reason', path, issues, { max: 200, required: false, fallback: 'blocked_by_automation' });
      if (reason) action = { type: t, reason };
      break;
    }
  }
  return issues.list.length === before ? action : null;
}

/** Conflicting writes inside one trigger (ch. 32): rejected rather than silently resolved. */
function checkConflicts(actions: DslAction[], issues: Issues): void {
  const seen = new Map<string, number>();
  actions.forEach((a, i) => {
    let key: string | null = null;
    switch (a.type) {
      case 'set_department':
      case 'set_priority':
      case 'display_invitation':
      case 'block_admission':
        key = a.type;
        break;
      case 'add_tag':
      case 'remove_tag':
        key = `tag:${a.target}:${a.tag}`;
        break;
      case 'set_visitor_field':
        key = `field:${a.key}`;
        break;
    }
    if (!key) return;
    const prev = seen.get(key);
    if (prev !== undefined) issues.add(`actions.${i}`, 'conflicting_write', `Conflicts with action ${prev + 1}; a trigger may write each target once`);
    else seen.set(key, i);
  });
  const blockAt = actions.findIndex((a) => a.type === 'block_admission');
  if (blockAt >= 0) {
    actions.forEach((a, i) => {
      if (BLOCKED_BY_ADMISSION_BLOCK.has(a.type)) issues.add(`actions.${i}`, 'conflicting_write', `"${a.type}" contradicts block_admission in the same trigger`);
    });
  }
}

const DEFINITION_KEYS = ['dsl_version', 'event', 'priority', 'all', 'any', 'actions', 'stop_processing', 'cooldown_seconds'] as const;

/**
 * Strict grammar validation shared by the API and the editor: unknown keys, invalid
 * enums, illegal operator/type pairs, cross-tenant ids (when `ctx` is supplied),
 * limits and conflicting writes are rejected. Returns a normalized definition with
 * every default made explicit (persisted for deterministic replay).
 */
export function validateDslDefinition(input: unknown, ctx?: DslValidationContext): DslValidationResult {
  const issues = new Issues();
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: '', code: 'invalid_type', message: 'Definition must be an object' }] };
  checkKeys(input, DEFINITION_KEYS, '', issues);
  if (input.dsl_version !== DSL_VERSION) issues.add('dsl_version', 'unsupported_version', 'dsl_version must be 1');
  const event = typeof input.event === 'string' && (DSL_EVENTS as readonly string[]).includes(input.event) ? (input.event as DslEvent) : null;
  if (!event) issues.add('event', 'invalid_enum', `event must be one of ${DSL_EVENTS.join(', ')}`);
  const priority = intField(input, 'priority', '', issues, 0, DSL_PRIORITY_MAX);
  const cooldown = intField(input, 'cooldown_seconds', '', issues, 0, DSL_MAX_COOLDOWN_SECONDS, 0);
  let stop = false;
  if (input.stop_processing !== undefined && typeof input.stop_processing !== 'boolean') issues.add('stop_processing', 'invalid_type', 'stop_processing must be true or false');
  else stop = input.stop_processing === true;

  const groups: Record<'all' | 'any', DslCondition[]> = { all: [], any: [] };
  let total = 0;
  for (const g of ['all', 'any'] as const) {
    const raw = input[g];
    if (raw === undefined && g === 'any') continue;
    if (!Array.isArray(raw)) {
      issues.add(g, 'invalid_type', `${g} must be a list of conditions`);
      continue;
    }
    total += raw.length;
    raw.slice(0, DSL_MAX_CONDITIONS + 1).forEach((c, i) => {
      if (isPlainObject(c) && ('all' in c || 'any' in c)) {
        issues.add(`${g}.${i}`, 'nesting_not_allowed', 'Nested condition groups are not supported in DSL v1');
        return;
      }
      const cond = validateCondition(c, `${g}.${i}`, event, ctx, issues);
      if (cond) groups[g].push(cond);
    });
  }
  if (total > DSL_MAX_CONDITIONS) issues.add('all', 'too_many_conditions', `At most ${DSL_MAX_CONDITIONS} conditions in total`);

  const actions: DslAction[] = [];
  const depts = toSet(ctx?.departmentIds);
  const sites = toSet(ctx?.siteIds);
  if (!Array.isArray(input.actions) || input.actions.length === 0) issues.add('actions', 'required', 'Add at least one action');
  else if (input.actions.length > DSL_MAX_ACTIONS) issues.add('actions', 'too_many_actions', `At most ${DSL_MAX_ACTIONS} actions`);
  else
    input.actions.forEach((a, i) => {
      const action = validateAction(a, `actions.${i}`, event, ctx, depts, issues);
      if (action) actions.push(action);
    });
  if (actions.length === (Array.isArray(input.actions) ? input.actions.length : -1)) checkConflicts(actions, issues);

  // Cross-tenant references inside conditions (department.id / site.id).
  for (const g of ['all', 'any'] as const) {
    groups[g].forEach((c, i) => {
      const known = c.field === 'department.id' ? depts : c.field === 'site.id' ? sites : null;
      if (!known) return;
      const values = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
      for (const v of values) if (typeof v === 'string' && !known.has(v.toLowerCase())) issues.add(`${g}.${i}.value`, 'unknown_reference', `${c.field === 'site.id' ? 'Website' : 'Department'} does not exist in this workspace`);
    });
  }

  if (issues.list.length || !event || priority === undefined || cooldown === undefined) return { ok: false, issues: issues.list };
  return {
    ok: true,
    issues: [],
    definition: { dsl_version: DSL_VERSION, event, priority, all: groups.all, any: groups.any, actions, stop_processing: stop, cooldown_seconds: cooldown },
  };
}

/** Validate a simulator / sample snapshot: allowlisted fields, typed values, bounded strings. */
export function validateDslSnapshot(input: unknown, ctx?: DslValidationContext): { ok: true; snapshot: Record<string, DslScalar | string[] | null> } | { ok: false; issues: DslIssue[] } {
  const issues = new Issues();
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: '', code: 'invalid_type', message: 'Snapshot must be an object' }] };
  const out: Record<string, DslScalar | string[] | null> = {};
  const keys = Object.keys(input);
  if (keys.length > DSL_FIELDS.length + 50) issues.add('', 'too_many_fields', 'Too many snapshot fields');
  for (const key of keys) {
    const v = input[key];
    const resolved = dslFieldType(key, null, ctx, v);
    if ('error' in resolved) {
      issues.add(key, resolved.error, resolved.message);
      continue;
    }
    if (v === null || v === undefined) {
      out[key] = null;
      continue;
    }
    if (resolved.type === 'list') {
      if (!Array.isArray(v) || v.length > DSL_MAX_LIST || !v.every((x) => typeof x === 'string' && x.length <= 64)) issues.add(key, 'invalid_value', `${key} must be a list of at most ${DSL_MAX_LIST} tags`);
      else out[key] = v.map((x) => String(x));
      continue;
    }
    const scalarErr =
      resolved.type === 'string' && typeof v === 'string'
        ? codePointLength(v) > DSL_MAX_STRING
          ? `must be at most ${DSL_MAX_STRING} characters`
          : null
        : validScalar(resolved.type, v, '', FIELD_BY_KEY.get(key)?.enumValues);
    if (scalarErr) issues.add(key, 'invalid_value', `${key} ${scalarErr}`);
    else out[key] = typeof v === 'string' && resolved.type === 'id' ? v.toLowerCase() : (v as DslScalar);
  }
  return issues.list.length ? { ok: false, issues: issues.list } : { ok: true, snapshot: out };
}

// ─────────────────────────── Interpreter ───────────────────────────

export interface DslConditionTrace {
  index: number;
  field: string;
  op: DslOperator;
  value?: DslScalar | DslScalar[];
  result: boolean;
  /** The snapshot had no value for the field. */
  missing: boolean;
  /** Snapshot value had an unexpected type (treated as non-matching). */
  error?: 'type_mismatch';
}

export type DslTriggerReason =
  | 'fired'
  | 'conditions_false'
  | 'cooldown'
  | 'recursion'
  | 'depth_limit'
  | 'event_mismatch'
  | 'after_stop';

export interface DslTriggerTrace {
  triggerId: string;
  revision: number;
  priority: number;
  /** Position in deterministic evaluation order (0-based). */
  position: number;
  evaluated: boolean;
  /** Conditions held (all ∧ (any∨empty)). */
  matched: boolean;
  /** Actions were collected. */
  fired: boolean;
  reason: DslTriggerReason;
  stopProcessing: boolean;
  allResult: boolean;
  anyResult: boolean;
  all: DslConditionTrace[];
  any: DslConditionTrace[];
}

export interface DslEffect {
  triggerId: string;
  revision: number;
  actionIndex: number;
  action: DslAction;
}

export type DslSuppressionReason =
  | 'department_already_set'
  | 'priority_already_set'
  | 'invitation_already_selected'
  | 'field_already_set'
  | 'admission_blocked';

export interface DslSuppressed {
  triggerId: string;
  revision: number;
  actionIndex: number;
  type: DslActionType;
  reason: DslSuppressionReason;
}

export interface DslTriggerSpec {
  id: string;
  revision: number;
  /** Creation time (ms since epoch) — second precedence key. */
  createdAt: number;
  definition: DslDefinition;
}

export interface DslEvaluationInput {
  event: DslEvent;
  snapshot: DslSnapshot;
  /** Authoritative evaluation time (ms since epoch). */
  now: number;
  triggers: readonly DslTriggerSpec[];
  /** Last time each trigger fired for this visitor session (ms), for cooldowns. */
  lastFiredAt?: Readonly<Record<string, number | null | undefined>>;
  /** Causation depth of the event (0 = external). */
  depth?: number;
  /** Trigger ids that already acted in this causation chain. */
  ancestors?: readonly string[];
}

export interface DslEvaluation {
  event: DslEvent;
  triggers: DslTriggerTrace[];
  effects: DslEffect[];
  suppressed: DslSuppressed[];
  stoppedBy: string | null;
  blocked: boolean;
}

/** Deterministic precedence (ch. 33): priority desc → created_at asc → id asc. */
export function sortDslTriggers<T extends { id: string; createdAt: number; definition: { priority: number } }>(triggers: readonly T[]): T[] {
  return [...triggers].sort((a, b) => b.definition.priority - a.definition.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

function cloneSnapshot(s: DslSnapshot): DslSnapshot {
  const out: Record<string, DslScalar | readonly string[] | null | undefined> = {};
  for (const [k, v] of Object.entries(s)) out[k] = Array.isArray(v) ? [...v] : v;
  return deepFreeze(out);
}

function expectedType(field: string, cond: DslCondition): DslFieldType {
  const spec = FIELD_BY_KEY.get(field);
  if (spec) return spec.type;
  const sample = Array.isArray(cond.value) ? cond.value[0] : cond.value;
  return typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'string';
}

function fold(s: string, ignoreCase: boolean | undefined): string {
  return ignoreCase ? s.toLowerCase() : s;
}

/** Evaluate one condition against a snapshot. Missing fields fail every operator except `missing`. */
export function evaluateDslCondition(cond: DslCondition, snapshot: DslSnapshot, index = 0): DslConditionTrace {
  const raw = snapshot[cond.field];
  const missing = raw === undefined || raw === null;
  const base: DslConditionTrace = { index, field: cond.field, op: cond.op, ...(cond.value !== undefined ? { value: cond.value } : {}), result: false, missing };
  if (cond.op === 'missing') return { ...base, result: missing };
  if (cond.op === 'exists') return { ...base, result: !missing };
  if (missing) return base;
  const type = expectedType(cond.field, cond);
  const mismatch = (): DslConditionTrace => ({ ...base, error: 'type_mismatch' });
  const ic = cond.ignore_case;

  if (type === 'list') {
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) return mismatch();
    const list = (raw as readonly string[]).map((x) => fold(x, ic));
    const values = (Array.isArray(cond.value) ? cond.value : [cond.value]).map((v) => fold(String(v), ic));
    switch (cond.op) {
      case 'contains':
        return { ...base, result: list.includes(values[0]) };
      case 'in':
        return { ...base, result: values.some((v) => list.includes(v)) };
      case 'not_in':
        return { ...base, result: !values.some((v) => list.includes(v)) };
      default:
        return base;
    }
  }
  if (Array.isArray(raw)) return mismatch();

  if (type === 'number' || ['gt', 'gte', 'lt', 'lte'].includes(cond.op)) {
    if (!isFiniteNumber(raw)) return mismatch();
    if (cond.op === 'in' || cond.op === 'not_in') {
      const hit = (cond.value as DslScalar[]).some((v) => v === raw);
      return { ...base, result: cond.op === 'in' ? hit : !hit };
    }
    const v = cond.value as number;
    switch (cond.op) {
      case 'eq':
        return { ...base, result: raw === v };
      case 'neq':
        return { ...base, result: raw !== v };
      case 'gt':
        return { ...base, result: raw > v };
      case 'gte':
        return { ...base, result: raw >= v };
      case 'lt':
        return { ...base, result: raw < v };
      case 'lte':
        return { ...base, result: raw <= v };
      default:
        return base;
    }
  }
  if (type === 'boolean') {
    if (typeof raw !== 'boolean') return mismatch();
    if (cond.op === 'eq') return { ...base, result: raw === cond.value };
    if (cond.op === 'neq') return { ...base, result: raw !== cond.value };
    return base;
  }
  // string / id / enum
  if (typeof raw !== 'string') return mismatch();
  const caseless = ic || type === 'id';
  const subject = fold(raw, caseless);
  const operand = (v: DslScalar) => fold(String(v), caseless);
  switch (cond.op) {
    case 'eq':
      return { ...base, result: subject === operand(cond.value as DslScalar) };
    case 'neq':
      return { ...base, result: subject !== operand(cond.value as DslScalar) };
    case 'contains':
      return { ...base, result: subject.includes(operand(cond.value as DslScalar)) };
    case 'starts_with':
      return { ...base, result: subject.startsWith(operand(cond.value as DslScalar)) };
    case 'ends_with':
      return { ...base, result: subject.endsWith(operand(cond.value as DslScalar)) };
    case 'in':
      return { ...base, result: (cond.value as DslScalar[]).some((v) => operand(v) === subject) };
    case 'not_in':
      return { ...base, result: !(cond.value as DslScalar[]).some((v) => operand(v) === subject) };
    default:
      return base;
  }
}

/** Conditions of a single definition: every `all` and at least one `any` when `any` is non-empty. */
export function evaluateDslConditions(def: Pick<DslDefinition, 'all' | 'any'>, snapshot: DslSnapshot): { matched: boolean; allResult: boolean; anyResult: boolean; all: DslConditionTrace[]; any: DslConditionTrace[] } {
  const all = def.all.map((c, i) => evaluateDslCondition(c, snapshot, i));
  const any = def.any.map((c, i) => evaluateDslCondition(c, snapshot, i));
  const allResult = all.every((t) => t.result);
  const anyResult = any.length === 0 || any.some((t) => t.result);
  return { matched: allResult && anyResult, allResult, anyResult, all, any };
}

/**
 * Evaluate every trigger for one event against ONE immutable snapshot (ch. 33).
 * Earlier actions never change later matching; actions are collected until a
 * matched trigger with stop_processing (or a terminal block_admission), then
 * resolved: first winning set_department / set_priority / invitation / field
 * write, tag actions in collected order, block_admission suppresses routing and
 * visitor-facing actions.
 */
export function evaluateDslPipeline(input: DslEvaluationInput): DslEvaluation {
  const snapshot = cloneSnapshot(input.snapshot);
  const depth = input.depth ?? 0;
  const ancestors = new Set(input.ancestors ?? []);
  const ordered = sortDslTriggers(input.triggers);
  const traces: DslTriggerTrace[] = [];
  const collected: DslEffect[] = [];
  let stoppedBy: string | null = null;
  let blocked = false;

  ordered.forEach((t, position) => {
    const def = t.definition;
    const trace: DslTriggerTrace = {
      triggerId: t.id,
      revision: t.revision,
      priority: def.priority,
      position,
      evaluated: false,
      matched: false,
      fired: false,
      reason: 'after_stop',
      stopProcessing: def.stop_processing,
      allResult: false,
      anyResult: false,
      all: [],
      any: [],
    };
    traces.push(trace);
    if (def.event !== input.event) {
      trace.reason = 'event_mismatch';
      return;
    }
    if (depth > DSL_MAX_DEPTH) {
      trace.reason = 'depth_limit';
      return;
    }
    if (stoppedBy) return;
    const r = evaluateDslConditions(def, snapshot);
    Object.assign(trace, { evaluated: true, matched: r.matched, allResult: r.allResult, anyResult: r.anyResult, all: r.all, any: r.any });
    if (!r.matched) {
      trace.reason = 'conditions_false';
      return;
    }
    if (ancestors.has(t.id)) {
      trace.reason = 'recursion';
      return;
    }
    const last = input.lastFiredAt?.[t.id];
    if (def.cooldown_seconds > 0 && typeof last === 'number' && input.now - last < def.cooldown_seconds * 1000) {
      trace.reason = 'cooldown';
      return;
    }
    trace.fired = true;
    trace.reason = 'fired';
    def.actions.forEach((action, actionIndex) => collected.push({ triggerId: t.id, revision: t.revision, actionIndex, action }));
    if (def.actions.some((a) => a.type === 'block_admission')) blocked = true;
    if (def.stop_processing || blocked) stoppedBy = t.id;
  });

  // Resolve collected actions in order.
  const effects: DslEffect[] = [];
  const suppressed: DslSuppressed[] = [];
  const winners = new Set<string>();
  const suppress = (e: DslEffect, reason: DslSuppressionReason) => suppressed.push({ triggerId: e.triggerId, revision: e.revision, actionIndex: e.actionIndex, type: e.action.type, reason });
  for (const e of collected) {
    const a = e.action;
    if (blocked && BLOCKED_BY_ADMISSION_BLOCK.has(a.type)) {
      suppress(e, 'admission_blocked');
      continue;
    }
    const key = a.type === 'set_department' || a.type === 'set_priority' || a.type === 'display_invitation' || a.type === 'block_admission' ? a.type : a.type === 'set_visitor_field' ? `field:${a.key}` : null;
    if (key && winners.has(key)) {
      suppress(
        e,
        a.type === 'set_department' ? 'department_already_set' : a.type === 'set_priority' ? 'priority_already_set' : a.type === 'display_invitation' ? 'invitation_already_selected' : 'field_already_set',
      );
      continue;
    }
    if (key) winners.add(key);
    effects.push(e);
  }
  return { event: input.event, triggers: traces, effects, suppressed, stoppedBy, blocked };
}

/**
 * Durable timer thresholds needed by `visitor.timer.elapsed` triggers: the engine
 * schedules server-side jobs at these offsets (never browser timers).
 */
export function dslTimerThresholds(def: Pick<DslDefinition, 'event' | 'all' | 'any'>): { page: number[]; session: number[] } {
  const page = new Set<number>();
  const session = new Set<number>();
  if (def.event !== 'visitor.timer.elapsed') return { page: [], session: [] };
  for (const c of [...def.all, ...def.any]) {
    const target = c.field === 'page.visible_dwell_seconds' ? page : c.field === 'session.time_on_site_seconds' ? session : null;
    if (!target) continue;
    const values = Array.isArray(c.value) ? c.value : [c.value];
    for (const v of values) {
      if (!isFiniteNumber(v)) continue;
      const at = c.op === 'gt' ? Math.floor(v) + 1 : c.op === 'gte' || c.op === 'eq' || c.op === 'in' ? Math.ceil(v) : null;
      if (at !== null && at >= 0 && at <= DSL_MAX_TIMER_SECONDS) target.add(at);
    }
  }
  const pick = (s: Set<number>) => [...s].sort((a, b) => a - b).slice(0, 10);
  return { page: pick(page), session: pick(session) };
}
