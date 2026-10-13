/**
 * Presentation helpers for the trigger DSL. Grammar, limits and validation live in
 * `@talkivio/contracts` (the exact code the API runs); nothing here decides validity.
 * DSL codes (events, actions, operators, field keys, reasons) stay untouched; their
 * labels are catalog keys translated at render time. Validator messages come from the
 * shared contracts package and are shown as they are.
 */
import {
  DSL_ACTION_EVENTS,
  DSL_CUSTOM_PREFIX,
  DSL_DEFAULT_ATTRIBUTION,
  DSL_FIELDS,
  DSL_VERSION,
  dslOperatorsFor,
  type DslAction,
  type DslActionType,
  type DslCondition,
  type DslDefinition,
  type DslEvent,
  type DslFieldType,
  type DslIssue,
  type DslOperator,
  type DslSuppressionReason,
  type DslTriggerReason,
  type DslValidationContext,
} from '@talkivio/contracts';
import { activeLocale, isolate, type MessageKey, type Translate } from '@/i18n';
import type { CustomFieldDef } from './triggers-api';
import { customFieldType } from './triggers-api';

export const OPERATOR_LABELS: Record<DslOperator, MessageKey> = {
  eq: 'triggers.op.eq',
  neq: 'triggers.op.neq',
  contains: 'triggers.op.contains',
  starts_with: 'triggers.op.startsWith',
  ends_with: 'triggers.op.endsWith',
  in: 'triggers.op.in',
  not_in: 'triggers.op.notIn',
  gt: 'triggers.op.gt',
  gte: 'triggers.op.gte',
  lt: 'triggers.op.lt',
  lte: 'triggers.op.lte',
  exists: 'triggers.op.exists',
  missing: 'triggers.op.missing',
};

/** List fields read a little differently. */
export function operatorLabel(t: Translate, op: DslOperator, type: DslFieldType | null): string {
  if (type === 'list') {
    if (op === 'contains') return t('triggers.op.listContains');
    if (op === 'in') return t('triggers.op.listIn');
    if (op === 'not_in') return t('triggers.op.listNotIn');
  }
  const key = OPERATOR_LABELS[op];
  return key ? t(key) : op;
}

const EVENT_LABELS: Record<DslEvent, MessageKey> = {
  'visitor.session.started': 'triggers.event.visitorSessionStarted',
  'visitor.page.changed': 'triggers.event.visitorPageChanged',
  'visitor.timer.elapsed': 'triggers.event.visitorTimerElapsed',
  'chat.requested': 'triggers.event.chatRequested',
  'message.created': 'triggers.event.messageCreated',
  'chat.queued': 'triggers.event.chatQueued',
  'chat.closed': 'triggers.event.chatClosed',
  'offline.submitted': 'triggers.event.offlineSubmitted',
};

const ACTION_LABELS: Record<DslActionType, MessageKey> = {
  set_department: 'triggers.action.setDepartment',
  set_priority: 'triggers.action.setPriority',
  add_tag: 'triggers.action.addTag',
  remove_tag: 'triggers.action.removeTag',
  send_public_message: 'triggers.action.sendPublicMessage',
  display_invitation: 'triggers.action.displayInvitation',
  set_visitor_field: 'triggers.action.setVisitorField',
  notify_department: 'triggers.action.notifyDepartment',
  create_webhook_job: 'triggers.action.createWebhookJob',
  block_admission: 'triggers.action.blockAdmission',
};

/** Allowlisted field keys → labels (the contracts package's English labels are the fallback). */
const FIELD_LABELS: Record<string, MessageKey> = {
  'site.id': 'triggers.field.siteId',
  'department.id': 'triggers.field.departmentId',
  'visitor.verified': 'triggers.field.visitorVerified',
  'visitor.country': 'triggers.field.visitorCountry',
  'visitor.tags': 'triggers.field.visitorTags',
  'visitor.returning': 'triggers.field.visitorReturning',
  'page.path': 'triggers.field.pagePath',
  'referrer.origin': 'triggers.field.referrerOrigin',
  'session.time_on_site_seconds': 'triggers.field.sessionTimeOnSite',
  'page.visible_dwell_seconds': 'triggers.field.pageVisibleDwell',
  'chat.wait_seconds': 'triggers.field.chatWaitSeconds',
  'chat.status': 'triggers.field.chatStatus',
  'message.text': 'triggers.field.messageText',
  'schedule.is_open': 'triggers.field.scheduleIsOpen',
  eligible_agent_count: 'triggers.field.eligibleAgentCount',
};

