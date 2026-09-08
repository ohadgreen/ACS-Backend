export type BookingStatus =
  | 'confirmed'
  | 'customer_ready'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'expired';

export type BookingEvent =
  | 'CUSTOMER_ACK'
  | 'START'
  | 'END_SESSION'
  | 'CANCEL'
  | 'MARK_NO_SHOW'
  | 'EXPIRE';

export type ActorKind = 'customer' | 'operator' | 'admin' | 'system';

export type StampField =
  | 'readyAckAt'
  | 'startedAt'
  | 'sessionEndAt'
  | 'cancelledAt'
  | 'completedAt';

/**
 * Everything the machine is allowed to know. `now` is passed in rather than
 * read, which is what makes every policy boundary testable to the minute.
 */
export interface TransitionContext {
  now: Date;
  startAt: Date;
  lateCancellationMin: number;
  bookingLeadTimeMin: number;
}

export type TransitionResult =
  | {
      ok: true;
      next: BookingStatus;
      stampField: StampField;
      lateCancellation: boolean;
      /** Whether the underlying operator_slot returns to 'open' for resale. */
      releaseSlot: boolean;
    }
  | { ok: false; code: string };
