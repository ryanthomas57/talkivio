/**
 * Outbound webhook event contract (ch. 55, plus `trigger.webhook` from the trigger DSL). Body:
 *   {id, type, version, occurred_at, tenant_id, data}
 * `id` is the committed outbox event id, so it is stable across retries and
 * redeliveries. `data` is deliberately minimal and identifier-based (no transcript
 * text, visitor names, emails or rating comments): receivers fetch details with a
 * scoped integration token. This keeps personal data out of third-party logs and
 * out of `webhook_deliveries.payload`.
 */
import type { InternalEvent } from '../../outbox/outbox.publisher';

export const WEBHOOK_EVENT_TYPES = [
  'chat.requested',
  'chat.started',
  'chat.closed',
  'rating.updated',
  'offline.submitted',
  'privacy.erased',
  'trigger.webhook',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const WEBHOOK_TEST_TYPE = 'webhook.test';
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** Internal (outbox) event type → public webhook type. */
export const SOURCE_EVENTS: Record<string, WebhookEventType> = {
  'chat.requested': 'chat.requested',
  'assignment.accepted': 'chat.started',
  'chat.closed': 'chat.closed',
  'rating.updated': 'rating.updated',
  'offline.submitted': 'offline.submitted',
  'privacy.erased': 'privacy.erased',
  /** Trigger DSL action `create_webhook_job` (named event only; targets are the tenant's configured endpoints). */
  'trigger.webhook': 'trigger.webhook',
};

export interface WebhookBody {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  tenant_id: string;
  data: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 200 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Chat id the event concerns (used to skip widget-preview chats). */
export function chatIdOf(ev: InternalEvent): string | null {
  const p = obj(ev.payload);
  if (ev.aggregateType !== 'chat') return str(p.chat_id);
  return str(p.chat_id) ?? str(obj(p.chat).id) ?? ev.aggregateId;
}

export function toWebhookData(ev: InternalEvent): { type: WebhookEventType; data: Obj } | null {
  const type = SOURCE_EVENTS[ev.eventType];
  if (!type) return null;
  const p = obj(ev.payload);
  switch (type) {
    case 'chat.requested': {
      const c = obj(p.chat);
      return {
        type,
        data: {
          chat_id: str(c.id) ?? ev.aggregateId,
          chat_number: num(c.number),
          site_id: str(c.site_id),
          department_id: str(c.department_id),
          visitor_id: str(c.visitor_id),
          status: str(c.status),
          started_by: str(c.started_by),
          requested_at: str(c.requested_at) ?? ev.occurredAt,
        },
      };
    }
    case 'chat.started':
      return {
        type,
        data: {
          chat_id: str(p.chat_id) ?? ev.aggregateId,
          agent_membership_id: str(p.owner_membership_id),
          offer_id: str(p.offer_id),
          started_at: ev.occurredAt,
          chat_version: num(p.version),
        },
      };
    case 'chat.closed': {
      const c = obj(p.chat);
      return {
        type,
        data: {
          chat_id: str(p.chat_id) ?? ev.aggregateId,
          chat_number: num(c.number),
          site_id: str(c.site_id),
          department_id: str(c.department_id),
          visitor_id: str(c.visitor_id),
          agent_membership_id: str(c.owner_membership_id),
          close_reason: typeof p.reason === 'string' ? p.reason.slice(0, 100) : null,
          closed_by: str(p.closed_by),
          requested_at: str(c.requested_at),
          first_assigned_at: str(c.first_assigned_at),
          first_response_at: str(c.first_response_at),
          closed_at: str(p.closed_at) ?? ev.occurredAt,
        },
      };
    }
    case 'rating.updated':
      return {
        type,
        data: {
          chat_id: str(p.chat_id) ?? ev.aggregateId,
          rating: str(p.rating),
          has_comment: typeof p.comment === 'string' && p.comment.length > 0,
          submitted_at: str(p.submitted_at),
          revised_at: str(p.revised_at),
        },
      };
    case 'offline.submitted': {
      const s = obj(p.submission);
      return {
        type,
        data: {
          submission_id: str(s.id) ?? str(p.submission_id) ?? str(p.id) ?? ev.aggregateId,
          reference: str(s.reference) ?? str(p.reference),
          site_id: str(s.site_id) ?? str(p.site_id),
          department_id: str(s.department_id) ?? str(p.department_id),
          visitor_id: str(s.visitor_id) ?? str(p.visitor_id),
          source_chat_id: str(s.source_chat_id) ?? str(p.source_chat_id),
          submitted_at: str(s.created_at) ?? str(p.created_at) ?? ev.occurredAt,
        },
      };
    }
    case 'trigger.webhook':
      return {
        type,
        data: {
          event_name: typeof p.event_name === 'string' ? p.event_name.slice(0, 100) : null,
          trigger_id: str(p.trigger_id) ?? ev.aggregateId,
          trigger_revision: num(p.trigger_revision),
          source_event_id: str(p.source_event_id),
          source_event_type: str(p.source_event_type),
          site_id: str(p.site_id),
          chat_id: str(p.chat_id),
          visitor_id: str(p.visitor_id),
          session_id: str(p.session_id),
          department_id: str(p.department_id),
        },
      };
    case 'privacy.erased':
      return {
        type,
        data: {
          request_id: str(p.request_id) ?? ev.aggregateId,
          visitor_id: str(p.visitor_id),
          completed_at: str(p.completed_at) ?? ev.occurredAt,
        },
      };
  }
}

export function webhookBody(
  ev: { eventId: string; tenantId: string; occurredAt: string },
  type: string,
  data: Obj,
): WebhookBody {
  return {
    id: ev.eventId,
    type,
    version: WEBHOOK_PAYLOAD_VERSION,
    occurred_at: ev.occurredAt,
    tenant_id: ev.tenantId,
    data,
  };
}
