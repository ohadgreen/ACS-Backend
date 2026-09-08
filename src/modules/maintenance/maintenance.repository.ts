import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { bookings, operatorSlots } from '../../infra/db/schema';

@Injectable()
export class MaintenanceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The logic sub-project #3 will schedule. It lives here, fully tested, so
   * that task only has to add a BullMQ trigger.
   *
   * in_progress bookings are deliberately excluded: a session running past its
   * tick is late, not abandoned, and only END_SESSION should close it. Booked
   * past slots are likewise left alone — their booking owns that decision.
   */
  async sweepExpired(now: Date): Promise<{ bookingsExpired: number; slotsExpired: number }> {
    return this.db.transaction(async (tx) => {
      const expiredBookings = await tx
        .update(bookings)
        .set({ status: 'expired', cancelledBy: 'system', cancelledAt: now, updatedAt: now })
        .where(
          and(lt(bookings.startAt, now), inArray(bookings.status, ['confirmed', 'customer_ready'])),
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
