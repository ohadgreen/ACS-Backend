import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { locationSessionTypes, locations } from './locations';
import { operatorSlots } from './slots';
import { operators } from './operators';
import { users } from './users';

export const bookingStatus = pgEnum('booking_status', [
  'confirmed',
  'customer_ready',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'expired',
]);
export const actorKind = pgEnum('actor_kind', ['customer', 'operator', 'admin', 'system']);

/** The statuses that hold a slot. Both partial indexes below key off this set. */
const ACTIVE_STATUSES = sql`('confirmed','customer_ready','in_progress')`;

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey(),
    operatorSlotId: uuid('operator_slot_id')
      .notNull()
      .references(() => operatorSlots.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operators.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    locationSessionTypeId: uuid('location_session_type_id')
      .notNull()
      .references(() => locationSessionTypes.id),
    priceSnapshot: numeric('price_snapshot', { precision: 10, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    status: bookingStatus('status').notNull().default('confirmed'),
    lateCancellation: boolean('late_cancellation').notNull().default(false),
    cancelledBy: actorKind('cancelled_by'),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    readyAckAt: timestamp('ready_ack_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    sessionEndAt: timestamp('session_end_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('bookings_customer_idx').on(t.customerId, t.startAt.desc()),
    index('bookings_operator_idx').on(t.operatorId, t.startAt),
    // Belt to the SKIP LOCKED braces: even if the optimistic selection were
    // ever wrong, the database refuses a second LIVE booking for one slot.
    // Partial rather than a plain unique column, because an early cancellation
    // deliberately returns the slot to 'open' for resale — a total unique
    // constraint would make that release unsellable.
    uniqueIndex('booking_one_active_per_slot')
      .on(t.operatorSlotId)
      .where(sql`status IN ${ACTIVE_STATUSES}`),
    uniqueIndex('customer_one_booking_per_tick')
      .on(t.customerId, t.startAt)
      .where(sql`status IN ${ACTIVE_STATUSES}`),
  ],
);

export type Booking = typeof bookings.$inferSelect;
