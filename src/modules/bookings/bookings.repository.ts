import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import {
  bookings,
  locationSessionTypes,
  operatorSlots,
  type Booking,
} from '../../infra/db/schema';

export interface CreateBookingInput {
  locationId: string;
  startAt: Date;
  sessionTypeId: string;
  customerId: string;
  dayStart: Date;
  dayEnd: Date;
}

@Injectable()
export class BookingsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Selects a free slot AND assigns the fairest operator in one statement.
   *
   * FOR UPDATE SKIP LOCKED is what makes this safe under load: a concurrent
   * transaction holding the best row is skipped rather than blocking, so the
   * next-best operator is picked instead of the request serializing or failing.
   * Capacity is enforced by row existence — zero rows means "no longer
   * available" — never by counting.
   *
   * `OF s` is mandatory, not decoration: FOR UPDATE cannot be applied to the
   * nullable side of an outer join, so without it Postgres rejects the
   * statement outright because of the LEFT JOIN LATERAL.
   *
   * The load subquery counts every booking assigned for today, including
   * upcoming ones. Counting only completed sessions would route every advance
   * booking to the same operator, since all operators sit at zero.
   *
   * Returns null when no slot is free. Throws on the customer-double-book
   * unique index, which the caller maps to 409.
   */
  async createBooking(input: CreateBookingInput): Promise<Booking | null> {
    return this.db.transaction(async (tx) => {
      const picked = await tx.execute<{ id: string; operator_id: string }>(sql`
        SELECT s.id, s.operator_id
        FROM operator_slots s
        LEFT JOIN LATERAL (
          SELECT count(*) AS n
          FROM bookings b
          WHERE b.operator_id = s.operator_id
            AND b.start_at >= ${input.dayStart}
            AND b.start_at <  ${input.dayEnd}
            AND b.status <> 'cancelled'
        ) load ON true
        WHERE s.location_id = ${input.locationId}
          AND s.start_at    = ${input.startAt}
          AND s.status      = 'open'
        ORDER BY load.n ASC, random()
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      `);

      const slot = picked.rows[0];
      if (!slot) return null;

      await tx
        .update(operatorSlots)
        .set({ status: 'booked', updatedAt: new Date() })
        .where(eq(operatorSlots.id, slot.id));

      const [sessionType] = await tx
        .select({ price: locationSessionTypes.price, currency: locationSessionTypes.currency })
        .from(locationSessionTypes)
        .where(eq(locationSessionTypes.id, input.sessionTypeId));

      const [booking] = await tx
        .insert(bookings)
        .values({
          id: uuidv7(),
          operatorSlotId: slot.id,
          customerId: input.customerId,
          operatorId: slot.operator_id,
          locationId: input.locationId,
          locationSessionTypeId: input.sessionTypeId,
          // Snapshotted, so an admin editing the price later cannot change
          // what an already-booked customer owes.
          priceSnapshot: sessionType!.price,
          currency: sessionType!.currency,
          startAt: input.startAt,
        })
        .returning();

      return booking!;
    });
  }

  async findById(id: string): Promise<Booking | undefined> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row;
  }
}
