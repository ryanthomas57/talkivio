import { describe, expect, it } from 'vitest';
import { notificationId, notificationText } from './notification-text';

describe('notification text', () => {
  const ctx = { chatNumber: 42, visitorName: 'Jane Doe', preview: 'My card 4242 was charged twice', from: 'Sam', note: 'VIP', reference: 'OFF-7', submitterName: 'Jane' };

  it('includes chat context when privacy mode is off', () => {
    expect(notificationText('chat.assigned', ctx, false)).toEqual({ title: 'New chat #42 assigned to you', body: 'Jane Doe: My card 4242 was charged twice' });
    expect(notificationText('chat.transfer_offered', ctx, false).title).toBe('Sam wants to transfer chat #42 to you');
    expect(notificationText('offline.submitted', ctx, false).title).toBe('New offline message OFF-7');
  });

  it('uses generic text without names, previews or references in privacy mode', () => {
    for (const kind of ['chat.assigned', 'chat.transfer_offered', 'chat.transferred', 'chat.transferred_away', 'offline.submitted'] as const) {
      const t = notificationText(kind, ctx, true);
      const text = `${t.title} ${t.body}`;
      for (const secret of ['Jane', '4242', 'VIP', 'OFF-7', 'Sam', '#42']) expect(text).not.toContain(secret);
    }
  });

  it('clips long previews', () => {
    const t = notificationText('chat.assigned', { ...ctx, preview: 'x'.repeat(500) }, false);
    expect(t.body.length).toBeLessThanOrEqual('Jane Doe: '.length + 140);
  });
});

describe('notificationId', () => {
  it('is deterministic per tenant, dedupe key and recipient (idempotent redelivery)', () => {
    const a = notificationId('t', 'offer:1', 'm');
    expect(a).toBe(notificationId('t', 'offer:1', 'm'));
    expect(a).not.toBe(notificationId('t', 'offer:1', 'n'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
