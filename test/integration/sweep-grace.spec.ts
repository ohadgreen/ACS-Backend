import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { MaintenanceRepository } from '../../src/modules/maintenance/maintenance.repository';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';
import { seedBookableBooking } from './booking.fixture';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let repo: MaintenanceRepository;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, DrizzleModule],
    providers: [MaintenanceRepository],
  }).compile();
  repo = moduleRef.get(MaintenanceRepository);
});
afterAll(async () => {
  await moduleRef?.close();
});

/**
 * As in readiness-scan.spec.ts: the session sits on a real 15-minute tick —
 * `operator_slots.grid_aligned` accepts nothing else — and each case moves the
 * sweep's `now`. SLOT_DURATION_MIN is 15, so the grace expires a booking only
 * once `now` has passed `START + 15min`.
 */
const START = new Date('2026-09-16T12:00:00.000Z');
const minutesIn = (n: number) => new Date(START.getTime() + n * 60_000);

const statusOf = async (id: string) => {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
  return row!.status;
};

describe('expiry sweep grace period', () => {
  /**
   * The bug this corrects. The sweep is about to run every 15 seconds; with the
   * old `start_at < now` predicate every booking would be expired at its own
   * start time — in the same minute the customer is told their session is
   * beginning, and before the operator can press start.
   */
  it('does not expire a booking that has only just started', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });
    await repo.sweepExpired(minutesIn(1));
    expect(await statusOf(booking.id)).toBe('confirmed');
  });

  it('does not expire a booking one minute inside the grace window', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });
    await repo.sweepExpired(minutesIn(14));
    expect(await statusOf(booking.id)).toBe('confirmed');
  });

  it('expires a booking whose whole window has elapsed', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });
    const result = await repo.sweepExpired(minutesIn(16));

    expect(await statusOf(booking.id)).toBe('expired');
    expect(result.bookingsExpired).toBe(1);
  });

  it('expires an abandoned customer_ready booking too', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'customer_ready' });
    await repo.sweepExpired(minutesIn(16));
    expect(await statusOf(booking.id)).toBe('expired');
  });

  // A session running past its tick is late, not abandoned; only END_SESSION
  // closes it. Unchanged from phase 2, pinned here because the predicate moved.
  it('never expires an in_progress booking', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'in_progress' });
    await repo.sweepExpired(minutesIn(60));
    expect(await statusOf(booking.id)).toBe('in_progress');
  });

  it('records the system as the canceller', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });
    await repo.sweepExpired(minutesIn(30));
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.cancelledBy).toBe('system');
    expect(row!.cancelledAt).not.toBeNull();
  });
});
