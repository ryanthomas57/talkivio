import { describe, expect, it } from 'vitest';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { chatIdOf, toWebhookData, webhookBody } from './webhook-events';

const ev = (eventType: string, payload: Record<string, unknown>, aggregateType = 'chat'): InternalEvent => ({
  eventId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  eventType,
  aggregateType,
  aggregateId: '33333333-3333-4333-8333-333333333333',
  aggregateVersion: 1,
  payload,
  causationId: null,
  occurredAt: '2026-10-12T08:00:00.000Z',
});

describe('webhook event mapping', () => {
  it('maps internal events to the public contract with identifiers only', () => {
    const requested = toWebhookData(
      ev('chat.requested', {
        chat: { id: 'c1', number: 7, site_id: 's1', visitor_id: 'v1', status: 'queued' },
        initial_message: { body: 'secret text' },
      }),
    );
    expect(requested?.type).toBe('chat.requested');
    expect(JSON.stringify(requested)).not.toContain('secret text');
    expect(toWebhookData(ev('assignment.accepted', { chat_id: 'c1', owner_membership_id: 'm1' }))?.type).toBe(
      'chat.started',
    );
    const rating = toWebhookData(
      ev('rating.updated', { chat_id: 'c1', rating: 'good', comment: 'personal words' }),
    );
    expect(rating?.data).toMatchObject({ rating: 'good', has_comment: true });
    expect(JSON.stringify(rating)).not.toContain('personal words');
    expect(toWebhookData(ev('message.created', {}))).toBeNull();
  });

  it('maps offline submissions and trigger webhook jobs', () => {
    const offline = toWebhookData(
      ev(
        'offline.submitted',
        { submission: { id: 'o1', reference: 'R-1', site_id: 's1', email_masked: 'a***' } },
        'offline_submission',
      ),
    );
    expect(offline?.data).toMatchObject({ submission_id: 'o1', reference: 'R-1' });
    const trig = toWebhookData(
      ev(
        'trigger.webhook',
        { event_name: 'vip_chat', trigger_id: 't1', trigger_revision: 2, chat_id: 'c9', visitor_id: 'v1' },
        'trigger',
      ),
    );
    expect(trig).toEqual({
      type: 'trigger.webhook',
      data: expect.objectContaining({
        event_name: 'vip_chat',
        trigger_id: 't1',
        trigger_revision: 2,
        chat_id: 'c9',
        visitor_id: 'v1',
      }),
    });
    expect(chatIdOf(ev('trigger.webhook', { chat_id: 'c9' }, 'trigger'))).toBe('c9');
  });

  it('builds the envelope with a stable event id', () => {
    const e = ev('chat.closed', { chat_id: 'c1' });
    expect(webhookBody(e, 'chat.closed', {})).toEqual({
      id: e.eventId,
      type: 'chat.closed',
      version: 1,
      occurred_at: e.occurredAt,
      tenant_id: e.tenantId,
      data: {},
    });
  });
});
