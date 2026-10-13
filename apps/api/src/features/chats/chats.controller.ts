import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, body, Require, TokenAccess, type AuthContext } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { ChatCommandsService } from './chat-commands.service';
import { ChatQueriesService, type InboxView } from './chat-queries.service';
import { RoutingService } from './routing.service';

const uuid = z.string().uuid();
const sendSchema = z.object({
  clientMessageId: z.string().min(1).max(64),
  type: z.enum(['text', 'attachment']).default('text'),
  visibility: z.enum(['public', 'internal']).default('public'),
  body: z.string().max(8000).nullable().optional(),
  attachmentIds: z.array(uuid).max(5).default([]),
  replyId: uuid.nullable().optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
}).strict();
const acceptSchema = z.object({ offerId: uuid.nullable().optional(), expectedVersion: z.number().int().positive().nullable().optional() }).strict();
const declineSchema = z.object({ reason: z.string().max(200).optional() }).strict();
const transferSchema = z
  .object({
    targetAgentId: uuid.nullable().optional(),
    targetDepartmentId: uuid.nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    expectedVersion: z.number().int().positive().nullable().optional(),
    force: z.boolean().optional(),
    reason: z.string().max(300).nullable().optional(),
  })
  .strict();
const closeSchema = z.object({ reason: z.string().min(1).max(100).default('resolved'), expectedVersion: z.number().int().positive().nullable().optional() }).strict();
const readSchema = z.object({ lastReadSeq: z.number().int().min(0) }).strict();
const tagsSchema = z.object({ tagIds: z.array(uuid).max(50) }).strict();
const collaboratorSchema = z.object({ membershipId: uuid }).strict();
const historySchema = z.object({
  q: z.string().max(256).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  siteId: uuid.optional(),
  agentId: uuid.optional(),
  departmentId: uuid.optional(),
  rating: z.enum(['good', 'bad', 'none']).optional(),
  tagId: uuid.optional(),
  status: z.enum(['active', 'closed', 'queued']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const msgPageSchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller('chats')
export class ChatsController {
  constructor(
    private readonly commands: ChatCommandsService,
    private readonly queries: ChatQueriesService,
    private readonly routing: RoutingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Require('chats.serve')
  inbox(@Auth() auth: AuthContext, @Query('view') view: InboxView = 'mine', @Query('department_id') departmentId?: string) {
    const v: InboxView = ['mine', 'queue', 'department', 'all'].includes(view) ? view : 'mine';
    return this.queries.inbox(auth, v, { departmentId });
  }

  @Get('queue')
  @Require('chats.serve')
  queue(@Auth() auth: AuthContext) {
    return this.queries.inbox(auth, 'queue');
  }

  @Get('counts')
  @Require('chats.serve')
  counts(@Auth() auth: AuthContext) {
    return this.queries.counts(auth);
  }

  @Get('offers')
  @Require('chats.serve')
  offers(@Auth() auth: AuthContext) {
    return this.queries.pendingOffers(auth);
  }

  @Get('history')
  @TokenAccess()
  @Require('history.view')
  history(@Auth() auth: AuthContext, @Query(body(historySchema)) q: z.infer<typeof historySchema>) {
    return this.queries.history(auth, q);
  }

  @Get(':id')
  @TokenAccess()
  snapshot(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.queries.snapshot(auth, id);
  }

  @Get(':id/messages')
  @TokenAccess()
  async messages(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(msgPageSchema)) q: z.infer<typeof msgPageSchema>) {
    const r = await this.queries.messages(auth, id, q);
    return { items: r.items, throughSeq: r.throughSeq, lastSeq: r.lastSeq, hasMore: r.hasMore };
  }

  @Post(':id/messages')
  @TokenAccess()
  @Require('chats.serve')
  async send(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(sendSchema)) input: z.infer<typeof sendSchema>, @Res({ passthrough: true }) res: Response) {
    const m = await this.commands.agentSend(auth, id, input);
    res.status(201);
    return m;
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Require('chats.serve')
  accept(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(acceptSchema)) input: z.infer<typeof acceptSchema>) {
    return this.routing.accept(auth, id, input);
  }

  @Put(':id/read-cursor')
  readCursor(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(readSchema)) input: z.infer<typeof readSchema>) {
    return this.commands.readCursor({ auth }, id, input.lastReadSeq);
  }

  @Post(':id/transfers')
  @Require('chats.serve')
  async transfer(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body(transferSchema)) input: z.infer<typeof transferSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId}`, `chats.transfer:${id}`, validateIdempotencyKey(key), input, async () => ({
      status: 201,
      body: await this.commands.transfer(auth, id, input),
    }));
    res.status(r.status);
    return r.body;
  }

  @Post(':id/collaborators')
  @Require('chats.serve')
  addCollaborator(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(collaboratorSchema)) input: z.infer<typeof collaboratorSchema>) {
    return this.commands.addCollaborator(auth, id, input.membershipId);
  }

  @Delete(':id/collaborators/:membershipId')
  @HttpCode(204)
  async removeCollaborator(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) membershipId: string) {
    await this.commands.removeCollaborator(auth, id, membershipId);
  }

  @Post(':id/close')
  @HttpCode(200)
  @TokenAccess()
  async close(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(closeSchema)) input: z.infer<typeof closeSchema>) {
    return (await this.commands.close({ kind: 'agent', auth }, id, input)).chat;
  }

  @Post(':id/request-rating')
  @HttpCode(204)
  async requestRating(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.commands.requestRating(auth, id);
  }

  @Put(':id/tags')
  @TokenAccess()
  setTags(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(tagsSchema)) input: z.infer<typeof tagsSchema>) {
    return this.commands.setTags(auth, id, input.tagIds);
  }
}

@Controller('offers')
export class OffersController {
  constructor(private readonly routing: RoutingService) {}

  @Post(':id/decline')
  @HttpCode(200)
  @Require('chats.serve')
  decline(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(declineSchema)) input: z.infer<typeof declineSchema>) {
    return this.routing.decline(auth, id, input.reason);
  }
}
