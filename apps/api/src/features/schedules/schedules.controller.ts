import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { isValidTimezone } from '@talkivio/contracts';
import { Auth, body, Require, type AuthContext } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { precondition } from './precondition';
import { SchedulesService } from './schedules.service';

const uuid = z.string().uuid();
const timeRange = z.object({ start: z.string().max(5), end: z.string().max(5) }).strict();
// Weekday keys are checked by validateWeeklyIntervals (field errors per day/interval).
const weekly = z.record(z.string().max(16), z.array(timeRange).max(24)).refine((v) => Object.keys(v).length <= 7, 'At most seven weekdays');
const name = z.string().trim().min(1).max(120);
const timezone = z.string().trim().max(64).refine(isValidTimezone, 'Use an IANA timezone name such as Europe/London');
const version = z.number().int().positive();

const listSchema = z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), includeArchived: z.enum(['true', 'false']).optional() }).strict();
const createSchema = z.object({ name, timezone, weeklyIntervals: weekly }).strict();
const patchSchema = z
  .object({ name: name.optional(), timezone: timezone.optional(), weeklyIntervals: weekly.optional(), expectedVersion: version.optional(), dryRun: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.timezone !== undefined || v.weeklyIntervals !== undefined, 'Nothing to change');
const archiveSchema = z.object({ expectedVersion: version.optional() }).strict();
const exceptionSchema = z.object({ intervals: z.array(timeRange).max(24), reason: z.string().trim().max(200).nullable().optional(), expectedVersion: version.optional(), dryRun: z.boolean().optional() }).strict();
const previewSchema = z.object({ from: z.string().datetime({ offset: true }).optional(), days: z.coerce.number().int().min(1).max(31).default(7) }).strict();
const closureListSchema = z.object({ state: z.enum(['active', 'all']).default('active'), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const closureSchema = z
  .object({ siteId: uuid.nullable().optional(), departmentId: uuid.nullable().optional(), endsAt: z.string().datetime({ offset: true }).nullable().optional(), reason: z.string().trim().min(1).max(300) })
  .strict();

/** Schedules (ch. 42): agent API, `schedules.view` / `schedules.manage`. */
@Controller('schedules')
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Require('schedules.view')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.schedules.list(auth, { cursor: q.cursor, limit: q.limit, includeArchived: q.includeArchived === 'true' });
  }

  @Post()
  @Require('schedules.manage')
  async create(
    @Auth() auth: AuthContext,
    @Body(body(createSchema)) input: z.infer<typeof createSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId ?? auth.tokenId}`, 'schedules.create', validateIdempotencyKey(key), input, async () => ({
      status: 201,
      body: await this.schedules.create(auth, input),
    }));
    res.status(r.status);
    return r.body;
  }

  @Get(':id')
  @Require('schedules.view')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.get(auth, id);
  }

  @Patch(':id')
  @Require('schedules.manage')
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body(patchSchema)) input: z.infer<typeof patchSchema>,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    const expected = precondition(ifMatch, input.expectedVersion, true);
    return this.schedules.update(auth, id, input, expected);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('schedules.manage')
  archive(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body(body(archiveSchema)) input: z.infer<typeof archiveSchema>, @Headers('if-match') ifMatch: string | undefined) {
    return this.schedules.archive(auth, id, precondition(ifMatch, input.expectedVersion, false));
  }

  @Put(':id/exceptions/:date')
  @Require('schedules.manage')
  setException(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('date') date: string,
    @Body(body(exceptionSchema)) input: z.infer<typeof exceptionSchema>,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.schedules.setException(auth, id, date, input, precondition(ifMatch, input.expectedVersion, false));
  }

  @Delete(':id/exceptions/:date')
  @HttpCode(204)
  @Require('schedules.manage')
  async removeException(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('date') date: string, @Headers('if-match') ifMatch: string | undefined) {
    await this.schedules.removeException(auth, id, date, precondition(ifMatch, null, false));
  }

  @Get(':id/preview')
  @Require('schedules.view')
  preview(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query(body(previewSchema)) q: z.infer<typeof previewSchema>) {
    return this.schedules.preview(auth, id, q);
  }
}

/** Emergency closures (ch. 22/42): override every schedule until revoked or expired. */
@Controller('emergency-closures')
export class EmergencyClosuresController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Require('schedules.view')
  list(@Auth() auth: AuthContext, @Query(body(closureListSchema)) q: z.infer<typeof closureListSchema>) {
    return this.schedules.listClosures(auth, q);
  }

  @Post()
  @Require('schedules.manage')
  async create(
    @Auth() auth: AuthContext,
    @Body(body(closureSchema)) input: z.infer<typeof closureSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId ?? auth.tokenId}`, 'emergency_closures.create', validateIdempotencyKey(key), input, async () => ({
      status: 201,
      body: await this.schedules.createClosure(auth, input),
    }));
    res.status(r.status);
    return r.body;
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('schedules.manage')
  async revoke(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.schedules.revokeClosure(auth, id);
  }
}
