import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import { randomToken, sha256 } from '../common/crypto';

export interface AgentTicketClaims {
  kind: 'agent';
  tenantId: string;
  userId: string;
  sessionId: string;
  membershipId: string;
}

export interface VisitorTicketClaims {
  kind: 'visitor';
  tenantId: string;
  siteId: string;
  visitorId: string;
  sessionId: string;
  origin: string | null;
  /** Capability expiry the ticket was minted under (auth.ok capability_expiry). */
  capabilityExpiry?: string | null;
}

export type TicketClaims = AgentTicketClaims | VisitorTicketClaims;

const TTL_SECONDS = 30;

/** Single-use, 30 s socket tickets (ch. 47). Stored hashed; consumed atomically. */
@Injectable()
export class TicketsService {
  constructor(private readonly redis: RedisService) {}

  async mint(claims: TicketClaims): Promise<{ ticket: string; expiresAt: Date }> {
    const ticket = `rdtk_${randomToken(24)}`;
    await this.redis.client.set(`rt:ticket:${sha256(ticket)}`, JSON.stringify(claims), 'EX', TTL_SECONDS);
    return { ticket, expiresAt: new Date(Date.now() + TTL_SECONDS * 1000) };
  }

  async consume(ticket: string | undefined | null): Promise<TicketClaims | null> {
    if (!ticket || typeof ticket !== 'string' || ticket.length > 200) return null;
    const raw = await this.redis.client.getdel(`rt:ticket:${sha256(ticket)}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TicketClaims;
    } catch {
      return null;
    }
  }
}
