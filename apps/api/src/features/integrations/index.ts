/**
 * Feature module registration for "integrations" (ch. 55/56): integration tokens,
 * signed webhooks with SSRF-safe delivery, and the connector framework.
 */
import type { Provider, Type } from '@nestjs/common';
import { AuditedPermissionGuard, SecurityTelemetry } from './authz';
import { ConnectorsController } from './connectors/connectors.controller';
import { ConnectorRegistry, ConnectorService } from './connectors/connectors.service';
import { IntegrationTokensController } from './tokens.controller';
import { IntegrationTokensService } from './tokens.service';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WebhookDeliveriesController, WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

export const INTEGRATIONS_PROVIDERS: Provider[] = [
  SecurityTelemetry,
  AuditedPermissionGuard,
  IntegrationTokensService,
  WebhookDispatcher,
  WebhooksService,
  ConnectorRegistry,
  ConnectorService,
];
export const INTEGRATIONS_CONTROLLERS: Type<unknown>[] = [
  IntegrationTokensController,
  WebhooksController,
  WebhookDeliveriesController,
  ConnectorsController,
];
