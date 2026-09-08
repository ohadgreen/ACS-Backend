import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import {
  bookings,
  locationSessionTypes,
  locations,
  operatorCheckins,
  operatorSlots,
  operators,
  users,
} from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let locationId: string;
let sessionTypeId: string;

const LAT = 33.3053;
const LNG = 35.7896;
const SLOT_MS = 15 * 60_000;
const LEAD_MS = 5 * 60_000;
const LATE_MS = 60 * 60_000;

let phoneSeq = 0;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  locationId = uuidv7();
  await getTestDb().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(-8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(LNG, LAT) as never,
  });

  sessionTypeId = uuidv7();
  await getTestDb().insert(locationSessionTypes).values({
    id: sessionTypeId,
    locationId,
    code: 'mild',
    name: { en: 'Mild', he: 'רגוע' },
    price: '100.00',
  });
});

const tokens = () => app.app.get(TokenService);

async function makeOperator() {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({
      id: operatorId,
      userId,
      displayName: 'P',
      approvalStatus: 'approved',
      presence: 'online',
    });
  return {
    operatorId,
    auth: `Bearer ${tokens().issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() })}`,
  };
}

async function makeCustomer() {
  const userId = uuidv7();
  phoneSeq += 1;
  await getTestDb()
    .insert(users)
    .values({
      id: userId,
      role: 'customer',
      phone: `+97250${String(phoneSeq).padStart(7, '0')}`,
      phoneVerifiedAt: new Date(),
    });
  return {
    userId,
    auth: `Bearer ${tokens().issueAccessToken({ sub: userId, role: 'customer', jti: uuidv7() })}`,
  };
}

async function makeAdmin() {
  const userId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'admin', email: `${userId}@example.com`, displayName: 'A' });
  return `Bearer ${tokens().issueAccessToken({ sub: userId, role: 'admin', jti: uuidv7() })}`;
}

/**
 * Seeds a booking directly rather than through POST /bookings, so `startAt`
 * can sit anywhere relative to now — the cancellation-policy cases need a slot
 * that starts in two minutes, which the endpoint would rightly refuse.
 */
async function seedBooking(opts: { startAt: Date; checkinStatus?: 'active' | 'ended' } = {
  startAt: new Date(Date.now() + 4 * 60 * 60_000),
}) {
  // Floor, not ceil: rounding UP can push a deliberately-imminent slot up to
  // 15 minutes into the future and out of the window the case is testing.
  const at = new Date(Math.floor(opts.startAt.getTime() / SLOT_MS) * SLOT_MS);
  const operator = await makeOperator();
  const customer = await makeCustomer();

  const checkinId = uuidv7();
  await getTestDb().insert(operatorCheckins).values({
    id: checkinId,
    operatorId: operator.operatorId,
    locationId,
    availableFrom: at,
    availableUntil: new Date(at.getTime() + SLOT_MS),
    checkedInGeog: makePoint(LNG, LAT) as never,
    status: opts.checkinStatus ?? 'active',
  });

  const slotId = uuidv7();
  await getTestDb().insert(operatorSlots).values({
    id: slotId,
    operatorId: operator.operatorId,
    locationId,
    checkinId,
    startAt: at,
    status: 'booked',
  });

  const bookingId = uuidv7();
  await getTestDb().insert(bookings).values({
    id: bookingId,
    operatorSlotId: slotId,
    customerId: customer.userId,
    operatorId: operator.operatorId,
    locationId,
    locationSessionTypeId: sessionTypeId,
    priceSnapshot: '100.00',
    currency: 'ILS',
    startAt: at,
  });

  return { bookingId, slotId, startAt: at, operator, customer };
}

const act = (id: string, action: string, auth: string, body: Record<string, unknown> = {}) =>
  request(app.server).post(`/bookings/${id}/${action}`).set('Authorization', auth).send(body);

const slotStatus = async (slotId: string) =>
  (await getTestDb().select().from(operatorSlots).where(eq(operatorSlots.id, slotId)))[0]?.status;

const presenceOf = async (operatorId: string) =>
  (await getTestDb().select().from(operators).where(eq(operators.id, operatorId)))[0]?.presence;

const bookingRow = async (id: string) =>
  (await getTestDb().select().from(bookings).where(eq(bookings.id, id)))[0];

describe('booking lifecycle — the happy path', () => {
  it('customer ack moves confirmed to customer_ready and stamps readyAckAt', async () => {
    const b = await seedBooking();
    const res = await act(b.bookingId, 'ack', b.customer.auth).expect(200);

    expect(res.body.status).toBe('customer_ready');
    expect((await bookingRow(b.bookingId))?.readyAckAt).not.toBeNull();
  });

  it('operator start moves to in_progress and sets presence to in_session', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'ack', b.customer.auth).expect(200);
    const res = await act(b.bookingId, 'start', b.operator.auth).expect(200);

    expect(res.body.status).toBe('in_progress');
    expect((await bookingRow(b.bookingId))?.startedAt).not.toBeNull();
    expect(await presenceOf(b.operator.operatorId)).toBe('in_session');
  });

  it('operator start is allowed straight from confirmed, without an ack', async () => {
    const b = await seedBooking();
    const res = await act(b.bookingId, 'start', b.operator.auth).expect(200);
    expect(res.body.status).toBe('in_progress');
    expect((await bookingRow(b.bookingId))?.readyAckAt).toBeNull();
  });

  it('operator end moves to completed, stamps sessionEndAt, returns presence to online', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'start', b.operator.auth).expect(200);
    const res = await act(b.bookingId, 'end', b.operator.auth).expect(200);

    expect(res.body.status).toBe('completed');
    const row = await bookingRow(b.bookingId);
    // Sub-project #4 keys drone-video matching off sessionEndAt.
    expect(row?.sessionEndAt).not.toBeNull();
    expect(row?.completedAt).not.toBeNull();
    expect(await presenceOf(b.operator.operatorId)).toBe('online');
  });

  it('end returns presence to offline when the check-in has already ended', async () => {
    const b = await seedBooking({
      startAt: new Date(Date.now() + 4 * 60 * 60_000),
      checkinStatus: 'ended',
    });
    await act(b.bookingId, 'start', b.operator.auth).expect(200);
    await act(b.bookingId, 'end', b.operator.auth).expect(200);

    expect(await presenceOf(b.operator.operatorId)).toBe('offline');
  });
});

