import { Injectable, Logger } from '@nestjs/common';
import { sha256 } from '../../../common/crypto';
import { conflict } from '../../../common/http';
import { TenantDb } from '../../../db/tenant-db';
import {
  type ConnectorAdapter,
  type ConnectorContext,
  type ConnectorDescriptor,
  ConnectorError,
  type ConnectorStatus,
  type ConnectorStatusReason,
  type TicketInput,
} from './connector';

/**
 * Provider catalog. These adapters are NOT implemented in this release: no
 * provider credentials were available to verify them against current official API
 * documentation (ch. 56 requires that before shipping). They are listed so admins
 * see an honest "disabled" state rather than a missing feature.
 */
export const CONNECTOR_CATALOG: readonly ConnectorDescriptor[] = [
  {
    key: 'zendesk',
    displayName: 'Zendesk Support',
    category: 'ticketing',
    capabilities: ['createTicket', 'updateTicket', 'eraseSubject'],
    credentialFields: ['subdomain', 'email', 'api_token'],
    transmits: [
      'chat subject',
      'public transcript (no internal notes)',
      'requester display name and verified flag',
      'site',
      'department',
      'tags',
    ],
  },
  {
    key: 'hubspot',
    displayName: 'HubSpot CRM',
    category: 'crm',
    capabilities: ['exportChat', 'eraseSubject'],
    credentialFields: ['private_app_token'],
    transmits: ['verified external identity only', 'chat summary metadata', 'public transcript when enabled'],
  },
  {
    key: 'slack',
    displayName: 'Slack notifications',
    category: 'notification',
    capabilities: [],
    credentialFields: ['webhook_url'],
    transmits: ['event type', 'chat number', 'deep link (no transcript text)'],
  },
];

export interface ConnectorListing {
  key: string;
  displayName: string;
  category: string;
  capabilities: readonly string[];
  status: ConnectorStatus;
  statusReason: ConnectorStatusReason;
  adapterAvailable: boolean;
  credentialFields: readonly string[];
  transmits: readonly string[];
  note: string;
}

export interface DownstreamErasure {
  provider: string;
  status: 'not_configured' | 'no_mapped_records' | 'pending_manual' | 'accepted' | 'confirmed' | 'failed';
  mappedRecords: number;
  detail: string;
}

@Injectable()
export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  /** Register a working adapter. Test doubles are refused in production. */
  register(adapter: ConnectorAdapter): void {
    if (adapter.testOnly && process.env.NODE_ENV === 'production')
      throw new Error(`Refusing to register test-only connector ${adapter.key} in production`);
    this.adapters.set(adapter.key, adapter);
  }

  adapter(key: string): ConnectorAdapter | null {
    return this.adapters.get(key) ?? null;
  }

  descriptors(): readonly ConnectorDescriptor[] {
    return CONNECTOR_CATALOG;
  }
}

/**
 * Tenant-facing connector operations: honest status, idempotent ticket creation
 * through `integration_mappings`, and downstream erasure tracking that never claims
 * a third party erased data it only accepted a request for.
 */
@Injectable()
export class ConnectorService {
  private readonly logger = new Logger('Connectors');
  constructor(
    private readonly db: TenantDb,
    private readonly registry: ConnectorRegistry,
  ) {}

