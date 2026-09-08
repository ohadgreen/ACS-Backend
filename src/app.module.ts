import { Module } from '@nestjs/common';
import { CryptoModule } from './common/crypto/crypto.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { AppLoggerModule } from './common/logging/logger.module';
import { AppConfigModule } from './infra/config/config.module';
import { DrizzleModule } from './infra/db/drizzle.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { LocationsModule } from './modules/locations/locations.module';
import { OperatorsModule } from './modules/operators/operators.module';
import { PresenceModule } from './modules/presence/presence.module';
import { SmsModule } from './modules/sms/sms.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    CryptoModule,
    RateLimitModule,
    DrizzleModule,
    RedisModule,
    UsersModule,
    SmsModule,
    AuthModule,
    OperatorsModule,
    LocationsModule,
    PresenceModule,
    DiscoveryModule,
    HealthModule,
  ],
})
export class AppModule {}
