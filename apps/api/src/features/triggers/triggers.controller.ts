import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards, ParseIntPipe } from '@nestjs/common';
import type { Response } from 'express';
import { DSL_EVENTS } from '@talkivio/contracts';
import { z } from 'zod';
import { Auth, body, Public, Require, Visitor, type AuthContext, type VisitorContext } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { VisitorGuard } from '../widget/capability';
import { entityVersion, requireVersion, verbatimBody } from './http-utils';
import { InvitationsService } from './invitations.service';
import { TriggersService } from './triggers.service';

const listSchema = z
  .object({
    event: z.enum(DSL_EVENTS).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    includeArchived: z.enum(['true', 'false']).optional(),
  })
  .strict();
const createSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable().optional(), definition: z.unknown() }).strict();
const patchSchema = z
  .object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).nullable().optional(), enabled: z.boolean().optional(), expectedVersion: z.number().int().positive().optional() })
  .strict();
const draftSchema = z.object({ definition: z.unknown(), expectedVersion: z.number().int().positive().optional() }).strict();
const simulateSchema = z
  .object({
    event: z.enum(DSL_EVENTS),
    snapshot: z.record(z.string(), z.unknown()),
    revision: z.number().int().positive().optional(),
    /** Unsaved editor definition (validated like a draft, never stored); wins over `revision`. */
    definition: z.unknown().optional(),
    includePublished: z.boolean().default(true),
  })
  .strict();
const publishSchema = z.object({ revision: z.number().int().positive(), enabled: z.boolean() }).strict();
const restoreSchema = z.object({ revision: z.number().int().positive() }).strict();
const rangeSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const date = (s?: string) => (s ? new Date(s) : undefined);

/** Automation REST (ch. 45 + ch. 77 metadata routes). Admin manages; supervisors read. */
@Controller('triggers')
export class TriggersController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Require('triggers.view')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.triggers.list(auth, { event: q.event, cursor: q.cursor, limit: q.limit, includeArchived: q.includeArchived === 'true' });
  }

  @Post()
  @Require('triggers.manage')
  async create(
    @Auth() auth: AuthContext,
    @Body(verbatimBody(createSchema, ['definition'])) input: z.infer<typeof createSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId ?? auth.tokenId}`, 'triggers.create', validateIdempotencyKey(key), input, async () => ({
      status: 201,
      body: await this.triggers.create(auth, input),
    }));
    res.status(r.status);
    res.setHeader('Location', `/api/v1/triggers/${(r.body as { id: string }).id}`);
    return r.body;
  }

  @Get(':id')
  @Require('triggers.view')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.triggers.get(auth, id);
  }

  @Patch(':id')
  @Require('triggers.manage')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(patchSchema)) input: z.infer<typeof patchSchema>, @Headers('if-match') ifMatch?: string) {
    const { expectedVersion, ...patch } = input;
    return this.triggers.update(auth, id, patch, requireVersion(ifMatch, expectedVersion));
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('triggers.manage')
  async archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('if-match') ifMatch?: string) {
    await this.triggers.archive(auth, id, entityVersion(ifMatch));
  }

  @Put(':id/draft')
  @Require('triggers.manage')
  draft(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(verbatimBody(draftSchema, ['definition'])) input: z.infer<typeof draftSchema>, @Headers('if-match') ifMatch?: string) {
    return this.triggers.saveDraft(auth, id, input.definition, entityVersion(ifMatch, input.expectedVersion));
  }

  @Post(':id/simulate')
  @HttpCode(200)
  @Require('triggers.manage')
  simulate(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(verbatimBody(simulateSchema, ['snapshot', 'definition'])) input: z.infer<typeof simulateSchema>) {
    return this.triggers.simulate(auth, id, input);
  }

  @Get(':id/revisions/:revision')
  @Require('triggers.view')
  revision(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('revision', ParseIntPipe) revision: number) {
    return this.triggers.revision(auth, id, revision);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Require('triggers.manage')
  publish(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(publishSchema)) input: z.infer<typeof publishSchema>) {
    return this.triggers.publish(auth, id, input);
  }

  @Post(':id/restore')
  @Require('triggers.manage')
  restore(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(restoreSchema)) input: z.infer<typeof restoreSchema>) {
    return this.triggers.restore(auth, id, input.revision);
  }

  @Get(':id/runs')
  @Require('triggers.view')
  runs(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(rangeSchema)) q: z.infer<typeof rangeSchema>) {
    return this.triggers.runs(auth, id, { from: date(q.from), to: date(q.to), cursor: q.cursor, limit: q.limit });
  }

  /** Invitation funnel for a campaign trigger: eligible / displayed / accepted / served, distinct by invitation id. */
  @Get(':id/funnel')
  @Require('triggers.view')
  funnel(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(rangeSchema.pick({ from: true, to: true }))) q: { from?: string; to?: string }) {
    return this.triggers.funnel(auth, id, { from: date(q.from), to: date(q.to) });
  }
}

const emptySchema = z.object({}).strict();
const displayedSchema = z.object({ displayedAtClient: z.string().max(40).optional() }).strict();
const acceptSchema = z.object({ clientRequestId: z.string().min(16).max(128).optional() }).strict();

/** Public widget invitation grants (ch. 46/77). Only the invited visitor may act on an invitation. */
@Controller('widget/v1/invitations')
export class InvitationsWidgetController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @UseGuards(VisitorGuard)
  @Post(':id/displayed')
  @HttpCode(200)
  displayed(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(displayedSchema)) _input: z.infer<typeof displayedSchema>) {
    return this.invitations.markDisplayed(v, id);
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Post(':id/accept')
  async accept(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(acceptSchema)) input: z.infer<typeof acceptSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.invitations.accept(v, id, input.clientRequestId ?? null);
    res.status(r.status);
    return r.body;
  }

  @Public()
  @UseGuards(VisitorGuard)
  @Post(':id/dismiss')
  @HttpCode(204)
  async dismiss(@Visitor() v: VisitorContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(emptySchema)) _input: z.infer<typeof emptySchema>) {
    await this.invitations.dismiss(v, id);
  }
}
