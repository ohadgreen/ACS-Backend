import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { operatorApproval, operatorPresence } from './enums';
import { users } from './users';

export const operators = pgTable('operators', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  displayName: text('display_name').notNull(),
  bio: text('bio'),
  gearTags: text('gear_tags').array().notNull().default([]),
  approvalStatus: operatorApproval('approval_status').notNull().default('pending'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id),
  // Display state only — discovery reads slot rows, never this column.
  presence: operatorPresence('presence').notNull().default('offline'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
