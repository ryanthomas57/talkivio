'use client';
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Loader2, RotateCw, Skull, XCircle } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui';
import { useT, type MessageKey, type Translate } from '@/i18n';
import type { DeliveryStatus } from './types';

/**
 * Plain-language descriptions of the outbound event contract (ch. 55). The event type names themselves
 * are protocol codes and stay as-is; unknown types fall back to their name.
 */
export const EVENT_INFO: Record<string, { label: MessageKey; description: MessageKey }> = {
  'chat.requested': { label: 'integrations.event.chatRequested.label', description: 'integrations.event.chatRequested.description' },
  'chat.started': { label: 'integrations.event.chatStarted.label', description: 'integrations.event.chatStarted.description' },
  'chat.closed': { label: 'integrations.event.chatClosed.label', description: 'integrations.event.chatClosed.description' },
  'rating.updated': { label: 'integrations.event.ratingUpdated.label', description: 'integrations.event.ratingUpdated.description' },
  'offline.submitted': { label: 'integrations.event.offlineSubmitted.label', description: 'integrations.event.offlineSubmitted.description' },
  'privacy.erased': { label: 'integrations.event.privacyErased.label', description: 'integrations.event.privacyErased.description' },
  'trigger.webhook': { label: 'integrations.event.triggerWebhook.label', description: 'integrations.event.triggerWebhook.description' },
  'webhook.test': { label: 'integrations.event.webhookTest.label', description: 'integrations.event.webhookTest.description' },
};

export function eventLabel(t: Translate, type: string): string {
  const info = EVENT_INFO[type];
  return info ? t(info.label) : type;
}

export function eventDescription(t: Translate, type: string): string | undefined {
  const info = EVENT_INFO[type];
  return info ? t(info.description) : undefined;
}

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, MessageKey> = {
  pending: 'integrations.delivery.status.pending',
  sending: 'integrations.delivery.status.sending',
  retrying: 'integrations.delivery.status.retrying',
  delivered: 'integrations.delivery.status.delivered',
  failed: 'integrations.delivery.status.failed',
  dead: 'integrations.delivery.status.dead',
  cancelled: 'integrations.delivery.status.cancelled',
};

const DELIVERY: Record<DeliveryStatus, { tone: BadgeTone; Icon: typeof CheckCircle2; spin?: boolean }> = {
  pending: { tone: 'info', Icon: Clock },
  sending: { tone: 'info', Icon: Loader2, spin: true },
  retrying: { tone: 'warning', Icon: RotateCw },
  delivered: { tone: 'success', Icon: CheckCircle2 },
  failed: { tone: 'danger', Icon: XCircle },
  dead: { tone: 'danger', Icon: Skull },
  cancelled: { tone: 'neutral', Icon: CircleDashed },
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useT();
  const known = DELIVERY[status];
  const m = known ? { ...known, label: t(DELIVERY_STATUS_LABEL[status]) } : { label: status, tone: 'neutral' as const, Icon: AlertTriangle, spin: false };
  return (
    <Badge tone={m.tone} icon={<m.Icon className={m.spin ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />}>
      {m.label}
    </Badge>
  );
}

/** Protocol header names (codes: shown as-is, left-to-right). */
export const TIMESTAMP_HEADER = 'X-Talkivio-Timestamp';
export const SIGNATURE_HEADER = 'X-Talkivio-Signature';
export const EVENT_ID_HEADER = 'X-Talkivio-Event-Id';

/** Delivery states that the API will still attempt (retry is refused for these). */
export const IN_FLIGHT: ReadonlySet<string> = new Set(['pending', 'sending', 'retrying']);

/** Filter choices for the delivery history (API `status` values). */
export const DELIVERY_FILTERS: Array<{ value: DeliveryStatus | ''; label: MessageKey }> = [
  { value: '', label: 'integrations.delivery.filterAll' },
  { value: 'pending', label: 'integrations.delivery.status.pending' },
  { value: 'retrying', label: 'integrations.delivery.status.retrying' },
  { value: 'delivered', label: 'integrations.delivery.status.delivered' },
  { value: 'failed', label: 'integrations.delivery.status.failed' },
  { value: 'dead', label: 'integrations.delivery.status.dead' },
  { value: 'sending', label: 'integrations.delivery.status.sending' },
  { value: 'cancelled', label: 'integrations.delivery.status.cancelled' },
];

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
