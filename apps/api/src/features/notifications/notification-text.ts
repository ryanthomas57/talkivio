/**
 * In-app notification copy (ch. 14). With the member's `privacyMode`
 * preference on, text is generic: no visitor names, message previews, notes or
 * references — only what happened and where to look.
 */
import { createHash } from 'node:crypto';

export type NotificationKind = 'chat.assigned' | 'chat.transfer_offered' | 'chat.transferred' | 'chat.transferred_away' | 'offline.submitted';

export interface NotificationContext {
  chatNumber?: number | null;
  visitorName?: string | null;
  preview?: string | null;
  from?: string | null;
  note?: string | null;
  reference?: string | null;
  submitterName?: string | null;
  departmentName?: string | null;
}

export const PREVIEW_MAX = 140;

export function clip(text: string | null | undefined, max = PREVIEW_MAX): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function notificationText(kind: NotificationKind, ctx: NotificationContext, privacyMode: boolean): { title: string; body: string } {
  const chat = ctx.chatNumber ? `chat #${ctx.chatNumber}` : 'a chat';
  if (privacyMode) {
    switch (kind) {
      case 'chat.assigned':
        return { title: 'New chat assigned to you', body: 'Open Talkivio to respond.' };
      case 'chat.transfer_offered':
        return { title: 'Chat transfer request', body: 'A teammate wants to transfer a chat to you.' };
      case 'chat.transferred':
        return { title: 'A chat was transferred to you', body: 'Open Talkivio to continue the conversation.' };
      case 'chat.transferred_away':
        return { title: 'A chat was reassigned', body: 'A supervisor moved one of your chats to another agent.' };
      case 'offline.submitted':
        return { title: 'New offline message', body: 'Open Talkivio to view it.' };
    }
  }
  const who = clip(ctx.visitorName, 60) || 'A visitor';
  const preview = clip(ctx.preview);
  switch (kind) {
    case 'chat.assigned':
      return { title: `New ${chat} assigned to you`, body: preview ? `${who}: ${preview}` : `${who} is waiting.` };
    case 'chat.transfer_offered': {
      const from = clip(ctx.from, 60) || 'A teammate';
      const note = clip(ctx.note);
      return { title: `${from} wants to transfer ${chat} to you`, body: note ? `Note: ${note}` : `${who} is waiting for a reply.` };
    }
    case 'chat.transferred':
      return { title: `${capitalize(chat)} was transferred to you`, body: `A supervisor assigned you the conversation with ${who}.` };
    case 'chat.transferred_away':
      return { title: `${capitalize(chat)} was reassigned`, body: `A supervisor moved your conversation with ${who} to another agent.` };
    case 'offline.submitted': {
      const name = clip(ctx.submitterName, 60) || 'A visitor';
      const where = ctx.departmentName ? ` for ${clip(ctx.departmentName, 60)}` : '';
      return { title: `New offline message${ctx.reference ? ` ${ctx.reference}` : ''}${where}`, body: preview ? `${name}: ${preview}` : `${name} left a message.` };
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Deterministic UUID (RFC 9562 version 8) from tenant, dedupe key and recipient. */
export function notificationId(tenantId: string, dedupeKey: string, membershipId: string): string {
  const h = createHash('sha256').update(`${tenantId}|${dedupeKey}|${membershipId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