export function fieldLabel(t: Translate, key: string, fallback: string): string {
  const k = FIELD_LABELS[key];
  return k ? t(k) : fallback;
}

/** Enum values (`chat.status`) keep their code; this is only the label shown for them. */
const ENUM_LABELS: Record<string, MessageKey> = {
  queued: 'triggers.chatStatus.queued',
  offered: 'triggers.chatStatus.offered',
  active: 'triggers.chatStatus.active',
  closed: 'triggers.chatStatus.closed',
};

export function enumLabel(t: Translate, value: string): string {
  const k = ENUM_LABELS[value];
  return k ? t(k) : value;
}

export interface FieldOption {
  key: string;
  label: string;
  type: DslFieldType;
  enumValues?: readonly string[];
  /** Not provided for the selected event. */
  unavailable: boolean;
  custom: boolean;
}

export interface FieldGroup {
  id: string;
  label: string;
  fields: FieldOption[];
}

const SUBJECT_LABELS: Record<string, MessageKey> = {
  site: 'triggers.fieldGroup.site',
  department: 'triggers.fieldGroup.department',
  visitor: 'triggers.fieldGroup.visitor',
  page: 'triggers.fieldGroup.page',
  referrer: 'triggers.fieldGroup.referrer',
  session: 'triggers.fieldGroup.session',
  chat: 'triggers.fieldGroup.chat',
  message: 'triggers.fieldGroup.message',
  schedule: 'triggers.fieldGroup.schedule',
  eligible_agent_count: 'triggers.fieldGroup.availability',
};

function subjectOf(key: string): string {
  return key.includes('.') ? key.split('.')[0]! : key;
}

/** Trusted custom fields (not writable by the visitor's browser) usable in conditions. */
export function trustedCustomFields(defs: CustomFieldDef[] | undefined): CustomFieldDef[] {
  return (defs ?? []).filter((d) => !d.archivedAt && !d.publicWritable);
}

/** Allowlisted fields grouped by subject, with availability for the event (ch. 32). */
export function fieldGroups(t: Translate, event: DslEvent, customDefs: CustomFieldDef[] | undefined): FieldGroup[] {
  const groups = new Map<string, FieldOption[]>();
  for (const f of DSL_FIELDS) {
    const subject = SUBJECT_LABELS[subjectOf(f.key)] ? subjectOf(f.key) : 'other';
    const list = groups.get(subject) ?? [];
    list.push({ key: f.key, label: fieldLabel(t, f.key, f.label), type: f.type, enumValues: f.enumValues, unavailable: !!f.events && !f.events.includes(event), custom: false });
    groups.set(subject, list);
  }
  const out: FieldGroup[] = [...groups.entries()].map(([id, fields]) => ({ id, label: SUBJECT_LABELS[id] ? t(SUBJECT_LABELS[id]!) : t('common.other'), fields }));
  const custom = trustedCustomFields(customDefs);
  if (custom.length) {
    out.push({
      id: 'custom',
      label: t('triggers.fieldGroup.custom'),
      fields: custom.map((d) => ({ key: `${DSL_CUSTOM_PREFIX}${d.key}`, label: d.label || d.key, type: customFieldType(d.dataType), unavailable: false, custom: true })),
    });
  }
  return out;
}

export function findField(groups: FieldGroup[], key: string): FieldOption | null {
  for (const g of groups) for (const f of g.fields) if (f.key === key) return f;
  return null;
}

/** Validation context from the tenant's reference data; only lists that loaded are enforced. */
export function validationContext(input: { departmentIds?: string[]; siteIds?: string[]; customDefs?: CustomFieldDef[] }): DslValidationContext {
  const ctx: DslValidationContext = {};
  if (input.departmentIds) ctx.departmentIds = input.departmentIds;
  if (input.siteIds) ctx.siteIds = input.siteIds;
  if (input.customDefs) {
    ctx.customFields = Object.fromEntries(input.customDefs.filter((d) => !d.archivedAt).map((d) => [d.key, { type: customFieldType(d.dataType), trusted: !d.publicWritable }]));
  }
  return ctx;
}

