import { Module } from '@nestjs/common';
import { AppConfigModule } from './infra/config/config.module';
import { DrizzleModule } from './infra/db/drizzle.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [AppConfigModule, DrizzleModule, RedisModule, HealthModule],
})
export class AppModule {}