  private async configuredKinds(tenantId: string): Promise<Set<string>> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx.integrationCredential.findMany({
        where: { tenantId, kind: { startsWith: 'connector:' }, enabled: true, revokedAt: null },
        select: { kind: true },
      }),
    );
    return new Set(rows.map((r) => r.kind.slice('connector:'.length)));
  }

  async list(tenantId: string): Promise<ConnectorListing[]> {
    const configured = await this.configuredKinds(tenantId);
    return this.registry.descriptors().map((d) => {
      const adapterAvailable = !!this.registry.adapter(d.key);
      const hasCredentials = configured.has(d.key);
      // An adapter missing from this release outranks missing credentials: credentials would not help.
      const statusReason: ConnectorStatusReason = !adapterAvailable ? 'adapter_not_available' : hasCredentials ? 'awaiting_health_check' : 'no_credentials';
      const status: ConnectorStatus =
        adapterAvailable && hasCredentials ? 'configured_unverified' : 'disabled';
      return {
        key: d.key,
        displayName: d.displayName,
        category: d.category,
        capabilities: d.capabilities,
        status,
        statusReason,
        adapterAvailable,
        credentialFields: d.credentialFields,
        transmits: d.transmits,
        note: adapterAvailable
          ? 'Configure credentials and run a health check to enable.'
          : 'Not available in this release: the adapter has not been verified against the provider’s current API. No data is sent.',
      };
    });
  }

  private context(tenantId: string, scope: string): ConnectorContext {
    // Credentials would be decrypted here by the privileged service; none are configured in this release.
    return {
      tenantId,
      credentials: {},
      idempotencyKey: sha256(`${tenantId}:${scope}`).slice(0, 40),
      timeoutMs: 10_000,
    };
  }

  /** Run the adapter's real health check (never a cached or assumed result). */
  async healthCheck(tenantId: string, key: string): Promise<ConnectorListing & { checkedAt: Date; detail: string }> {
    const entry = (await this.list(tenantId)).find((c) => c.key === key);
    const adapter = this.registry.adapter(key);
    if (!entry || !adapter) throw conflict('INTEGRATION_UNAVAILABLE', 'This connector is not available in this release');
    let result: { healthy: boolean; detail: string };
    try {
      result = await adapter.healthCheck(this.context(tenantId, `health:${key}`));
    } catch (err) {
      result = { healthy: false, detail: err instanceof ConnectorError ? err.message : 'The provider could not be reached' };
    }
    return {
      ...entry,
      status: result.healthy ? 'healthy' : 'unhealthy',
      statusReason: result.healthy ? 'health_check_passed' : 'health_check_failed',
      checkedAt: new Date(),
      detail: result.detail.slice(0, 300),
    };
  }

  /** Create (or find) the external ticket for a source exactly once (UNIQUE tenant/provider/source). */
  async createTicketOnce(
    tenantId: string,
    providerKey: string,
    input: TicketInput,
  ): Promise<{ externalId: string; created: boolean }> {
    const adapter = this.registry.adapter(providerKey);
    if (!adapter?.createTicket) throw conflict('INTEGRATION_UNAVAILABLE', 'This connector is not available');
    const configured = await this.configuredKinds(tenantId);
    if (!configured.has(providerKey) && !adapter.testOnly)
      throw conflict('INTEGRATION_UNAVAILABLE', 'This connector is not configured');
    const existing = await this.db.read(tenantId, (tx) =>
      tx.integrationMapping.findUnique({
        where: {
          tenantId_provider_sourceType_sourceId: {
            tenantId,
            provider: providerKey,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
        },
      }),
    );
    if (existing) return { externalId: existing.externalId, created: false };
    const result = await adapter.createTicket(
      this.context(tenantId, `${providerKey}:${input.sourceType}:${input.sourceId}`),
      input,
    );
    await this.db.tx(tenantId, (tx) =>
      tx.integrationMapping.upsert({
        where: {
          tenantId_provider_sourceType_sourceId: {
            tenantId,
            provider: providerKey,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
        },
        create: {
          tenantId,
          provider: providerKey,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          externalId: result.externalId,
          status: 'active',
        },
        update: {},
      }),
    );
    return result;
  }

  /**
   * Ask configured downstream providers to erase records mapped to the subject's
   * sources. Returns per-provider status; unconfigured or unavailable adapters are
   * reported as such (`pending_manual` when records were exported earlier).
   */
  async eraseSubjectDownstream(
    tenantId: string,
    sourceIds: string[],
    subjectRef: string,
  ): Promise<DownstreamErasure[]> {
    const mappings = sourceIds.length
      ? await this.db.read(tenantId, (tx) =>
          tx.integrationMapping.findMany({
            where: { tenantId, sourceId: { in: sourceIds } },
            select: { id: true, provider: true, externalId: true },
          }),
        )
      : [];
    const configured = await this.configuredKinds(tenantId);
    const out: DownstreamErasure[] = [];
    const providers = new Set([
      ...this.registry.descriptors().map((d) => d.key),
      ...mappings.map((m) => m.provider),
    ]);
    for (const provider of providers) {
      const mine = mappings.filter((m) => m.provider === provider);
      const adapter = this.registry.adapter(provider);
      if (!mine.length) {
        out.push({
          provider,
          status: configured.has(provider) ? 'no_mapped_records' : 'not_configured',
          mappedRecords: 0,
          detail: configured.has(provider)
            ? 'No records were sent to this provider for the subject'
            : 'Connector not configured; nothing was sent',
        });
        continue;
      }
      if (!adapter?.eraseSubject || !configured.has(provider)) {
        out.push({
          provider,
          status: 'pending_manual',
          mappedRecords: mine.length,
          detail: 'Records exist at the provider but no working adapter is configured; erase them manually',
        });
        await this.db.tx(tenantId, (tx) =>
          tx.integrationMapping.updateMany({
            where: { id: { in: mine.map((m) => m.id) } },
            data: { status: 'erasure_pending_manual' },
          }),
        );
        continue;
      }
      try {
        const r = await adapter.eraseSubject(this.context(tenantId, `erase:${subjectRef}`), {
          externalIds: mine.map((m) => m.externalId),
          subjectRef,
        });
        await this.db.tx(tenantId, (tx) =>
          tx.integrationMapping.updateMany({
            where: { id: { in: mine.map((m) => m.id) } },
            data: { status: r.status === 'confirmed' ? 'erased' : 'erasure_requested' },
          }),
        );
        out.push({
          provider,
          status: r.status,
          mappedRecords: mine.length,
          detail:
            r.status === 'confirmed'
              ? 'Provider confirmed deletion'
              : 'Provider accepted the request; deletion not yet confirmed',
        });
      } catch (err) {
        const kind = err instanceof ConnectorError ? err.kind : 'retryable';
        this.logger.warn(`Downstream erasure via ${provider} failed (${kind})`);
        out.push({
          provider,
          status: 'failed',
          mappedRecords: mine.length,
          detail: `Provider request failed (${kind})`,
        });
      }
    }
    return out;
  }
}
