import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, badRequest, body, denied, Require, type AuthContext } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { entityVersion, requireVersion, verbatimBody } from '../triggers/http-utils';
import { CANNED_PLACEHOLDERS } from './placeholders';
import { MAX_BODY, ShortcutsService } from './shortcuts.service';

const uuid = z.string().uuid();
const scopeType = z.enum(['tenant', 'department', 'personal']);
const listSchema = z
  .object({
    q: z.string().max(100).optional(),
    scope: z.enum(['tenant', 'department', 'personal', 'all']).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    includeArchived: z.enum(['true', 'false']).optional(),
    enabled: z.enum(['true', 'false']).optional(),
  })
  .strict();
const createSchema = z
  .object({
    slug: z.string().min(1).max(40),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(MAX_BODY * 2),
    scopeType,
    scopeId: uuid.nullable().optional(),
    options: z.array(z.string().max(60)).max(8).optional(),
    tags: z.array(z.string().max(64)).max(10).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    slug: z.string().min(1).max(40).optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(MAX_BODY * 2).optional(),
    options: z.array(z.string().max(60)).max(8).optional(),
    tags: z.array(z.string().max(64)).max(10).optional(),
    enabled: z.boolean().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
const archiveSchema = z.object({ expectedVersion: z.number().int().positive().optional() }).strict();
const sampleSchema = z.object(Object.fromEntries(CANNED_PLACEHOLDERS.map((k) => [k, z.string().max(200).nullable().optional()])) as Record<(typeof CANNED_PLACEHOLDERS)[number], z.ZodOptional<z.ZodNullable<z.ZodString>>>).strict();
const renderSchema = z.object({ chatId: uuid.optional(), sample: sampleSchema.optional() }).strict();
const renderPreviewSchema = z.object({ body: z.string().min(1).max(MAX_BODY * 2), options: z.array(z.string().max(60)).max(8).optional(), chatId: uuid.optional(), sample: sampleSchema.optional() }).strict();
const previewSchema = z.object({ csvText: z.string().min(1).max(250_000) }).strict();
const commitSchema = z.object({ previewToken: z.string().min(16).max(200) }).strict();

const anyManage = (auth: AuthContext) =>
  auth.permissions.has('shortcuts.manage_shared') || auth.permissions.has('shortcuts.manage_department') || auth.permissions.has('shortcuts.manage_personal');

/** Canned replies (ch. 18 / 44 / 77). Scope permissions are enforced per reply in the service. */
@Controller('shortcuts')
export class ShortcutsController {
  constructor(
    private readonly shortcuts: ShortcutsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Require('shortcuts.view')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.shortcuts.list(auth, {
      q: q.q,
      scope: q.scope,
      cursor: q.cursor,
      limit: q.limit,
      includeArchived: q.includeArchived === 'true',
      enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
    });
  }

  /** RFC 4180 export of the replies visible to the caller (declared before `:id`). */
  @Get('export.csv')
  @Require('shortcuts.view')
  async exportCsv(@Auth() auth: AuthContext, @Res() res: Response) {
    const csv = await this.shortcuts.exportCsv(auth);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="canned-replies.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(csv);
  }

  @Post('import-preview')
  @HttpCode(200)
  @Require('shortcuts.manage_shared')
  importPreview(@Auth() auth: AuthContext, @Body(body(previewSchema)) input: z.infer<typeof previewSchema>) {
    return this.shortcuts.importPreview(auth, input.csvText);
  }

  @Post('import-commit')
  @Require('shortcuts.manage_shared')
  async importCommit(
    @Auth() auth: AuthContext,
    @Body(body(commitSchema)) input: z.infer<typeof commitSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId ?? auth.tokenId}`, 'shortcuts.import-commit', validateIdempotencyKey(key), input, async () => ({
      status: 201,
      body: await this.shortcuts.importCommit(auth, input.previewToken),
    }));
    res.status(r.status);
    return r.body;
  }

  @Post()
  @Require('shortcuts.view')
  async create(
    @Auth() auth: AuthContext,
    @Body(body(createSchema)) input: z.infer<typeof createSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!anyManage(auth)) throw denied('You cannot create replies');
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId ?? auth.tokenId}`, 'shortcuts.create', validateIdempotencyKey(key), input, async () => ({
      status: 201,
      body: await this.shortcuts.create(auth, input),
    }));
    res.status(r.status);
    res.setHeader('Location', `/api/v1/shortcuts/${(r.body as { id: string }).id}`);
    return r.body;
  }

  @Get(':id')
  @Require('shortcuts.view')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shortcuts.get(auth, id);
  }

  @Patch(':id')
  @Require('shortcuts.view')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(patchSchema)) input: z.infer<typeof patchSchema>, @Headers('if-match') ifMatch?: string) {
    const { expectedVersion, ...patch } = input;
    if (!Object.keys(patch).length) throw badRequest('Nothing to change');
    return this.shortcuts.update(auth, id, patch, requireVersion(ifMatch, expectedVersion));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('shortcuts.view')
  archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(archiveSchema)) input: z.infer<typeof archiveSchema>, @Headers('if-match') ifMatch?: string) {
    return this.shortcuts.archive(auth, id, entityVersion(ifMatch, input.expectedVersion));
  }

  /** Preview unsaved editor text (same engine as `:id/render`); never stores or sends anything. */
  @Post('render-preview')
  @HttpCode(200)
  @Require('shortcuts.view')
  renderPreview(@Auth() auth: AuthContext, @Body(verbatimBody(renderPreviewSchema, ['sample'])) input: z.infer<typeof renderPreviewSchema>) {
    return this.shortcuts.renderPreview(auth, input);
  }

  /** Server-side preview/insert text for a chat (or sample values); never sends anything. */
  @Post(':id/render')
  @HttpCode(200)
  @Require('shortcuts.view')
  render(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(verbatimBody(renderSchema, ['sample'])) input: z.infer<typeof renderSchema>) {
    return this.shortcuts.render(auth, id, input);
  }
}
