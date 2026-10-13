import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, body, Public, Require, Visitor, type AuthContext, type VisitorContext } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { VisitorGuard } from '../widget/capability';
import { ExportsService } from './exports.service';

const uuid = z.string().uuid();
const filtersSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    siteId: uuid.optional(),
    departmentId: uuid.optional(),
    agentId: uuid.optional(),
    status: z.enum(['active', 'closed', 'queued']).optional(),
    rating: z.enum(['good', 'bad', 'none']).optional(),
    tagId: uuid.optional(),
  })
  .strict();
const exportSchema = z
  .object({
    chatIds: z.array(uuid).min(1).max(500).optional(),
    filters: filtersSchema.optional(),
    format: z.enum(['txt', 'json', 'csv', 'pdf']),
    timezone: z.string().min(1).max(64).default('UTC'),
    includeInternal: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !!v.chatIds !== !!v.filters, { message: 'Provide either chat_ids or filters', path: ['chatIds'] });
const previewSchema = z
  .object({
    chatIds: z.array(uuid).min(1).max(500).optional(),
    filters: filtersSchema.optional(),
    format: z.enum(['txt', 'json', 'csv', 'pdf']).default('json'),
    includeInternal: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !!v.chatIds !== !!v.filters, { message: 'Provide either chat_ids or filters', path: ['chatIds'] });
const transcriptEmailSchema = z.object({ recipient: z.string().min(3).max(200), format: z.enum(['txt', 'pdf']).default('txt'), includeInternal: z.boolean().default(false) }).strict();
const visitorExportSchema = z.object({ format: z.enum(['txt', 'pdf']), timezone: z.string().max(64).nullable().optional() }).strict();
const visitorEmailSchema = z.object({ email: z.string().min(3).max(200), format: z.enum(['txt', 'pdf']).default('txt') }).strict();

/** Agent export jobs (ch. 44). */
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Require('exports.create')
  async create(@Auth() auth: AuthContext, @Body(body(exportSchema)) input: z.infer<typeof exportSchema>, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId}`, 'exports.create', validateIdempotencyKey(key), input, async () => ({ status: 202, body: await this.exports.create(auth, input) }));
    res.status(r.status);
    return r.body;
  }

  /** Count preview for bulk history exports (no writes). */
  @Post('preview')
  @HttpCode(200)
  @Require('exports.create')
  preview(@Auth() auth: AuthContext, @Body(body(previewSchema)) input: z.infer<typeof previewSchema>) {
    return this.exports.preview(auth, input);
  }

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.exports.list(auth);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.get(auth, id);
  }

  @Get(':id/download')
  @Require('exports.create')
  download(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.downloadGrant(auth, id);
  }

  @Public()
  @Get(':id/content')
  async content(@Param('id', ParseUUIDPipe) id: string, @Query('sig') sig: string | undefined, @Res() res: Response): Promise<void> {
    await this.exports.serveContent('agent', id, sig, res);
  }
}

/** Agent transcript email (ch. 44). */
@Controller('chats')
export class TranscriptEmailController {
  constructor(
    private readonly exports: ExportsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post(':id/transcript-email')
  @Require('exports.create')
  async send(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body(transcriptEmailSchema)) input: z.infer<typeof transcriptEmailSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId}`, `chats.transcript-email:${id}`, validateIdempotencyKey(key), input, async () => ({
      status: 202,
      body: await this.exports.agentTranscriptEmail(auth, id, input),
    }));
    res.status(r.status);
    return r.body;
  }

  @Get(':id/transcript-emails/:jobId')
  status(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.exports.agentTranscriptEmailStatus(auth, id, jobId);
  }
}

/** Public widget transcript endpoints (ch. 46 + ch. 77 REST fallbacks). */
@Controller('widget/v1')
export class WidgetExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Public()
  @UseGuards(VisitorGuard)
  @Post('chats/:id/exports')
  @HttpCode(202)
  create(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(visitorExportSchema)) input: z.infer<typeof visitorExportSchema>) {
    return this.exports.createVisitorExport(v, id, input);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Get('exports/:id')
  get(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.getVisitorExport(v, id);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Get('exports/:id/download')
  download(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.visitorDownloadGrant(v, id);
  }

  @Public()
  @Get('exports/:id/content')
  async content(@Param('id', ParseUUIDPipe) id: string, @Query('sig') sig: string | undefined, @Res() res: Response): Promise<void> {
    await this.exports.serveContent('widget', id, sig, res);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Post('chats/:id/transcript-email')
  @HttpCode(202)
  email(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(visitorEmailSchema)) input: z.infer<typeof visitorEmailSchema>) {
    return this.exports.visitorTranscriptEmail(v, id, input);
  }
}
