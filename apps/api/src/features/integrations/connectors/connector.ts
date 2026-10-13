/**
 * Connector framework (ch. 55/56). Provider adapters implement this interface;
 * the framework supplies retry classification, external idempotency keys and the
 * tenant-scoped `integration_mappings` record (UNIQUE tenant/provider/source).
 *
 * Honesty rules (ch. 56): an adapter is "disabled" until credentials are configured
 * AND a health check succeeds; `eraseSubject` must distinguish a provider that
 * *confirmed* deletion from one that merely *accepted* a request. No adapter may
 * report success it did not observe from the provider.
 */

export type ConnectorCapability = 'createTicket' | 'updateTicket' | 'exportChat' | 'eraseSubject';
export type ConnectorCategory = 'ticketing' | 'crm' | 'notification' | 'warehouse' | 'test';

export type ConnectorErrorKind = 'retryable' | 'permanent' | 'invalid_credentials' | 'not_supported';

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly providerStatus: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === 'retryable';
  }
}

/** Shared HTTP classification for provider responses (mirrors webhook delivery rules). */
export function classifyProviderStatus(status: number): ConnectorErrorKind | 'ok' {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'invalid_credentials';
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500)
    return 'retryable';
  return 'permanent';
}

export interface ConnectorCredentials {
  /** Decrypted only inside the privileged integration service; never logged or returned. */
  [key: string]: string;
}

export interface ConnectorContext {
  tenantId: string;
  credentials: ConnectorCredentials;
  /** Stable key derived from tenant/source so provider-side retries de-duplicate. */
  idempotencyKey: string;
  timeoutMs: number;
}

export interface TicketInput {
  sourceType: 'chat' | 'offline_submission';
  sourceId: string;
  subject: string;
  /** Public transcript only; internal notes require explicit privileged mapping. */
  publicTranscript: Array<{ at: string; author: 'visitor' | 'agent' | 'system'; text: string }>;
  requester: { verified: boolean; displayName: string; email: string | null };
  siteId: string;
  departmentId: string | null;
  tags: string[];
}

export interface ChatExportInput {
  chatId: string;
  format: 'json' | 'text';
  publicTranscript: TicketInput['publicTranscript'];
}

export interface SubjectErasureInput {
  /** Provider-side identifiers previously mapped for this subject. */
  externalIds: string[];
  subjectRef: string;
}

export interface SubjectErasureResult {
  /** `confirmed` only when the provider states the data is deleted; `accepted` when it queued a request. */
  status: 'confirmed' | 'accepted';
  externalRequestId: string | null;
}

export interface ConnectorAdapter {
  readonly key: string;
  readonly displayName: string;
  readonly category: ConnectorCategory;
  readonly capabilities: readonly ConnectorCapability[];
  /** True for test doubles: never registered in production and never shown as a real provider. */
  readonly testOnly: boolean;
  authenticate(ctx: ConnectorContext): Promise<{ accountLabel: string }>;
  healthCheck(ctx: ConnectorContext): Promise<{ healthy: boolean; detail: string }>;
  createTicket?(ctx: ConnectorContext, input: TicketInput): Promise<{ externalId: string; created: boolean }>;
  updateTicket?(
    ctx: ConnectorContext,
    externalId: string,
    input: Partial<TicketInput>,
  ): Promise<{ externalId: string; revision: number | null }>;
  exportChat?(ctx: ConnectorContext, input: ChatExportInput): Promise<{ externalId: string }>;
  eraseSubject?(ctx: ConnectorContext, input: SubjectErasureInput): Promise<SubjectErasureResult>;
}

/** Catalog entry for a provider whose adapter is planned but not shipped. */
export interface ConnectorDescriptor {
  key: string;
  displayName: string;
  category: ConnectorCategory;
  capabilities: readonly ConnectorCapability[];
  /** Fields an admin would have to configure; values are never returned. */
  credentialFields: readonly string[];
  /** Data that would be transmitted, documented per ch. 56. */
  transmits: readonly string[];
}

export type ConnectorStatus = 'disabled' | 'configured_unverified' | 'healthy' | 'unhealthy';
export type ConnectorStatusReason =
  | 'no_credentials'
  | 'adapter_not_available'
  | 'health_check_failed'
  | 'health_check_passed'
  | 'awaiting_health_check';
