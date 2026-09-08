import { Module } from '@nestjs/common';
import { CryptoModule } from './common/crypto/crypto.module';
import { AppLoggerModule } from './common/logging/logger.module';
import { AppConfigModule } from './infra/config/config.module';
import { DrizzleModule } from './infra/db/drizzle.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [AppConfigModule, AppLoggerModule, CryptoModule, DrizzleModule, RedisModule, HealthModule],
})
export class AppModule {}
