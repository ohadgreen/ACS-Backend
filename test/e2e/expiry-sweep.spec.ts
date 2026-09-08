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
import type { BookingStatus } from '../../src/modules/bookings/domain/types';

let app: TestApp;
let locationId: string;
let sessionTypeId: string;
let adminAuth: string;

const LAT = 33.3053;
const LNG = 35.7896;
const SLOT_MS = 15 * 60_000;
let phoneSeq = 0;
let tickSeq = 0;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  const adminId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: adminId, role: 'admin', email: `${adminId}@example.com`, displayName: 'A' });
  adminAuth = `Bearer ${app.app
    .get(TokenService)
    .issueAccessToken({ sub: adminId, role: 'admin', jti: uuidv7() })}`;

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

const PAST = -1;
const FUTURE = 1;

/** A grid-aligned tick a whole number of slots into the past or future. */
function tickAt(direction: number) {
  tickSeq += 1;
  const base = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  return new Date(base + direction * tickSeq * SLOT_MS);
}

async function seedSlot(startAt: Date, status: 'open' | 'booked' | 'cancelled' = 'open') {
  const userId = uuidv7();
  const operatorId = uuidv7();
  const checkinId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
  await getTestDb().insert(operatorCheckins).values({
    id: checkinId,
    operatorId,
    locationId,
    availableFrom: startAt,
    availableUntil: new Date(startAt.getTime() + SLOT_MS),
    checkedInGeog: makePoint(LNG, LAT) as never,
  });
  const slotId = uuidv7();
  await getTestDb()
    .insert(operatorSlots)
    .values({ id: slotId, operatorId, locationId, checkinId, startAt, status });
  return { slotId, operatorId };
}

async function seedBooking(startAt: Date, status: BookingStatus) {
  const slot = await seedSlot(startAt, 'booked');
  const customerId = uuidv7();
  phoneSeq += 1;
  await getTestDb()
    .insert(users)
    .values({
      id: customerId,
      role: 'customer',
      phone: `+97250${String(phoneSeq).padStart(7, '0')}`,
      phoneVerifiedAt: new Date(),
    });

  const bookingId = uuidv7();
  await getTestDb().insert(bookings).values({
    id: bookingId,
    operatorSlotId: slot.slotId,
    customerId,
    operatorId: slot.operatorId,
    locationId,
    locationSessionTypeId: sessionTypeId,
    priceSnapshot: '100.00',
    currency: 'ILS',
    startAt,
    status,
  });
  return { bookingId, slotId: slot.slotId };
}

const sweep = () =>
  request(app.server).post('/admin/maintenance/sweep-expired').set('Authorization', adminAuth);

const bookingStatusOf = async (id: string) =>
  (await getTestDb().select().from(bookings).where(eq(bookings.id, id)))[0]?.status;
const slotStatusOf = async (id: string) =>
  (await getTestDb().select().from(operatorSlots).where(eq(operatorSlots.id, id)))[0]?.status;

describe('POST /admin/maintenance/sweep-expired', () => {
  it('expires a confirmed booking whose tick has passed', async () => {
    const b = await seedBooking(tickAt(PAST), 'confirmed');
    const res = await sweep().expect(200);

    expect(res.body.bookingsExpired).toBe(1);
    expect(await bookingStatusOf(b.bookingId)).toBe('expired');
  });

  it('expires a customer_ready booking whose tick has passed', async () => {
    const b = await seedBooking(tickAt(PAST), 'customer_ready');
    await sweep().expect(200);
    expect(await bookingStatusOf(b.bookingId)).toBe('expired');
  });

  it('records the system as the actor', async () => {
    const b = await seedBooking(tickAt(PAST), 'confirmed');
    await sweep().expect(200);

    const [row] = await getTestDb().select().from(bookings).where(eq(bookings.id, b.bookingId));
    expect(row?.cancelledBy).toBe('system');
    expect(row?.cancelledAt).not.toBeNull();
  });

  it('leaves an in_progress booking alone — the session is running late, not dead', async () => {
    const b = await seedBooking(tickAt(PAST), 'in_progress');
    const res = await sweep().expect(200);

    expect(res.body.bookingsExpired).toBe(0);
    expect(await bookingStatusOf(b.bookingId)).toBe('in_progress');
  });

  it('leaves a future booking alone', async () => {
    const b = await seedBooking(tickAt(FUTURE), 'confirmed');
    const res = await sweep().expect(200);

    expect(res.body.bookingsExpired).toBe(0);
    expect(await bookingStatusOf(b.bookingId)).toBe('confirmed');
  });

  it('does not touch already-completed or cancelled bookings', async () => {
    const done = await seedBooking(tickAt(PAST), 'completed');
    const gone = await seedBooking(tickAt(PAST), 'cancelled');
    const res = await sweep().expect(200);

    expect(res.body.bookingsExpired).toBe(0);
    expect(await bookingStatusOf(done.bookingId)).toBe('completed');
    expect(await bookingStatusOf(gone.bookingId)).toBe('cancelled');
  });

  it('expires open slots whose tick has passed', async () => {
    const slot = await seedSlot(tickAt(PAST), 'open');
    const res = await sweep().expect(200);

    expect(res.body.slotsExpired).toBe(1);
    expect(await slotStatusOf(slot.slotId)).toBe('expired');
  });

  it('leaves booked past slots alone — their booking owns that decision', async () => {
    const b = await seedBooking(tickAt(PAST), 'confirmed');
    const res = await sweep().expect(200);

    expect(res.body.slotsExpired).toBe(0);
    expect(await slotStatusOf(b.slotId)).toBe('booked');
  });

  it('leaves a future open slot alone', async () => {
    const slot = await seedSlot(tickAt(FUTURE), 'open');
    const res = await sweep().expect(200);

    expect(res.body.slotsExpired).toBe(0);
    expect(await slotStatusOf(slot.slotId)).toBe('open');
  });

  it('is idempotent — a second sweep changes nothing', async () => {
    await seedBooking(tickAt(PAST), 'confirmed');
    await seedSlot(tickAt(PAST), 'open');

    const first = await sweep().expect(200);
    expect(first.body).toEqual({ bookingsExpired: 1, slotsExpired: 1 });

    const second = await sweep().expect(200);
    expect(second.body).toEqual({ bookingsExpired: 0, slotsExpired: 0 });
  });

  it('rejects a non-admin with 403', async () => {
    const operatorAuth = `Bearer ${app.app.get(TokenService).issueAccessToken({
      sub: uuidv7(),
      role: 'operator',
      operatorId: uuidv7(),
      jti: uuidv7(),
    })}`;
    await request(app.server)
      .post('/admin/maintenance/sweep-expired')
      .set('Authorization', operatorAuth)
      .expect(403);
  });
});