/** Default operand for a field type and operator, so a new row starts in a sensible state. */
export function defaultValue(type: DslFieldType, op: DslOperator, enumValues?: readonly string[]): DslCondition['value'] {
  if (op === 'exists' || op === 'missing') return undefined;
  if (op === 'in' || op === 'not_in') return [];
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') return 0;
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'enum':
      return enumValues?.[0] ?? '';
    default:
      return '';
  }
}

export function newCondition(groups: FieldGroup[]): DslCondition {
  const first = groups.flatMap((g) => g.fields).find((f) => !f.unavailable && f.key === 'page.path') ?? groups[0]!.fields[0]!;
  const op = dslOperatorsFor(first.type)[0]!;
  return { field: first.key, op, value: defaultValue(first.type, op, first.enumValues) };
}

/** Starting values for each action type (defaults mirror the validator's fallbacks). */
export function newAction(type: DslActionType, event: DslEvent): DslAction {
  const chatEvent = ['chat.requested', 'message.created', 'chat.queued', 'chat.closed'].includes(event);
  switch (type) {
    case 'set_department':
      return { type, department_id: '' };
    case 'set_priority':
      return { type, priority: 50 };
    case 'add_tag':
    case 'remove_tag':
      return { type, tag: '', target: chatEvent ? 'chat' : 'visitor' };
    case 'send_public_message':
      return { type, text: '', attribution: DSL_DEFAULT_ATTRIBUTION };
    case 'display_invitation':
      return { type, message: '', attribution: DSL_DEFAULT_ATTRIBUTION, department_id: null, expires_in_seconds: 600, max_per_session: 1, dismiss_cooldown_hours: 24 };
    case 'set_visitor_field':
      return { type, key: '', value: '' };
    case 'notify_department':
      return { type, department_id: '', text: '' };
    case 'create_webhook_job':
      return { type, event_name: '' };
    case 'block_admission':
      return { type, reason: 'blocked_by_automation' };
  }
}

export function firstActionTypeFor(event: DslEvent): DslActionType {
  const order: DslActionType[] = ['display_invitation', 'send_public_message', 'add_tag'];
  return order.find((t) => DSL_ACTION_EVENTS[t].includes(event)) ?? 'add_tag';
}

export function blankDefinition(event: DslEvent): DslDefinition {
  return { dsl_version: DSL_VERSION, event, priority: 100, all: [], any: [], actions: [newAction(firstActionTypeFor(event), event)], stop_processing: false, cooldown_seconds: 0 };
}

export function actionAvailable(type: DslActionType, event: DslEvent): boolean {
  return DSL_ACTION_EVENTS[type].includes(event);
}

export function eventLabel(t: Translate, e: string): string {
  const key = EVENT_LABELS[e as DslEvent];
  return key ? t(key) : e;
}

export function actionLabel(t: Translate, type: string): string {
  const key = ACTION_LABELS[type as DslActionType];
  return key ? t(key) : type;
}

const ISSUE_MESSAGES: Record<string, MessageKey> = {
  invalid_value: 'triggers.issue.invalidValue',
  invalid_type: 'triggers.issue.invalidType',
  required: 'triggers.issue.required',
  invalid_enum: 'triggers.issue.invalidEnum',
  unknown_reference: 'triggers.issue.unknownReference',
  conflicting_write: 'triggers.issue.conflictingWrite',
  action_unavailable: 'triggers.issue.actionUnavailable',
  unsupported_version: 'triggers.issue.unsupportedVersion',
  unknown_key: 'triggers.issue.unknownKey',
  unexpected_value: 'triggers.issue.unexpectedValue',
  too_many_fields: 'triggers.issue.tooManyFields',
  too_many_conditions: 'triggers.issue.tooManyConditions',
  too_many_actions: 'triggers.issue.tooManyActions',
  nesting_not_allowed: 'triggers.issue.nestingNotAllowed',
  illegal_option: 'triggers.issue.illegalOption',
  illegal_operator: 'triggers.issue.illegalOperator',
};

