import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { userRole, userStatus } from './enums';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    role: userRole('role').notNull(),
    phone: text('phone').unique(),
    email: text('email').unique(),
    passwordHash: text('password_hash'),
    // Nullable: an OTP signup supplies no name; the client prompts later.
    displayName: text('display_name'),
    status: userStatus('status').notNull().default('active'),
    preferredLocale: text('preferred_locale').notNull().default('he'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'customer_identity',
      sql`${t.role} <> 'customer' OR (${t.phone} IS NOT NULL AND ${t.email} IS NULL AND ${t.passwordHash} IS NULL)`,
    ),
    // Staff must not carry a phone: users.phone is the customer OTP login
    // identifier, so an operator with one could authenticate by SMS and bypass
    // the invite-only, approval-gated password flow entirely.
    check(
      'staff_identity',
      sql`${t.role} = 'customer' OR (${t.email} IS NOT NULL AND ${t.phone} IS NULL)`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
