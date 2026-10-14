import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis.service';
import { capabilityRevocationKey, VisitorGuard, visitorIpHash, visitorIpHashes } from '../widget/capability';

export { visitorIpHash, visitorIpHashes };

/** Capabilities live at most one hour (features/widget/capability.ts); keep revocations a little longer. */
const REVOCATION_TTL_SECONDS = 3_700;
const key = capabilityRevocationKey;

/**
 * Revocation list for stateless visitor capabilities. Identity reset (host
 * logout) revokes every open session of the visitor on the site so a
 * previously issued capability can no longer read the prior transcript.
 */
@Injectable()
export class VisitorCapabilityRevocations {
  constructor(private readonly redis: RedisService) {}

  async revokeSessions(sessionIds: string[]): Promise<void> {
    if (!sessionIds.length) return;
    const m = this.redis.client.multi();
    for (const id of sessionIds) m.set(key(id), '1', 'EX', REVOCATION_TTL_SECONDS);
    await m.exec();
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.client.exists(key(sessionId))) === 1;
  }
}

/** Kept for existing decorators: the base VisitorGuard now enforces revocation and the canonical IP hash. */
@Injectable()
export class ActiveVisitorGuard extends VisitorGuard {}
