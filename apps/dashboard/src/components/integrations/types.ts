/**
 * Client shapes for the integrations feature (camelCase after wire conversion).
 * Mirrors `apps/api/src/features/integrations/*` projections — keep in sync.
 */

export type TokenStatus = 'active' | 'expired' | 'revoked';

export interface IntegrationToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: TokenStatus;
  /** User id of the administrator who created the token. */
  createdBy: string | null;
  /** Their display name, resolved by the API (null when unknown, e.g. the user was deleted). */
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
}

/** Create/rotate response: the plaintext token is present exactly once. */
export interface IntegrationTokenWithSecret extends IntegrationToken {
  token: string | null;
  tokenShownOnce: boolean;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  /** `whsec_…abcd` — never the secret itself. */
  secretHint: string;
  signingGeneration: number;
  /** Set while the previous secret still signs deliveries (rotation overlap). */
  previousSecretExpiresAt: string | null;
  lastSuccessAt: string | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** GET /webhooks items: the endpoint plus its latest delivery attempt (one query server-side). */
export interface WebhookListItem extends WebhookEndpoint {
  lastDelivery: { eventType: string; status: DeliveryStatus; responseStatus: number | null; error: string | null; at: string } | null;
}

export interface WebhookWithSecret extends WebhookEndpoint {
  secret: string | null;
  secretShownOnce: boolean;
}

export type DeliveryStatus = 'pending' | 'sending' | 'retrying' | 'delivered' | 'failed' | 'dead' | 'cancelled';

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseExcerpt: string | null;
  lastError: string | null;
  durationMs: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface WebhookEventTypes {
  eventTypes: string[];
  signature: { header: string; scheme: string; timestampHeader: string; toleranceSeconds: number };
  retryScheduleSeconds: number[];
}

export type ConnectorStatus = 'disabled' | 'configured_unverified' | 'healthy' | 'unhealthy';
export type ConnectorStatusReason = 'no_credentials' | 'adapter_not_available' | 'health_check_failed' | 'health_check_passed' | 'awaiting_health_check';

export interface Connector {
  key: string;
  displayName: string;
  category: string;
  capabilities: string[];
  status: ConnectorStatus;
  statusReason: ConnectorStatusReason;
  adapterAvailable: boolean;
  credentialFields: string[];
  transmits: string[];
  note: string;
}

/** POST /integrations/connectors/{key}/health-check: a real, uncached check run by the adapter. */
export interface ConnectorHealth extends Connector {
  checkedAt: string;
  detail: string;
}

export const integrationKeys = {
  tokens: (includeRevoked: boolean) => ['integration-tokens', { includeRevoked }] as const,
  tokensAll: ['integration-tokens'] as const,
  tokenScopes: ['integration-token-scopes'] as const,
  webhooks: ['webhooks'] as const,
  webhook: (id: string) => ['webhooks', 'detail', id] as const,
  eventTypes: ['webhooks', 'event-types'] as const,
  deliveries: (id: string, status: string | null) => ['webhook-deliveries', id, { status }] as const,
  deliveriesFor: (id: string) => ['webhook-deliveries', id] as const,
  connectors: ['integration-connectors'] as const,
};
