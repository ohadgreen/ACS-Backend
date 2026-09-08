import type {
  ActorKind,
  BookingEvent,
  BookingStatus,
  StampField,
  TransitionContext,
  TransitionResult,
} from './types';

interface Rule {
  from: BookingStatus[];
  actors: ActorKind[];
  next: BookingStatus;
  stampField: StampField;
}

/**
 * The whole lifecycle, declared once. Adding a state or an event means editing
 * this table and nothing else — and the test suite walks the full cartesian
 * product, so any cell not listed here is provably rejected.
 */
const RULES: Record<BookingEvent, Rule> = {
  CUSTOMER_ACK: {
    from: ['confirmed'],
    actors: ['customer'],
    next: 'customer_ready',
    stampField: 'readyAckAt',
  },
  // START is allowed from 'confirmed' as well as 'customer_ready': readiness
  // reminders arrive with the scheduler in sub-project #3, so until then a
  // missing acknowledgement must never block a real session.
  START: {
    from: ['confirmed', 'customer_ready'],
    actors: ['operator'],
    next: 'in_progress',
    stampField: 'startedAt',
  },
  END_SESSION: {
    from: ['in_progress'],
    actors: ['operator'],
    next: 'completed',
    stampField: 'sessionEndAt',
  },
  CANCEL: {
    from: ['confirmed', 'customer_ready'],
    actors: ['customer', 'operator', 'admin'],
    next: 'cancelled',
    stampField: 'cancelledAt',
  },
  MARK_NO_SHOW: {
    from: ['confirmed', 'customer_ready'],
    actors: ['operator'],
    next: 'no_show',
    stampField: 'cancelledAt',
  },
  EXPIRE: {
    from: ['confirmed', 'customer_ready'],
    actors: ['system'],
    next: 'expired',
    stampField: 'cancelledAt',
  },
};

export function transition(
  current: BookingStatus,
  event: BookingEvent,
  actor: ActorKind,
  ctx: TransitionContext,
): TransitionResult {
  const rule = RULES[event];
  if (!rule.from.includes(current)) {
    return { ok: false, code: 'INVALID_TRANSITION' };
  }
  if (!rule.actors.includes(actor)) {
    return { ok: false, code: 'ACTOR_NOT_PERMITTED' };
  }

  const minutesUntilStart = (ctx.startAt.getTime() - ctx.now.getTime()) / 60_000;

  // Late cancellation is recorded for future penalty logic only. No penalties
  // in MVP: payment happens after the session, so there is nothing to charge.
  const lateCancellation = event === 'CANCEL' && minutesUntilStart <= ctx.lateCancellationMin;

  // Inventory returns to sale only while there is still meaningful notice.
  const releaseSlot = event === 'CANCEL' && minutesUntilStart > ctx.bookingLeadTimeMin;

  return { ok: true, next: rule.next, stampField: rule.stampField, lateCancellation, releaseSlot };
}
