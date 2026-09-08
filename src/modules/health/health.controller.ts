import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { Public } from '../../common/auth/public.decorator';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { REDIS } from '../../infra/redis/redis.module';

/**
 * Both routes are @Public: a load balancer or orchestrator probe carries no
 * bearer token, and a 401 here reads as an unhealthy service.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: answers as long as the process is up. Touches nothing. */
  @Public()
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: only true once both backing services actually answer. */
  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.db.execute(sql`SELECT 1`);
      await this.redis.ping();
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ready', db: 'up', redis: 'up' };
  }
}
