import { Controller, HttpCode, Post } from '@nestjs/common';
import { Auth, type AuthContext, denied } from '../common/http';
import { TicketsService } from './tickets.service';
import { REALTIME_PATH } from './gateway';

/** Agent socket tickets: single-use, 30 s, minted only for an authenticated session (ch. 46/47). */
@Controller()
export class RealtimeController {
  constructor(private readonly tickets: TicketsService) {}

  @Post('socket-ticket')
  @HttpCode(201)
  async ticket(@Auth() auth: AuthContext) {
    if (!auth.sessionId || !auth.userId || !auth.membershipId) throw denied('Socket tickets require a signed-in agent');
    const t = await this.tickets.mint({ kind: 'agent', tenantId: auth.tenantId, userId: auth.userId, sessionId: auth.sessionId, membershipId: auth.membershipId });
    return { ticket: t.ticket, expiresAt: t.expiresAt, path: REALTIME_PATH, namespace: '/agent' };
  }
}
