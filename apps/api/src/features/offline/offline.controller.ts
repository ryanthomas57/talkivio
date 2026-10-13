import { Body, Controller, Get, Headers, HttpCode, Injectable, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, body, Public, Require, Visitor, zodError, type AuthContext, type VisitorContext } from '../../common/http';
import { validateIdempotencyKey } from '../../common/idempotency';
import { fromWire } from '../../common/wire';
import { CommandRegistry } from '../../realtime/command-registry';
import { VisitorGuard } from '../widget/capability';
import { precondition } from '../schedules/precondition';
import { OfflineService } from './offline.service';

const uuid = z.string().uuid();

/** Public offline form (ch. 23 / 46). Lengths in code points are re-checked by the service. */
export const offlineSubmitSchema = z
  .object({
    clientRequestId: z.string().min(8).max(128).regex(/^[\w-]+$/, 'Use letters, digits, - or _'),
    name: z.string().max(480).nullable().optional(),
    email: z.string().max(254).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    message: z.string().max(32_000),
    departmentId: uuid.nullable().optional(),
    fields: z.record(z.string().max(64), z.unknown()).nullable().optional(),
    sourceChatId: uuid.nullable().optional(),
  })
  .strict();

const listSchema = z
  .object({
    departmentId: uuid.optional(),
    status: z.enum(['received', 'handled', 'exported', 'erased']).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const replySchema = z.object({ body: z.string().max(32_000) }).strict();
const patchSchema = z.object({ status: z.enum(['received', 'handled']), expectedVersion: z.number().int().positive().optional() }).strict();

@Controller('widget/v1/offline-submissions')
export class OfflineWidgetController {
  constructor(private readonly offline: OfflineService) {}

  /** 201 `{id, reference, status:'received', created_at, …}` only after the row commits; identical retries replay it. */
  @Public()
  @UseGuards(VisitorGuard)
  @Post()
  async submit(@Visitor() v: VisitorContext, @Body(body(offlineSubmitSchema)) input: z.infer<typeof offlineSubmitSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.offline.submit(v, input);
    res.status(r.status);
    return r.body;
  }
}

/** Staff API (`offline.view`, department scoped). */
@Controller('offline-submissions')
export class OfflineSubmissionsController {
  constructor(private readonly offline: OfflineService) {}

  @Get()
  @Require('offline.view')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.offline.list(auth, q);
  }

  @Get(':id')
  @Require('offline.view')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.offline.get(auth, id);
  }

  @Post(':id/reply')
  @HttpCode(200)
  @Require('offline.view')
  reply(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(replySchema)) input: z.infer<typeof replySchema>, @Headers('idempotency-key') key: string | undefined) {
    return this.offline.reply(auth, id, input, validateIdempotencyKey(key));
  }

  @Patch(':id')
  @Require('offline.view')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(patchSchema)) input: z.infer<typeof patchSchema>, @Headers('if-match') ifMatch: string | undefined) {
    return this.offline.setStatus(auth, id, input.status, precondition(ifMatch, input.expectedVersion, true));
  }
}

/** Socket parity (ch. 77): `offline.submit` delegates to the same service as REST. */
@Injectable()
export class OfflineSocketCommands implements OnModuleInit {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly offline: OfflineService,
  ) {}

  onModuleInit(): void {
    this.registry.registerVisitor('offline.submit', async (ctx, cmd) => {
      const parsed = offlineSubmitSchema.safeParse(fromWire(cmd.payload));
      if (!parsed.success) throw zodError(parsed.error);
      return (await this.offline.submit(ctx.visitor, parsed.data)).body;
    });
  }
}
