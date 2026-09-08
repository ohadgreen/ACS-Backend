import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import {
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

/** Strictly beyond the lead-time floor — see the note in discovery.spec.ts. */
const bookableTick = (offsetSlots = 0) =>
  new Date(Math.ceil((Date.now() + LEAD_MS + 1) / SLOT_MS) * SLOT_MS + offsetSlots * SLOT_MS);

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

async function seedOpenSlot(startAt: Date, atLocation = locationId) {
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
    locationId: atLocation,
    availableFrom: startAt,
    availableUntil: new Date(startAt.getTime() + SLOT_MS),
    checkedInGeog: makePoint(LNG, LAT) as never,
  });
  await getTestDb()
    .insert(operatorSlots)
    .values({ id: uuidv7(), operatorId, locationId: atLocation, checkinId, startAt });
  return operatorId;
}

async function customer(opts: { verified?: boolean } = {}) {
  const userId = uuidv7();
  phoneSeq += 1;
  await getTestDb()
    .insert(users)
    .values({
      id: userId,
      role: 'customer',
      phone: `+97250${String(phoneSeq).padStart(7, '0')}`,
      phoneVerifiedAt: (opts.verified ?? true) ? new Date() : null,
    });
  return {
    userId,
    auth: `Bearer ${app.app
      .get(TokenService)
      .issueAccessToken({ sub: userId, role: 'customer', jti: uuidv7() })}`,
  };
}

const book = (auth: string, body: Record<string, unknown>) =>
  request(app.server).post('/bookings').set('Authorization', auth).send(body);

const validBody = (startAt: Date) => ({
  locationId,
  startAt: startAt.toISOString(),
  locationSessionTypeId: sessionTypeId,
});

describe('POST /bookings', () => {
  it('creates a confirmed booking with a snapshotted price', async () => {
    const at = bookableTick();
    const operatorId = await seedOpenSlot(at);
    const cust = await customer();

    const res = await book(cust.auth, validBody(at)).expect(201);

    expect(res.body).toMatchObject({
      status: 'confirmed',
      customerId: cust.userId,
      operatorId,
      locationId,
      priceSnapshot: '100.00',
      currency: 'ILS',
      lateCancellation: false,
    });
    expect(new Date(res.body.startAt).toISOString()).toBe(at.toISOString());
  });

  it('withdraws the slot it just sold', async () => {
    const at = bookableTick();
    await seedOpenSlot(at);
    const cust = await customer();

    const res = await book(cust.auth, validBody(at)).expect(201);

    const [slot] = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(eq(operatorSlots.id, res.body.operatorSlotId));
    expect(slot?.status).toBe('booked');
  });

  it('returns 409 SLOT_UNAVAILABLE when nothing is free', async () => {
    const cust = await customer();
    const res = await book(cust.auth, validBody(bookableTick())).expect(409);
    expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('returns 409 when the customer already holds that tick', async () => {
    const at = bookableTick();
    await seedOpenSlot(at);
    await seedOpenSlot(at);
    const cust = await customer();

    await book(cust.auth, validBody(at)).expect(201);
    const res = await book(cust.auth, validBody(at)).expect(409);
    expect(res.body.error.code).toBe('CUSTOMER_ALREADY_BOOKED');
  });

  it('rejects a session type from another location with 422', async () => {
    const at = bookableTick();
    await seedOpenSlot(at);

    const otherLocation = uuidv7();
    await getTestDb().insert(locations).values({
      id: otherLocation,
      code: `loc-other-${otherLocation.slice(-8)}`,
      siteCode: 'hermon',
      siteName: { en: 'Hermon', he: 'חרמון' },
      name: { en: 'Other', he: 'אחר' },
      geog: makePoint(LNG, LAT) as never,
    });
    const foreignType = uuidv7();
    await getTestDb().insert(locationSessionTypes).values({
      id: foreignType,
      locationId: otherLocation,
      code: 'mild',
      name: { en: 'Mild', he: 'רגוע' },
      price: '100.00',
    });

    const cust = await customer();
    const res = await book(cust.auth, {
      ...validBody(at),
      locationSessionTypeId: foreignType,
    }).expect(422);
    expect(res.body.error.code).toBe('SESSION_TYPE_NOT_FOUND');
  });

  it('rejects an inactive session type with 422', async () => {
    const at = bookableTick();
    await seedOpenSlot(at);
    await getTestDb()
      .update(locationSessionTypes)
      .set({ isActive: false })
      .where(eq(locationSessionTypes.id, sessionTypeId));

    const cust = await customer();
    const res = await book(cust.auth, validBody(at)).expect(422);
    expect(res.body.error.code).toBe('SESSION_TYPE_NOT_FOUND');
  });

  it('rejects an off-grid startAt with 422', async () => {
    const at = new Date(bookableTick().getTime() + 7 * 60_000);
    const cust = await customer();
    await book(cust.auth, validBody(at)).expect(422);
  });

  it('rejects a startAt inside the lead time with 422', async () => {
    // The current tick has already begun, so it is inside the lead time.
    const at = new Date(Math.floor(Date.now() / SLOT_MS) * SLOT_MS);
    await seedOpenSlot(at);
    const cust = await customer();
    await book(cust.auth, validBody(at)).expect(422);
  });

  it('rejects an unverified customer with 403', async () => {
    const at = bookableTick();
    await seedOpenSlot(at);
    const cust = await customer({ verified: false });

    const res = await book(cust.auth, validBody(at)).expect(403);
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED');
  });

  it('rejects an operator token with 403', async () => {
    const at = bookableTick();
    await seedOpenSlot(at);
    const operatorAuth = `Bearer ${app.app.get(TokenService).issueAccessToken({
      sub: uuidv7(),
      role: 'operator',
      operatorId: uuidv7(),
      jti: uuidv7(),
    })}`;
    await book(operatorAuth, validBody(at)).expect(403);
  });

  it('rejects an anonymous caller with 401', async () => {
    await request(app.server).post('/bookings').send(validBody(bookableTick())).expect(401);
  });

  it('lets the same customer hold two different ticks', async () => {
    const first = bookableTick();
    const second = bookableTick(1);
    await seedOpenSlot(first);
    await seedOpenSlot(second);
    const cust = await customer();

    await book(cust.auth, validBody(first)).expect(201);
    await book(cust.auth, validBody(second)).expect(201);
  });
});
