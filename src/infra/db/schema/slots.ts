import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { geographyPoint } from '../types';
import { locations } from './locations';
import { operators } from './operators';

export const checkinStatus = pgEnum('checkin_status', ['active', 'ended']);
export const slotStatus = pgEnum('slot_status', ['open', 'booked', 'cancelled', 'expired']);

/**
 * One declaration of availability: an operator, a location, and a window. The
 * reported position is kept for audit — it is the evidence that the operator
 * was physically there when they claimed to be.
 */
export const operatorCheckins = pgTable(
  'operator_checkins',
  {
    id: uuid('id').primaryKey(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operators.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    availableFrom: timestamp('available_from', { withTimezone: true }).notNull(),
    availableUntil: timestamp('available_until', { withTimezone: true }).notNull(),
    checkedInGeog: geographyPoint('checked_in_geog').notNull(),
    status: checkinStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('operator_checkins_operator_idx').on(t.operatorId, t.status),
    index('operator_checkins_location_idx').on(t.locationId, t.availableFrom),
    check('operator_checkins_window', sql`${t.availableUntil} > ${t.availableFrom}`),
  ],
);

/**
 * Inventory, materialized. Capacity at a tick is the COUNT of open rows here —
 * never a number in a column — which is what lets one `FOR UPDATE SKIP LOCKED`
 * statement both select a slot and assign its operator.
 */
export const operatorSlots = pgTable(
  'operator_slots',
  {
    id: uuid('id').primaryKey(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operators.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    checkinId: uuid('checkin_id')
      .notNull()
      .references(() => operatorCheckins.id),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    status: slotStatus('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: a cancelled tick must be regenerable, or checking out would
    // permanently poison those times for that operator.
    uniqueIndex('one_session_per_operator_per_tick')
      .on(t.operatorId, t.startAt)
      .where(sql`status <> 'cancelled'`),
    index('operator_slots_lookup_idx').on(t.locationId, t.startAt, t.status),
    // AT TIME ZONE 'UTC' keeps the expression immutable, so it is legal in a
    // CHECK and correct regardless of the session's timezone setting.
    check(
      'grid_aligned',
      sql`EXTRACT(minute FROM ${t.startAt} AT TIME ZONE 'UTC') IN (0,15,30,45)
          AND EXTRACT(second FROM ${t.startAt} AT TIME ZONE 'UTC') = 0`,
    ),
  ],
);

export type OperatorCheckin = typeof operatorCheckins.$inferSelect;
export type OperatorSlot = typeof operatorSlots.$inferSelect;