/**
 * DSL validator messages come from @talkivio/contracts in English. English keeps the specific message; other
 * languages show the message for the stable issue code (the row/location is shown separately).
 */
export function localizeIssues(t: Translate, issues: DslIssue[]): DslIssue[] {
  if (activeLocale() === 'en') return issues;
  return issues.map((i) => (ISSUE_MESSAGES[i.code] ? { ...i, message: t(ISSUE_MESSAGES[i.code]!) } : i));
}

/** Index issues by path so each row can show its own messages. */
export class IssueIndex {
  private readonly byPath = new Map<string, DslIssue[]>();
  constructor(readonly issues: DslIssue[]) {
    for (const i of issues) {
      const list = this.byPath.get(i.path) ?? [];
      list.push(i);
      this.byPath.set(i.path, list);
    }
  }
  /** Issues at exactly this path. */
  at(path: string): DslIssue[] {
    return this.byPath.get(path) ?? [];
  }
  /** Issues at this path or below it. */
  under(path: string): DslIssue[] {
    return this.issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
  }
  first(path: string): string | undefined {
    return this.at(path)[0]?.message;
  }
  firstUnder(path: string): string | undefined {
    return this.under(path)[0]?.message;
  }
  get count(): number {
    return this.issues.length;
  }
}

/** API 422 `field_errors` (`definition.actions.0.text`) → DSL issues with editor paths. */
export function issuesFromFieldErrors(fieldErrors: Record<string, string[]>, prefix = 'definition'): DslIssue[] {
  const out: DslIssue[] = [];
  for (const [key, msgs] of Object.entries(fieldErrors)) {
    if (key !== prefix && !key.startsWith(`${prefix}.`)) continue;
    const path = key === prefix ? '' : key.slice(prefix.length + 1);
    for (const m of msgs) out.push({ path, code: 'server', message: m });
  }
  return out;
}

/** Where an issue path points in the builder: `actions.1.text` → "Action 2". */
export function issueLocation(t: Translate, path: string): string {
  if (!path || path === 'dsl_version') return t('triggers.location.trigger');
  const [head, index] = path.split('.');
  const n = index !== undefined && /^\d+$/.test(index) ? Number(index) + 1 : null;
  if (head === 'all') return n ? t('triggers.location.allN', { n }) : t('triggers.location.all');
  if (head === 'any') return n ? t('triggers.location.anyN', { n }) : t('triggers.location.any');
  if (head === 'actions') return n ? t('triggers.location.actionN', { n }) : t('triggers.label.actions');
  const basics: Record<string, MessageKey> = { event: 'triggers.label.event', priority: 'triggers.label.priority', cooldown_seconds: 'triggers.label.cooldown', stop_processing: 'triggers.label.stopProcessing' };
  const key = basics[head!];
  return key ? t(key) : path;
}

export const TRIGGER_REASON_LABELS: Record<DslTriggerReason, MessageKey> = {
  fired: 'triggers.reason.fired',
  conditions_false: 'triggers.reason.conditionsFalse',
  cooldown: 'triggers.reason.cooldown',
  recursion: 'triggers.reason.recursion',
  depth_limit: 'triggers.reason.depthLimit',
  event_mismatch: 'triggers.reason.eventMismatch',
  after_stop: 'triggers.reason.afterStop',
};

export const SUPPRESSION_LABELS: Record<DslSuppressionReason, MessageKey> = {
  department_already_set: 'triggers.suppression.departmentAlreadySet',
  priority_already_set: 'triggers.suppression.priorityAlreadySet',
  invitation_already_selected: 'triggers.suppression.invitationAlreadySelected',
  field_already_set: 'triggers.suppression.fieldAlreadySet',
  admission_blocked: 'triggers.suppression.admissionBlocked',
};

