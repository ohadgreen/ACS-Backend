import { pgEnum } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['customer', 'operator', 'admin']);

// 'operator_pending_setup' is the invite waiting room: the row exists but no
// password is set. Named for its role so it cannot be mistaken for a customer
// state — customers are created 'active' by OTP verify.
export const userStatus = pgEnum('user_status', [
  'operator_pending_setup',
  'active',
  'suspended',
]);

// Two orthogonal axes, deliberately not one column: a suspended operator can
// still be "online", and conflating them was a bug in the source design.
export const operatorApproval = pgEnum('operator_approval', [
  'pending',
  'approved',
  'rejected',
  'suspended',
]);
export const operatorPresence = pgEnum('operator_presence', [
  'offline',
  'online',
  'in_session',
]);
