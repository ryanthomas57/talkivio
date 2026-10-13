import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import { AppError } from '../common/http';

/** Fixed-window rate limiter backed by Redis (shared across API nodes). */
@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /** Returns true if the action is allowed. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const res = await this.redis.client.multi().incr(bucket).expire(bucket, windowSeconds + 1).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    return count <= limit;
  }

  async enforce(key: string, limit: number, windowSeconds: number, message = 'Too many attempts. Please wait a moment and try again.'): Promise<void> {
    if (await this.hit(key, limit, windowSeconds)) return;
    // Retry may help once the fixed window rolls over; tell the client when.
    const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    throw new AppError(429, 'RATE_LIMITED', message, { retryable: true, retryAfter });
  }
}