/** Effect outcome reasons recorded by the engine (trigger-effects.service). */
export const EFFECT_REASON_LABELS: Record<string, MessageKey> = {
  no_chat: 'triggers.effectReason.noChat',
  chat_missing: 'triggers.effectReason.chatMissing',
  chat_assigned: 'triggers.effectReason.chatAssigned',
  chat_closed: 'triggers.effectReason.chatClosed',
  department_unavailable: 'triggers.effectReason.departmentUnavailable',
  no_visitor: 'triggers.effectReason.noVisitor',
  tag_archived: 'triggers.effectReason.tagArchived',
  field_unavailable: 'triggers.effectReason.fieldUnavailable',
  no_members: 'triggers.effectReason.noMembers',
  blocked_by_trigger: 'triggers.effectReason.blockedByTrigger',
  consent_required: 'triggers.effectReason.consentRequired',
  dismissed_recently: 'triggers.effectReason.dismissedRecently',
  duplicate: 'triggers.effectReason.duplicate',
  invitation_open: 'triggers.effectReason.invitationOpen',
  no_visitor_session: 'triggers.effectReason.noVisitorSession',
  session_cap: 'triggers.effectReason.sessionCap',
  session_ended: 'triggers.effectReason.sessionEnded',
  unavailable: 'triggers.effectReason.unavailable',
  visitor_chatting: 'triggers.effectReason.visitorChatting',
  ...SUPPRESSION_LABELS,
};

export function suppressionLabel(t: Translate, reason: string): string {
  const key = SUPPRESSION_LABELS[reason as DslSuppressionReason];
  return key ? t(key) : reason;
}

export function reasonLabel(t: Translate, reason: string | null | undefined): string | null {
  if (!reason) return null;
  const key = EFFECT_REASON_LABELS[reason] ?? TRIGGER_REASON_LABELS[reason as DslTriggerReason];
  return key ? t(key) : reason.replace(/_/g, ' ');
}

/** Short plain-language summary of an action, using names for referenced ids when known. */
export function describeAction(t: Translate, a: DslAction, names: { department: (id: string | null) => string }): string {
  switch (a.type) {
    case 'set_department':
      return t('triggers.describe.setDepartment', { department: isolate(names.department(a.department_id)) });
    case 'set_priority':
      return t('triggers.describe.setPriority', { priority: a.priority });
    case 'add_tag':
      return t('triggers.describe.addTag', { tag: isolate(a.tag), target: a.target });
    case 'remove_tag':
      return t('triggers.describe.removeTag', { tag: isolate(a.tag), target: a.target });
    case 'send_public_message':
      return t('triggers.describe.sendPublicMessage', { text: isolate(truncate(a.text, 80)), attribution: isolate(a.attribution) });
    case 'display_invitation':
      return t('triggers.describe.displayInvitation', { message: isolate(truncate(a.message, 60)), max: a.max_per_session, hours: a.dismiss_cooldown_hours });
    case 'set_visitor_field':
      return a.value === null ? t('triggers.describe.clearVisitorField', { key: isolate(a.key) }) : t('triggers.describe.setVisitorField', { key: isolate(a.key), value: isolate(String(a.value)) });
    case 'notify_department':
      return t('triggers.describe.notifyDepartment', { department: isolate(names.department(a.department_id)), text: isolate(truncate(a.text, 60)) });
    case 'create_webhook_job':
      return t('triggers.describe.createWebhookJob', { event: isolate(a.event_name) });
    case 'block_admission':
      return t('triggers.describe.blockAdmission', { reason: isolate(a.reason) });
  }
}

/** Names used when a referenced department or website id is not (or no longer) known. */
export function departmentNamer(t: Translate, lookup: (id: string) => string | undefined): (id: string | null) => string {
  return (id) => (id ? (lookup(id) ?? t('triggers.names.unknownDepartment')) : t('triggers.names.siteDefaultDepartment'));
}

export function truncate(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
}

export function formatValue(t: Translate, v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(t('triggers.listSeparator')) : t('triggers.value.emptyList');
  if (typeof v === 'string') return v === '' ? t('triggers.value.emptyText') : t('triggers.value.quoted', { value: isolate(v) });
  return String(v);
}

/** One condition in words: "Page path contains “/pricing”". */
export function conditionText(t: Translate, field: string, op: string, value?: string): string {
  return value === undefined ? t('triggers.condition.textNoValue', { field, op }) : t('triggers.condition.text', { field, op, value });
}
