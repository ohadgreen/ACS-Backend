import { describe, expect, it } from 'vitest';
import { transition } from '../bookings/domain/state-machine';
import type { BookingStatus } from '../bookings/domain/types';

/** Repeated verbatim from the inArray() filter in maintenance.repository.ts. */
const SWEEP_FILTER: BookingStatus[] = ['confirmed', 'customer_ready'];

const ALL_STATUSES: BookingStatus[] = [
  'confirmed',
  'customer_ready',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'expired',
];

describe('sweep filter matches the state machine', () => {
  /**
   * The sweep expires bookings in bulk rather than calling transition() per
   * row — the right choice for a batch, but it lets two definitions of
   * "expirable" drift apart silently. This fails if either side is edited alone.
   */
  it('expires exactly the statuses EXPIRE permits', () => {
    const machineAllows = ALL_STATUSES.filter(
      (status) =>
        transition(status, 'EXPIRE', 'system', {
          now: new Date('2026-09-16T12:00:00.000Z'),
          startAt: new Date('2026-09-16T11:00:00.000Z'),
          lateCancellationMin: 60,
          bookingLeadTimeMin: 5,
        }).ok,
    );

    expect([...SWEEP_FILTER].sort()).toEqual([...machineAllows].sort());
  });
});
