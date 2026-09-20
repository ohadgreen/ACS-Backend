import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { QueueModule } from '../../src/infra/queue/queue.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { MaintenanceModule } from '../../src/modules/maintenance/maintenance.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { NotificationsWorkerModule } from '../../src/modules/notifications/notifications.worker.module';
import { SchedulingModule } from '../../src/modules/scheduling/scheduling.module';
import { SchedulerProcessor } from '../../src/modules/scheduling/scheduler.processor';
import { PushProcessor } from '../../src/modules/notifications/push.processor';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { PUSH_PROVIDER } from '../../src/modules/notifications/push-provider';
import type { FakePushProvider } from '../../src/modules/notifications/fake-push.provider';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';
import { seedBookableBooking } from './booking.fixture';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let scheduler: SchedulerProcessor;
let pushProcessor: PushProcessor;
let devices: DevicesRepository;
let push: FakePushProvider;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      DrizzleModule,
      QueueModule,
      UsersModule,
      MaintenanceModule,
      NotificationsModule,
      NotificationsWorkerModule,
      SchedulingModule,
    ],
  }).compile();
  await moduleRef.init();

  scheduler = moduleRef.get(SchedulerProcessor);
  pushProcessor = moduleRef.get(PushProcessor);
  devices = moduleRef.get(DevicesRepository);
  push = moduleRef.get<FakePushProvider>(PUSH_PROVIDER);
});
afterAll(async () => {
  await moduleRef?.close();
});

beforeEach(() => {
  push.reset();
});

/**
 * As in readiness-scan.spec.ts: the session sits on a real 15-minute tick and
 * each case moves the scheduler's `now`. With SLOT_DURATION_MIN at 15, a
 * booking is notifiable in `(START, START + 15min]` and expirable after that.
 */
const START = new Date('2026-09-16T12:00:00.000Z');
const minutesIn = (n: number) => new Date(START.getTime() + n * 60_000);

describe('scheduler tick', () => {
  it('notifies a booking whose start has arrived', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });
    await devices.register(booking.customerId, 'tok-tick', 'ios');

    const result = await scheduler.tick(minutesIn(1));

    expect(result.notified).toBe(1);
    // Drain the enqueued job through the real processor so the whole path runs.
    await pushProcessor.handle({
      userId: booking.customerId,
      key: 'SESSION_STARTING',
      data: { bookingId: booking.id },
    });
    expect(push.sent[0]!.token).toBe('tok-tick');
  });

  it('notifies each booking only once across repeated ticks', async () => {
    await seedBookableBooking({ startAt: START, status: 'confirmed' });

    expect((await scheduler.tick(minutesIn(1))).notified).toBe(1);
    expect((await scheduler.tick(minutesIn(1))).notified).toBe(0);
  });

  it('expires an abandoned booking in the same tick', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });

    const result = await scheduler.tick(minutesIn(30));

    expect(result.bookingsExpired).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('expired');
  });

  /**
   * The two scans must not fight. A booking past its grace is expired silently
   * rather than being told its session is starting a moment before it dies.
   */
  it('never both notifies and expires the same booking', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });

    const result = await scheduler.tick(minutesIn(30));

    expect(result.notified).toBe(0);
    expect(result.bookingsExpired).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.startNotifiedAt).toBeNull();
  });

  it('is a no-op when nothing is due', async () => {
    const result = await scheduler.tick(minutesIn(1));
    expect(result).toMatchObject({ notified: 0, bookingsExpired: 0 });
  });
});
