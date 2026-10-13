import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, body, Require, type AuthContext } from '../../common/http';
import { requireVersion } from './visitor-common';
import { VisitorMonitorService, LIVE_GROUPS, type LiveGroup } from './visitor-monitor.service';
import { VisitorRecordsService } from './visitor-records.service';

const liveSchema = z
  .object({
    siteId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    status: z
      .string()
      .max(60)
      .optional()
      .transform((s, ctx) => {
        if (!s) return undefined;
        const parts = [...new Set(s.split(',').map((p) => p.trim()).filter(Boolean))];
        for (const p of parts) if (!LIVE_GROUPS.includes(p as LiveGroup)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown status ${p}` });
        return parts as LiveGroup[];
      }),
    tag: z.string().trim().min(1).max(64).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    mode: z.enum(['normal', 'high_load']).optional(),
  })
  .strict();

const listSchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    identified: z.enum(['true', 'false']).optional(),
    tag: z.string().trim().min(1).max(64).optional(),
    siteId: z.string().uuid().optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const pageSchema = z.object({ cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict();

const patchSchema = z
  .object({
    displayName: z.string().trim().max(100).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    customFields: z.record(z.unknown()).optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

const tagsSchema = z.object({ tagIds: z.array(z.string().uuid()).max(50) }).strict();

const mergeSchema = z
  .object({
    sourceId: z.string().uuid(),
    targetId: z.string().uuid(),
    proofReference: z.string().trim().min(3).max(200),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** Visitor monitoring and records (ch. 11/17/43). */
@Controller('visitors')
export class VisitorsController {
  constructor(
    private readonly monitor: VisitorMonitorService,
    private readonly records: VisitorRecordsService,
  ) {}

  @Get('live')
  @Require('visitors.view')
  live(@Auth() auth: AuthContext, @Query(body(liveSchema)) q: z.infer<typeof liveSchema>) {
    return this.monitor.snapshot(auth, q);
  }

  @Post('merge-requests')
  @HttpCode(202)
  @Require('visitors.edit', 'privacy.manage')
  merge(@Auth() auth: AuthContext, @Body(body(mergeSchema)) input: z.infer<typeof mergeSchema>) {
    return this.records.mergeRequest(auth, input);
  }

  @Get()
  @Require('visitors.view')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.records.list(auth, { ...q, identified: q.identified === undefined ? undefined : q.identified === 'true' });
  }

  @Get(':id')
  @Require('visitors.view')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.records.get(auth, id);
  }

  @Patch(':id')
  @Require('visitors.view', 'visitors.edit')
  update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('if-match') ifMatch: string | undefined, @Body(body(patchSchema)) input: z.infer<typeof patchSchema>) {
    const { expectedVersion, ...patch } = input;
    return this.records.update(auth, id, requireVersion(ifMatch, expectedVersion), patch);
  }

  @Get(':id/sessions')
  @Require('visitors.view')
  sessions(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(pageSchema)) q: z.infer<typeof pageSchema>) {
    return this.records.sessions(auth, id, q);
  }

  @Get(':id/chats')
  @Require('visitors.view', 'history.view')
  chats(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(pageSchema)) q: z.infer<typeof pageSchema>) {
    return this.records.chats(auth, id, q);
  }

  @Put(':id/tags')
  @Require('visitors.view', 'visitors.edit')
  tags(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(tagsSchema)) input: z.infer<typeof tagsSchema>) {
    return this.records.setTags(auth, id, input.tagIds);
  }
}
