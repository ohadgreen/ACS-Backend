import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { TooManyRequestsError } from '../errors/domain-error';
import { ErrorCodes } from '../errors/error-codes';

@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Fixed window. EXPIRE runs only on the first hit, so the window starts at
   * the first request rather than sliding forward on every call — otherwise a
   * steady trickle keeps the counter alive indefinitely and the window never
   * closes.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    const redisKey = `rl:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowSeconds);
    }
    if (count > limit) {
      const ttl = await this.redis.ttl(redisKey);
      throw new TooManyRequestsError(ErrorCodes.RATE_LIMITED, 'Too many attempts.', {
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      });
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}
