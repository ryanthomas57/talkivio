/** Sample content for the dashboard live preview (`?preview=1`). No network access. */
import { mergeWidgetConfig, type MessageDTO, type PublicAgent, type PublicDepartment, type WidgetConfig } from '@talkivio/contracts/protocol';
import type { PreviewState } from '../common/protocol';
import type { State, UiMessage } from './state';

export const SAMPLE_AGENT: PublicAgent = { id: 'preview-alex', name: 'Alex', avatarUrl: null, title: 'Customer support' };
export const SAMPLE_DEPARTMENTS: PublicDepartment[] = [
  { id: 'preview-sales', name: 'Sales', online: true },
  { id: 'preview-support', name: 'Support', online: true },
  { id: 'preview-billing', name: 'Billing', online: false },
];

function msg(id: string, authorType: MessageDTO['authorType'], body: string, at: number, extra: Partial<MessageDTO> = {}): UiMessage {
  return {
    id,
    conversationId: 'preview-conversation',
    type: 'TEXT',
    authorType,
    agentId: authorType === 'AGENT' ? SAMPLE_AGENT.id : null,
    authorName: authorType === 'AGENT' ? SAMPLE_AGENT.name : authorType === 'VISITOR' ? 'Visitor' : 'System',
    authorAvatarUrl: null,
    body,
    attachments: [],
    event: null,
    options: [],
    clientId: null,
    createdAt: new Date(at).toISOString(),
    readByVisitorAt: authorType === 'AGENT' ? new Date(at).toISOString() : null,
    ...extra,
  };
}

function sampleTranscript(ended: boolean): UiMessage[] {
  const t0 = Date.now() - 7 * 60_000;
  const list: UiMessage[] = [
    msg('preview-1', 'VISITOR', 'Hi! Do you ship to Canada?', t0),
    msg('preview-2', 'SYSTEM', `${SAMPLE_AGENT.name} joined the chat`, t0 + 30_000, { type: 'EVENT', event: { kind: 'chat.agent_joined', data: {} } }),
    msg('preview-3', 'AGENT', 'Hi there 👋 Yes, we do. Orders to Canada usually arrive within 3–5 business days.', t0 + 55_000),
    msg('preview-4', 'AGENT', 'Is there anything else I can help you with?', t0 + 70_000, { options: ['Track my order', 'Returns', 'Pricing'] }),
    msg('preview-5', 'VISITOR', 'That’s great, thank you!', t0 + 140_000),
  ];
  if (ended) list.push(msg('preview-6', 'SYSTEM', 'Chat ended', t0 + 200_000, { type: 'EVENT', event: { kind: 'chat.ended', data: {} } }));
  return list;
}

/** Build the full widget state for one preview scenario. */
export function previewState(base: State, rawConfig: unknown, state: PreviewState, online?: boolean): Partial<State> {
  let config: WidgetConfig = mergeWidgetConfig(rawConfig);
  const isOnline = online ?? state !== 'offline';
  const b = config.behavior;
  if (state === 'greeting') {
    config = { ...config, behavior: { ...b, greeting: { ...b.greeting, enabled: true, showOnMobile: true, message: b.greeting.message || 'Questions? We are here to help.' } } };
  }
  if (state === 'prechat') {
    const p = b.prechatForm;
    const allHidden = p.name === 'hidden' && p.email === 'hidden' && p.phone === 'hidden' && p.department === 'hidden';
    config = {
      ...config,
      behavior: { ...b, prechatForm: { ...p, enabled: true, ...(allHidden ? { name: 'optional', email: 'required' } : {}) } },
    };
  }
  if (state === 'welcome') config = { ...config, behavior: { ...config.behavior, prechatForm: { ...config.behavior.prechatForm, enabled: false } } };

  const chat = state === 'chat' || state === 'ended';
  return {
    ...base,
    preview: true,
    configLoaded: true,
    sessionReady: true,
    connection: 'connected',
    fatal: null,
    config,
    account: { online: isOnline, departments: SAMPLE_DEPARTMENTS.map((d) => ({ ...d, online: isOnline && d.online })) },
    visitor: { id: 'preview-visitor', name: null, email: null, phone: null },
    conversation: chat
      ? { id: 'preview-conversation', status: state === 'ended' ? 'RESOLVED' : 'ACTIVE', agents: [SAMPLE_AGENT], rating: null, ratingComment: null, queuePosition: null }
      : null,
    messages: chat ? sampleTranscript(state === 'ended') : [],
    proactive: [],
    typing: state === 'chat' ? [SAMPLE_AGENT] : [],
    open: !(state === 'launcher' || state === 'greeting'),
    closing: false,
    hiddenByApi: false,
    banned: false,
    seen: [],
    greetingDue: state === 'greeting',
    offline: null,
    offlineDraft: null,
    offlineSent: null,
    prechatDone: state !== 'prechat',
    notice: null,
    ratingRequested: false,
  };
}
