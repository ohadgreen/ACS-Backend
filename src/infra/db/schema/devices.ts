import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const devicePlatform = pgEnum('device_platform', ['ios', 'android']);

/**
 * The map from a user to the addresses a push can actually reach. A table
 * rather than a column on `users`, because the relationship is not one-to-one:
 * one user has several devices, tokens rotate on reinstall, and a handset can
 * change owner.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    token: text('token').notNull(),
    platform: devicePlatform('platform').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    // Partial, so a token freed by an uninstall or an owner change can be
    // registered again. A total unique index would make a reinstall fail.
    // Bare column name: a table-qualified reference is not valid in
    // CREATE INDEX ... WHERE.
    uniqueIndex('device_tokens_active_token').on(t.token).where(sql`revoked_at IS NULL`),
    index('device_tokens_user_idx').on(t.userId).where(sql`revoked_at IS NULL`),
  ],
);

export type DeviceToken = typeof deviceTokens.$inferSelect;
