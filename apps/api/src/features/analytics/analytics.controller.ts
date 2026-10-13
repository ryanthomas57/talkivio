import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, body, Require, TokenAccess, type AuthContext } from '../../common/http';
import { validateIdempotencyKey } from '../../common/idempotency';
import { AnalyticsService } from './analytics.service';
import { AnalyticsExportService } from './export.service';
import { MonitorService } from './monitor.service';
import {
  agentsQuerySchema,
  chatsQuerySchema,
  exportRequestSchema,
  invitationsQuerySchema,
  monitorQuerySchema,
  type AgentsQuery,
  type ChatsQuery,
  type ExportRequest,
  type InvitationsQuery,
  type MonitorQuery,
} from './schemas';

/** Analytics reports and exports (ch. 45/51). */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly exports: AnalyticsExportService,
  ) {}

  @Get('chats')
  @TokenAccess()
  @Require('analytics.view')
  chats(@Auth() auth: AuthContext, @Query(body(chatsQuerySchema)) q: ChatsQuery) {
    return this.analytics.chatsReport(auth, q);
  }

  @Get('agents')
  @TokenAccess()
  @Require('analytics.view', 'analytics.agents')
  agents(@Auth() auth: AuthContext, @Query(body(agentsQuerySchema)) q: AgentsQuery) {
    return this.analytics.agentsReport(auth, q);
  }

  @Get('invitations')
  @TokenAccess()
  @Require('analytics.view')
  invitations(@Auth() auth: AuthContext, @Query(body(invitationsQuerySchema)) q: InvitationsQuery) {
    return this.analytics.invitationsReport(auth, q);
  }

  @Post('exports')
  @Require('analytics.view')
  async createExport(
    @Auth() auth: AuthContext,
    @Body(body(exportRequestSchema)) input: ExportRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.exports.request(auth, input, validateIdempotencyKey(key));
    res.status(r.status);
    return r.body;
  }

  @Get('exports/:id')
  @Require('analytics.view')
  exportStatus(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.status(auth, id);
  }

  @Get('exports/:id/download')
  @Require('analytics.view')
  async download(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const file = await this.exports.download(auth, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Digest', `sha-256=${Buffer.from(file.sha256, 'hex').toString('base64')}`);
    res.status(200).send(file.csv);
  }
}

/** Supervisor monitoring (ch. 49). */
@Controller('monitor')
export class MonitorController {
  constructor(private readonly monitor: MonitorService) {}

  @Get()
  @TokenAccess()
  @Require('monitor.view')
  get(@Auth() auth: AuthContext, @Query(body(monitorQuerySchema)) q: MonitorQuery) {
    return this.monitor.get(auth, q);
  }
}
