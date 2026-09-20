import { Module } from '@nestjs/common';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReadinessRepository } from './readiness.repository';
import { SchedulerProcessor } from './scheduler.processor';

/**
 * Worker-only. It owns no domain rules — it decides when things run and
 * delegates what happens to MaintenanceService and ReadinessRepository. Keeping
 * it out of the bookings module is what lets the API import bookings without
 * dragging the scheduler along.
 */
@Module({
  imports: [MaintenanceModule, NotificationsModule],
  providers: [ReadinessRepository, SchedulerProcessor],
  exports: [SchedulerProcessor],
})
export class SchedulingModule {}
