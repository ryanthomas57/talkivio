import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Auth, type AuthContext, conflict, notFound } from '../../../common/http';
import { AuditedRequire } from '../authz';
import { ConnectorService } from './connectors.service';

/** Connector catalog with honest status (ch. 56): nothing claims to work without credentials and a passing health check. */
@Controller('integrations/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorService) {}

  @Get()
  @AuditedRequire('connector', 'integrations.manage')
  list(@Auth() auth: AuthContext) {
    return this.connectors.list(auth.tenantId);
  }

  @Post(':key/health-check')
  @HttpCode(200)
  @AuditedRequire('connector', 'integrations.manage')
  async health(@Auth() auth: AuthContext, @Param('key') key: string) {
    const entry = (await this.connectors.list(auth.tenantId)).find((c) => c.key === key);
    if (!entry) throw notFound('Connector');
    if (!entry.adapterAvailable)
      throw conflict(
        'INTEGRATION_UNAVAILABLE',
        `${entry.displayName} is not available in this release`,
        false,
        { status: entry.status, status_reason: entry.statusReason },
      );
    if (entry.statusReason === 'no_credentials')
      throw conflict('INTEGRATION_UNAVAILABLE', `Configure ${entry.displayName} credentials first`, false, {
        status: entry.status,
        status_reason: entry.statusReason,
      });
    return this.connectors.healthCheck(auth.tenantId, key);
  }
}
