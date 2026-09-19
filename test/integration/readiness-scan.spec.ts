import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { ReadinessRepository } from '../../src/modules/scheduling/readiness.repository';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from './db.helper';
import { seedBookableBooking } from './booking.fixture';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let repo: ReadinessRepository;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, DrizzleModule],
    providers: [ReadinessRepository],
  }).compile();
  repo = moduleRef.get(ReadinessRepository);
});
afterAll(async () => {
  await moduleRef?.close();
});

/**
 * A session always begins on a 15-minute tick — `operator_slots.grid_aligned`
 * enforces it — so the booking is pinned to the grid and the scan's `now` is
 * what each case moves. SLOT_DURATION_MIN is 15, so the claim window is
 * `(START, START + 15min]` expressed in terms of `now`.
 */
const START = new Date('2026-09-16T12:00:00.000Z');
const minutesIn = (n: number) => new Date(START.getTime() + n * 60_000);

describe('readiness claim scan', () => {
  it('claims a confirmed booking whose start has just passed', async () => {
    const booking = await seedBookableBooking({ startAt: START, status: 'confirmed' });

    const claimed = await repo.claimDueForStartNotification(minutesIn(1));

    expect(claimed).toEqual([{ id: booking.id, customerId: booking.customerId }]);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.startNotifiedAt).not.toBeNull();
  });

  it('does not claim a booking whose start is still in the future', async () => {
    await seedBookableBooking({ startAt: START, status: 'confirmed' });
    expect(await repo.claimDueForStartNotification(minutesIn(-1))).toEqual([]);
  });

  it('claims each booking exactly once', async () => {
    await seedBookableBooking({ startAt: START, status: 'confirmed' });

    expect(await repo.claimDueForStartNotification(minutesIn(1))).toHaveLength(1);
    expect(await repo.claimDueForStartNotification(minutesIn(1))).toEqual([]);
  });

  /**
   * The analogue of booking-concurrency.spec.ts. Under READ COMMITTED the
   * second UPDATE blocks on the row lock, then re-evaluates its predicate
   * against the committed version and finds start_notified_at no longer null.
   * If the claim is ever split into a SELECT then an UPDATE, this fails — and
   * duplicate pushes are a bug users report rather than monitoring.
   */
  it('sends exactly one notification under two concurrent ticks', async () => {
    await seedBookableBooking({ startAt: START, status: 'confirmed' });

    const [a, b] = await Promise.all([
      repo.claimDueForStartNotification(minutesIn(1)),
      repo.claimDueForStartNotification(minutesIn(1)),
    ]);

    expect(a.length + b.length).toBe(1);
  });

  it('ignores a booking that is already customer_ready', async () => {
    await seedBookableBooking({ startAt: START, status: 'customer_ready' });
    expect(await repo.claimDueForStartNotification(minutesIn(1))).toEqual([]);
  });

  it.each(['in_progress', 'completed', 'cancelled', 'no_show', 'expired'] as const)(
    'ignores a %s booking',
    async (status) => {
      await seedBookableBooking({ startAt: START, status });
      expect(await repo.claimDueForStartNotification(minutesIn(1))).toEqual([]);
    },
  );

  /**
   * After a worker outage the scan would otherwise announce "your session
   * starts now" for a session the sweep expires seconds later in the same tick.
   * The lower bound is the same SLOT_DURATION_MIN the sweep uses, so the two
   * scans partition the timeline with no gap and no overlap.
   */
  it('does not claim a booking whose window has fully elapsed', async () => {
    await seedBookableBooking({ startAt: START, status: 'confirmed' });
    expect(await repo.claimDueForStartNotification(minutesIn(16))).toEqual([]);
  });

  it('still claims a booking one minute inside the window', async () => {
    await seedBookableBooking({ startAt: START, status: 'confirmed' });
    expect(await repo.claimDueForStartNotification(minutesIn(14))).toHaveLength(1);
  });
});
