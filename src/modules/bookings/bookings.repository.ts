import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import {
  bookings,
  locationSessionTypes,
  operatorCheckins,
  operatorSlots,
  operators,
  type Booking,
} from '../../infra/db/schema';
import type { ActorKind, BookingStatus, StampField } from './domain/types';

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

  listForCustomer(customerId: string): Promise<Booking[]> {
    return this.db
      .select()
      .from(bookings)
      .where(eq(bookings.customerId, customerId))
      .orderBy(desc(bookings.startAt));
  }

  listForOperator(operatorId: string): Promise<Booking[]> {
    return this.db
      .select()
      .from(bookings)
      .where(eq(bookings.operatorId, operatorId))
      .orderBy(desc(bookings.startAt));
  }

  /**
   * Persists a decision the pure state machine already made. The service never
   * decides here; this method only writes.
   *
   * operators.presence is maintained in the SAME transaction as the status
   * change, so presence can never disagree with the booking it describes.
   * START is the only thing that ever sets 'in_session'.
   */
  async applyTransition(
    bookingId: string,
    result: {
      next: BookingStatus;
      stampField: StampField;
      lateCancellation: boolean;
      releaseSlot: boolean;
    },
    actor: ActorKind,
    reason: string | null,
  ): Promise<Booking> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const patch: Record<string, unknown> = {
        status: result.next,
        updatedAt: now,
        [result.stampField]: now,
      };

      if (result.next === 'completed') patch.completedAt = now;
      if (result.next === 'cancelled') {
        patch.cancelledBy = actor;
        patch.cancellationReason = reason;
        patch.lateCancellation = result.lateCancellation;
      }

      const [updated] = await tx
        .update(bookings)
        .set(patch as never)
        .where(eq(bookings.id, bookingId))
        .returning();

      const booking = updated!;

      // Cancellation returns inventory to sale only while there is still
      // meaningful notice; otherwise the slot stays withdrawn.
      if (result.releaseSlot) {
        await tx
          .update(operatorSlots)
          .set({ status: 'open', updatedAt: now })
          .where(eq(operatorSlots.id, booking.operatorSlotId));
      } else if (result.next === 'cancelled') {
        await tx
          .update(operatorSlots)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(operatorSlots.id, booking.operatorSlotId));
      }

      if (result.next === 'in_progress') {
        await tx
          .update(operators)
          .set({ presence: 'in_session', updatedAt: now })
          .where(eq(operators.id, booking.operatorId));
      } else if (result.next === 'completed') {
        // Back to online, unless the operator's check-in has since ended.
        const [active] = await tx
          .select({ id: operatorCheckins.id })
          .from(operatorCheckins)
          .where(
            and(
              eq(operatorCheckins.operatorId, booking.operatorId),
              eq(operatorCheckins.status, 'active'),
            ),
          )
          .limit(1);

        await tx
          .update(operators)
          .set({ presence: active ? 'online' : 'offline', updatedAt: now })
          .where(eq(operators.id, booking.operatorId));
      }

      return booking;
    });
  }
}
