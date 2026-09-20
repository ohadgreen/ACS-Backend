import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import {
  QUEUE_CONNECTION,
  SCHEDULER_QUEUE,
  TICK_JOB,
  TICK_SCHEDULER_ID,
} from '../../infra/queue/queue.constants';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReadinessRepository } from './readiness.repository';

export interface TickResult {
  notified: number;
  bookingsExpired: number;
  slotsExpired: number;
}

@Injectable()
export class SchedulerProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerProcessor.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: IORedis,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly readiness: ReadinessRepository,
    private readonly notifications: NotificationsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  async onModuleInit(): Promise<void> {
    const prefix = requireEnv(this.config, 'QUEUE_PREFIX');
    const everyMs = requireEnv(this.config, 'SCHEDULER_TICK_SEC') * 1_000;

    this.queue = new Queue(SCHEDULER_QUEUE, { connection: this.connection, prefix });

    // upsertJobScheduler, not add({ repeat }): keyed by a stable id, it
    // replaces its own schedule when the interval changes. The older API
    // derives a repeatable job's identity from its options, so changing
    // SCHEDULER_TICK_SEC would leave the previous schedule registered
    // alongside the new one and the tick would silently run twice.
    await this.queue.upsertJobScheduler(
      TICK_SCHEDULER_ID,
      { every: everyMs },
      { name: TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );

    // Concurrency 1: the scans are cheap and set-based, and overlapping ticks
    // would buy nothing but lock contention.
    this.worker = new Worker(SCHEDULER_QUEUE, () => this.tick(), {
      connection: this.connection,
      prefix,
      concurrency: 1,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /**
   * Public so tests drive it directly — waiting on a real 15-second schedule
   * would make the suite slow and its failures hard to read.
   *
   * The two scans are independent; the order is for log readability. Notifying
   * first is nonetheless the safer order: the readiness claim is bounded to the
   * live window, so a booking past its grace is never announced and then
   * expired in the same pass.
   */
  async tick(now = new Date()): Promise<TickResult> {
    const due = await this.readiness.claimDueForStartNotification(now);
    for (const booking of due) {
      await this.notifications.notify(booking.customerId, 'SESSION_STARTING', {
        bookingId: booking.id,
      });
    }

    const swept = await this.maintenance.sweepExpired(now);

    if (due.length > 0 || swept.bookingsExpired > 0 || swept.slotsExpired > 0) {
      this.logger.log(
        `tick: notified=${due.length} bookingsExpired=${swept.bookingsExpired} slotsExpired=${swept.slotsExpired}`,
      );
    }

    return { notified: due.length, ...swept };
  }
}
