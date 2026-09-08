import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { geographyPoint } from '../types';
import type { LocalizedText } from '../../../common/localized/localized-text';

/**
 * A curated filming spot. `code` and `site_code` are stable slugs and own
 * identity and grouping; the localized `name`/`site_name` are display only, so
 * renaming a location in Hebrew can never repoint a booking.
 */
export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull().unique(),
    siteCode: text('site_code').notNull(),
    siteName: jsonb('site_name').$type<LocalizedText>().notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    description: jsonb('description').$type<LocalizedText>(),
    geog: geographyPoint('geog').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('locations_site_idx').on(t.siteCode),
    // jsonb_exists(), never the `?` operator — node-postgres reads `?` as a
    // parameter placeholder and the operator form fails at runtime.
    check(
      'locations_site_name_locales',
      sql`jsonb_exists(${t.siteName}, 'en') AND jsonb_exists(${t.siteName}, 'he')`,
    ),
    check(
      'locations_name_locales',
      sql`jsonb_exists(${t.name}, 'en') AND jsonb_exists(${t.name}, 'he')`,
    ),
  ],
);

export const locationSessionTypes = pgTable(
  'location_session_types',
  {
    id: uuid('id').primaryKey(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    code: text('code').notNull(),
    name: jsonb('name').$type<LocalizedText>().notNull(),
    description: jsonb('description').$type<LocalizedText>(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('ILS'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('location_session_types_location_code').on(t.locationId, t.code),
    check('location_session_types_price_nonneg', sql`${t.price} >= 0`),
    check(
      'location_session_types_name_locales',
      sql`jsonb_exists(${t.name}, 'en') AND jsonb_exists(${t.name}, 'he')`,
    ),
  ],
);

export type Location = typeof locations.$inferSelect;
export type LocationSessionType = typeof locationSessionTypes.$inferSelect;
