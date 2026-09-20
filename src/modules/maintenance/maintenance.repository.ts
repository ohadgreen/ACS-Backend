import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { bookings, operatorSlots } from '../../infra/db/schema';

@Injectable()
export class MaintenanceRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  /**
   * in_progress bookings are deliberately excluded: a session running past its
   * tick is late, not abandoned, and only END_SESSION should close it. Booked
   * past slots are likewise left alone — their booking owns that decision.
   *
   * Bookings get a grace period of one slot length before they are expired.
   * Without it, putting this on the scheduler's tick would expire every booking
   * at its own start time — in the same tick the customer is notified that
   * their session is beginning, and before the operator could press start.
   * The grace derives from SLOT_DURATION_MIN rather than a second knob, and is
   * the same bound the readiness scan uses, so the two partition the timeline.
   *
   * Open slots get no grace: unsold inventory is stale the instant its tick
   * passes.
   */
  async sweepExpired(now: Date): Promise<{ bookingsExpired: number; slotsExpired: number }> {
    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');

    return this.db.transaction(async (tx) => {
      const abandonedBefore = new Date(now.getTime() - slotMinutes * 60_000);

      const expiredBookings = await tx
        .update(bookings)
        .set({ status: 'expired', cancelledBy: 'system', cancelledAt: now, updatedAt: now })
        .where(
          and(
            lt(bookings.startAt, abandonedBefore),
            inArray(bookings.status, ['confirmed', 'customer_ready']),
          ),
        )
        .returning({ id: bookings.id });

      const expiredSlots = await tx
        .update(operatorSlots)
        .set({ status: 'expired', updatedAt: now })
        .where(and(lt(operatorSlots.startAt, now), eq(operatorSlots.status, 'open')))
        .returning({ id: operatorSlots.id });

      return { bookingsExpired: expiredBookings.length, slotsExpired: expiredSlots.length };
    });
  }
}
