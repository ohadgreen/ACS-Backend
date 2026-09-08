import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { REDIS } from '../../infra/redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: answers as long as the process is up. Touches nothing. */
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: only true once both backing services actually answer. */
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
