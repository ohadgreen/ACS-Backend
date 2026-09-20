import { Module } from '@nestjs/common';
import { AppLoggerModule } from './common/logging/logger.module';
import { AppConfigModule } from './infra/config/config.module';
import { DrizzleModule } from './infra/db/drizzle.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NotificationsWorkerModule } from './modules/notifications/notifications.worker.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { UsersModule } from './modules/users/users.module';

/**
 * The consumer half of the system. It shares infra/ and the domain services
 * with AppModule, so a job handler calls exactly the code an HTTP handler
 * would — but processors are declared only here, which is what makes it
 * structurally impossible for the API process to consume jobs.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DrizzleModule,
    RedisModule,
    QueueModule,
    UsersModule,
    MaintenanceModule,
    NotificationsModule,
    NotificationsWorkerModule,
    SchedulingModule,
  ],
})
export class WorkerModule {}
