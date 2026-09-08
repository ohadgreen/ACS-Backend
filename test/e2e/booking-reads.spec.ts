import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
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
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
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

let tickSeq = 0;

/** Each booking gets its own tick, so the per-customer index never collides. */
async function seedBooking(parties?: {
  operator?: Awaited<ReturnType<typeof makeOperator>>;
  customer?: Awaited<ReturnType<typeof makeCustomer>>;
}) {
  const operator = parties?.operator ?? (await makeOperator());
  const customer = parties?.customer ?? (await makeCustomer());
  tickSeq += 1;
  const at = new Date(Math.floor(Date.now() / SLOT_MS) * SLOT_MS + tickSeq * SLOT_MS);

  const checkinId = uuidv7();
  await getTestDb().insert(operatorCheckins).values({
    id: checkinId,
    operatorId: operator.operatorId,
    locationId,
    availableFrom: at,
    availableUntil: new Date(at.getTime() + SLOT_MS),
    checkedInGeog: makePoint(LNG, LAT) as never,
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

const list = (auth: string) => request(app.server).get('/bookings').set('Authorization', auth);
const read = (id: string, auth: string) =>
  request(app.server).get(`/bookings/${id}`).set('Authorization', auth);

describe('GET /bookings', () => {
  it('lists only the calling customer’s bookings', async () => {
    const mine = await seedBooking();
    const theirs = await seedBooking();

    const res = await list(mine.customer.auth).expect(200);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual([mine.bookingId]);
    expect(res.body.map((b: { id: string }) => b.id)).not.toContain(theirs.bookingId);
  });

  it('lists only the calling operator’s assigned bookings', async () => {
    const mine = await seedBooking();
    const theirs = await seedBooking();

    const res = await list(mine.operator.auth).expect(200);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual([mine.bookingId]);
    expect(res.body.map((b: { id: string }) => b.id)).not.toContain(theirs.bookingId);
  });

  it('returns newest first', async () => {
    const customer = await makeCustomer();
    const first = await seedBooking({ customer });
    const second = await seedBooking({ customer });

    const res = await list(customer.auth).expect(200);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual([second.bookingId, first.bookingId]);
  });

  it('returns an empty list for a customer with no bookings', async () => {
    const customer = await makeCustomer();
    const res = await list(customer.auth).expect(200);
    expect(res.body).toEqual([]);
  });

  it('rejects an admin — the list is scoped to a party, not a role', async () => {
    const admin = await makeAdmin();
    await list(admin).expect(403);
  });
});

describe('GET /bookings/:id', () => {
  it('lets the booking’s customer read it', async () => {
    const b = await seedBooking();
    const res = await read(b.bookingId, b.customer.auth).expect(200);
    expect(res.body.id).toBe(b.bookingId);
  });

  it('lets the assigned operator read it', async () => {
    const b = await seedBooking();
    const res = await read(b.bookingId, b.operator.auth).expect(200);
    expect(res.body.id).toBe(b.bookingId);
  });

  it('lets an admin read any booking', async () => {
    const b = await seedBooking();
    const admin = await makeAdmin();
    const res = await read(b.bookingId, admin).expect(200);
    expect(res.body.id).toBe(b.bookingId);
  });

  it('returns 403 to an unrelated customer — the IDOR case', async () => {
    const b = await seedBooking();
    const stranger = await makeCustomer();
    // 403, not 404: the booking exists and the guard says so, because the
    // caller already knows the id. What it must not leak is the contents.
    const res = await read(b.bookingId, stranger.auth).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body).not.toHaveProperty('priceSnapshot');
  });

  it('returns 403 to an unassigned operator', async () => {
    const b = await seedBooking();
    const stranger = await makeOperator();
    await read(b.bookingId, stranger.auth).expect(403);
  });

  it('returns 404 for a booking that does not exist', async () => {
    const customer = await makeCustomer();
    const res = await read(uuidv7(), customer.auth).expect(404);
    expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
  });

  it('rejects an anonymous caller with 401', async () => {
    const b = await seedBooking();
    await request(app.server).get(`/bookings/${b.bookingId}`).expect(401);
  });
});
