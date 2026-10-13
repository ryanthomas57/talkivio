import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, badRequest, body, Require, type AuthContext } from '../../common/http';
import { BansService } from './bans.service';

const createSchema = z
  .object({
    visitorId: z.string().uuid().nullable().optional(),
    ip: z.string().trim().min(2).max(64).nullable().optional(),
    /** Spec alias (ch. 43 `ip_or_cidr`); only exact addresses are accepted. */
    ipOrCidr: z.string().trim().min(2).max(64).nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
    expiresAt: z.string().max(40).nullable().optional(),
    reason: z.string().trim().min(1).max(500),
    closeActiveChat: z.boolean().optional(),
  })
  .strict();

const listSchema = z
  .object({
    active: z.enum(['true', 'false']).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Ban management (ch. 24/43). */
@Controller('bans')
export class BansController {
  constructor(private readonly bans: BansService) {}

  @Post()
  @Require('bans.manage')
  create(@Auth() auth: AuthContext, @Body(body(createSchema)) input: z.infer<typeof createSchema>) {
    const { ipOrCidr, ...rest } = input;
    if (rest.ip && ipOrCidr) throw badRequest('Send either ip or ip_or_cidr, not both', { ip: ['Duplicate target'] });
    return this.bans.create(auth, { ...rest, ip: rest.ip ?? ipOrCidr ?? null });
  }

  @Get()
  @Require('bans.manage')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.bans.list(auth, { active: q.active === undefined ? undefined : q.active === 'true', cursor: q.cursor, limit: q.limit });
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('bans.manage')
  async revoke(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.bans.revoke(auth, id);
  }
}
