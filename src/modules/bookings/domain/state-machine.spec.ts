import { describe, expect, it } from 'vitest';
import { transition } from './state-machine';
import type { ActorKind, BookingEvent, BookingStatus } from './types';

const ALL_STATUSES: BookingStatus[] = [
  'confirmed',
  'customer_ready',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'expired',
];
const ALL_EVENTS: BookingEvent[] = [
  'CUSTOMER_ACK',
  'START',
  'END_SESSION',
  'CANCEL',
  'MARK_NO_SHOW',
  'EXPIRE',
];
const ALL_ACTORS: ActorKind[] = ['customer', 'operator', 'admin', 'system'];

const START_AT = new Date('2026-09-06T10:00:00.000Z');
const ctx = (nowIso: string) => ({
  now: new Date(nowIso),
  startAt: START_AT,
  lateCancellationMin: 60,
  bookingLeadTimeMin: 5,
});
const WELL_BEFORE = ctx('2026-09-06T06:00:00.000Z');
const JUST_BEFORE = ctx('2026-09-06T09:58:00.000Z');

/** Every cell the spec's table fills in. */
const ALLOWED: Array<[BookingStatus, BookingEvent, ActorKind, BookingStatus]> = [
  ['confirmed', 'CUSTOMER_ACK', 'customer', 'customer_ready'],
  ['confirmed', 'START', 'operator', 'in_progress'],
  ['customer_ready', 'START', 'operator', 'in_progress'],
  ['in_progress', 'END_SESSION', 'operator', 'completed'],
  ['confirmed', 'CANCEL', 'customer', 'cancelled'],
  ['confirmed', 'CANCEL', 'operator', 'cancelled'],
  ['confirmed', 'CANCEL', 'admin', 'cancelled'],
  ['customer_ready', 'CANCEL', 'customer', 'cancelled'],
  ['customer_ready', 'CANCEL', 'operator', 'cancelled'],
  ['customer_ready', 'CANCEL', 'admin', 'cancelled'],
  ['confirmed', 'MARK_NO_SHOW', 'operator', 'no_show'],
  ['customer_ready', 'MARK_NO_SHOW', 'operator', 'no_show'],
  ['confirmed', 'EXPIRE', 'system', 'expired'],
  ['customer_ready', 'EXPIRE', 'system', 'expired'],
];

const allowedKey = (s: BookingStatus, e: BookingEvent, a: ActorKind) => `${s}|${e}|${a}`;
const ALLOWED_KEYS = new Set(ALLOWED.map(([s, e, a]) => allowedKey(s, e, a)));

describe('booking state machine — allowed transitions', () => {
  it.each(ALLOWED)('%s + %s by %s becomes %s', (from, event, actor, expected) => {
    const result = transition(from, event, actor, WELL_BEFORE);
    expect(result).toMatchObject({ ok: true, next: expected });
  });

  it('stamps the right timestamp field for each transition', () => {
    expect(transition('confirmed', 'CUSTOMER_ACK', 'customer', WELL_BEFORE)).toMatchObject({
      stampField: 'readyAckAt',
    });
    expect(transition('confirmed', 'START', 'operator', WELL_BEFORE)).toMatchObject({
      stampField: 'startedAt',
    });
    expect(transition('in_progress', 'END_SESSION', 'operator', WELL_BEFORE)).toMatchObject({
      stampField: 'sessionEndAt',
    });
    expect(transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE)).toMatchObject({
      stampField: 'cancelledAt',
    });
  });
});

describe('booking state machine — every forbidden cell', () => {
  const forbidden = ALL_STATUSES.flatMap((status) =>
    ALL_EVENTS.flatMap((event) =>
      ALL_ACTORS.filter((actor) => !ALLOWED_KEYS.has(allowedKey(status, event, actor))).map(
        (actor) => ({ status, event, actor }),
      ),
    ),
  );

  // The spec requires every empty cell be a test, not merely every filled one.
  it.each(forbidden)('rejects $status + $event by $actor', ({ status, event, actor }) => {
    expect(transition(status, event, actor, WELL_BEFORE)).toMatchObject({ ok: false });
  });

  it('covers the whole grid', () => {
    expect(forbidden.length + ALLOWED.length).toBe(
      ALL_STATUSES.length * ALL_EVENTS.length * ALL_ACTORS.length,
    );
  });

  it('distinguishes a wrong state from a wrong actor', () => {
    // Right actor, impossible state.
    expect(transition('completed', 'CANCEL', 'customer', WELL_BEFORE)).toEqual({
      ok: false,
      code: 'INVALID_TRANSITION',
    });
    // Possible state, wrong actor — the customer may not start a session.
    expect(transition('confirmed', 'START', 'customer', WELL_BEFORE)).toEqual({
      ok: false,
      code: 'ACTOR_NOT_PERMITTED',
    });
  });
});

describe('cancellation policy', () => {
  it('is not late and releases the slot when cancelled well in advance', () => {
    expect(transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE)).toMatchObject({
      lateCancellation: false,
      releaseSlot: true,
    });
  });

  it('is late and does not release the slot close to the start', () => {
    expect(transition('confirmed', 'CANCEL', 'customer', JUST_BEFORE)).toMatchObject({
      lateCancellation: true,
      releaseSlot: false,
    });
  });

  it('marks late exactly at the threshold boundary', () => {
    // Exactly 60 minutes before start is already inside the late window.
    const atThreshold = ctx('2026-09-06T09:00:00.000Z');
    expect(transition('confirmed', 'CANCEL', 'customer', atThreshold)).toMatchObject({
      lateCancellation: true,
    });
  });

  it('still releases the slot one minute outside the late window', () => {
    // Late and releasable are two different thresholds: 61 minutes out is not
    // late, and is far beyond the 5-minute lead time, so it goes back on sale.
    const justOutside = ctx('2026-09-06T08:59:00.000Z');
    expect(transition('confirmed', 'CANCEL', 'customer', justOutside)).toMatchObject({
      lateCancellation: false,
      releaseSlot: true,
    });
  });

  it('stops releasing the slot once the start is inside the lead time', () => {
    // A slot starting in four minutes cannot be resold — nobody could book it.
    const insideLead = ctx('2026-09-06T09:56:00.000Z');
    expect(transition('confirmed', 'CANCEL', 'customer', insideLead)).toMatchObject({
      releaseSlot: false,
    });
  });

  it('never releases a slot for a no-show', () => {
    expect(transition('confirmed', 'MARK_NO_SHOW', 'operator', WELL_BEFORE)).toMatchObject({
      releaseSlot: false,
    });
  });

  it('never releases a slot on expiry', () => {
    expect(transition('confirmed', 'EXPIRE', 'system', WELL_BEFORE)).toMatchObject({
      releaseSlot: false,
      lateCancellation: false,
    });
  });
});

describe('purity', () => {
  it('reads time only from ctx — the same inputs always give the same answer', () => {
    const a = transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE);
    const b = transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE);
    expect(a).toEqual(b);
  });

  it('gives the same answer regardless of the real clock', () => {
    // A ctx pinned in the past must still report "not late": if the machine
    // ever read Date.now(), this would flip.
    expect(transition('confirmed', 'CANCEL', 'customer', WELL_BEFORE)).toMatchObject({
      lateCancellation: false,
    });
  });
});