describe('booking lifecycle — forbidden actions', () => {
  it('rejects ack on an in_progress booking with 409 INVALID_TRANSITION', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'start', b.operator.auth).expect(200);

    const res = await act(b.bookingId, 'ack', b.customer.auth).expect(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects end on a booking that never started with 409', async () => {
    const b = await seedBooking();
    const res = await act(b.bookingId, 'end', b.operator.auth).expect(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects start by the customer with 403 — the route is operator-only', async () => {
    const b = await seedBooking();
    // RolesGuard runs before the handler, so the customer never reaches the
    // state machine's ACTOR_NOT_PERMITTED at all.
    await act(b.bookingId, 'start', b.customer.auth).expect(403);
  });

  it('rejects any action by an unrelated customer with 403', async () => {
    const b = await seedBooking();
    const stranger = await makeCustomer();
    const res = await act(b.bookingId, 'ack', stranger.auth).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects any action by an unassigned operator with 403', async () => {
    const b = await seedBooking();
    const stranger = await makeOperator();
    const res = await act(b.bookingId, 'start', stranger.auth).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for a booking that does not exist', async () => {
    const customer = await makeCustomer();
    await act(uuidv7(), 'ack', customer.auth).expect(404);
  });
});

describe('cancellation policy', () => {
  it('early cancel releases the slot back to open and is not late', async () => {
    const b = await seedBooking();
    const res = await act(b.bookingId, 'cancel', b.customer.auth, {
      reason: 'plans changed',
    }).expect(200);

    expect(res.body.status).toBe('cancelled');
    expect(res.body.lateCancellation).toBe(false);
    expect(await slotStatus(b.slotId)).toBe('open');
  });

  it('late cancel keeps the slot cancelled and stamps late_cancellation', async () => {
    // Inside the 60-minute late window and inside the 5-minute lead time.
    const b = await seedBooking({ startAt: new Date(Date.now() + 60_000) });
    const res = await act(b.bookingId, 'cancel', b.customer.auth).expect(200);

    expect(res.body.lateCancellation).toBe(true);
    expect(await slotStatus(b.slotId)).toBe('cancelled');
  });

  it('marks a cancel inside the late window but outside the lead time as late, yet still releases', async () => {
    // 30 minutes out: late (under 60) but resellable (over 5).
    const b = await seedBooking({ startAt: new Date(Date.now() + LATE_MS / 2) });
    const res = await act(b.bookingId, 'cancel', b.customer.auth).expect(200);

    expect(res.body.lateCancellation).toBe(true);
    expect(await slotStatus(b.slotId)).toBe('open');
  });

  it('records who cancelled and why', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'cancel', b.customer.auth, { reason: 'weather' }).expect(200);

    const row = await bookingRow(b.bookingId);
    expect(row?.cancelledBy).toBe('customer');
    expect(row?.cancellationReason).toBe('weather');
    expect(row?.cancelledAt).not.toBeNull();
  });

  it('lets the assigned operator cancel and records them as the actor', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'cancel', b.operator.auth, { reason: 'gear failure' }).expect(200);
    expect((await bookingRow(b.bookingId))?.cancelledBy).toBe('operator');
  });

  it('lets an admin cancel anyone’s booking', async () => {
    const b = await seedBooking();
    const admin = await makeAdmin();
    await act(b.bookingId, 'cancel', admin, { reason: 'site closed' }).expect(200);
    expect((await bookingRow(b.bookingId))?.cancelledBy).toBe('admin');
  });

  it('rejects a second cancel with 409', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'cancel', b.customer.auth).expect(200);
    await act(b.bookingId, 'cancel', b.customer.auth).expect(409);
  });

  it('releases a slot that a later customer can then buy', async () => {
    // The reason booking_one_active_per_slot is partial rather than total.
    const b = await seedBooking();
    await act(b.bookingId, 'cancel', b.customer.auth).expect(200);
    expect(await slotStatus(b.slotId)).toBe('open');

    const next = await makeCustomer();
    const res = await request(app.server)
      .post('/bookings')
      .set('Authorization', next.auth)
      .send({
        locationId,
        startAt: b.startAt.toISOString(),
        locationSessionTypeId: sessionTypeId,
      })
      .expect(201);
    expect(res.body.operatorSlotId).toBe(b.slotId);
  });
});

describe('no-show', () => {
  it('does not release the slot', async () => {
    const b = await seedBooking();
    const res = await act(b.bookingId, 'no-show', b.operator.auth).expect(200);

    expect(res.body.status).toBe('no_show');
    expect(await slotStatus(b.slotId)).toBe('booked');
  });

  it('is refused once the session is under way', async () => {
    const b = await seedBooking();
    await act(b.bookingId, 'start', b.operator.auth).expect(200);
    await act(b.bookingId, 'no-show', b.operator.auth).expect(409);
  });
});
