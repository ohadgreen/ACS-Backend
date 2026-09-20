import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from './notifications.module';
import { PushProcessor } from './push.processor';

/**
 * Processors live only here, never in NotificationsModule. That is what makes
 * it structurally impossible for the API process to start consuming jobs — a
 * runtime flag would eventually be set wrong in one environment.
 */
@Module({
  imports: [NotificationsModule, UsersModule],
  providers: [PushProcessor],
  exports: [PushProcessor],
})
export class NotificationsWorkerModule {}
