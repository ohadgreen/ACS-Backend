import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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

let app: TestApp;
const LAT = 33.3053;
const LNG = 35.7896;
// Far enough to be outside a 300 m radius but still a real place.
const FAR_LAT = 32.0853;
const FAR_LNG = 34.7818;

const SLOT_MS = 15 * 60_000;
const LEAD_MS = 5 * 60_000;

/**
 * Discovery offers exactly [now + BOOKING_LEAD_TIME_MIN, end of today), so
 * fixtures must be anchored to the clock rather than to a fixed UTC hour: a
 * literal 21:00Z is the *end* of the Asia/Jerusalem business day in summer and
 * would be filtered out, and any fixed hour breaks once the suite runs past it.
 *
 * Ceil so the tick is strictly after the lead-time floor. The only window this
 * cannot serve is the last half hour before local midnight, when no bookable
 * tick exists today at all — which is the product behaving correctly.
 */
const bookableTick = (offsetSlots = 0) =>
  new Date(Math.ceil((Date.now() + LEAD_MS + 1) / SLOT_MS) * SLOT_MS + offsetSlots * SLOT_MS);

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function makeLocation(opts: { code: string; lat: number; lng: number; active?: boolean }) {
  const id = uuidv7();
  await getTestDb().insert(locations).values({
    id,
    code: opts.code,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    description: { en: 'Nice.', he: 'נחמד.' },
    geog: makePoint(opts.lng, opts.lat) as never,
    isActive: opts.active ?? true,
  });
  return id;
}

async function addSessionType(
  locationId: string,
  code: string,
  price: string,
  sortOrder = 0,
) {
  const id = uuidv7();
  await getTestDb()
    .insert(locationSessionTypes)
    .values({ id, locationId, code, name: { en: code, he: code }, price, sortOrder });
  return id;
}

async function addOpenSlot(locationId: string, startAt: Date) {
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
  await getTestDb()
    .insert(operatorSlots)
    .values({ id: uuidv7(), operatorId, locationId, checkinId, startAt });
  return operatorId;
}

const nearby = () => request(app.server).get(`/discovery/locations?lat=${LAT}&lng=${LNG}`);
const findLocation = (body: { locations: Array<{ id: string }> }, id: string) =>
  body.locations.find((l) => l.id === id);

describe('GET /discovery/locations', () => {
  it('returns a nearby location with its distance and minimum price', async () => {
    const id = await makeLocation({ code: `near-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    await addSessionType(id, 'extreme', '250.00');
    await addOpenSlot(id, bookableTick());

    const res = await nearby().expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found.minPrice).toBe('100.00');
    expect(found.distanceM).toBeLessThan(10);
  });

  it('returns localized names as objects carrying every locale', async () => {
    const id = await makeLocation({ code: `loc-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    await addOpenSlot(id, bookableTick());

    const res = await nearby().expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found.name).toEqual({ en: 'Slope', he: 'מסלול' });
    expect(found.siteName).toEqual({ en: 'Hermon', he: 'חרמון' });
  });

  it('excludes a location outside the radius', async () => {
    const id = await makeLocation({
      code: `far-${uuidv7().slice(0, 8)}`,
      lat: FAR_LAT,
      lng: FAR_LNG,
    });
    await addOpenSlot(id, bookableTick());

    const res = await nearby().expect(200);
    expect(findLocation(res.body, id)).toBeUndefined();
  });

  it('excludes an inactive location', async () => {
    const id = await makeLocation({
      code: `inactive-${uuidv7().slice(0, 8)}`,
      lat: LAT,
      lng: LNG,
      active: false,
    });
    await addOpenSlot(id, bookableTick());

    const res = await nearby().expect(200);
    expect(findLocation(res.body, id)).toBeUndefined();
  });

  it('reports capacity as the number of free operators at a tick', async () => {
    const id = await makeLocation({ code: `cap-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    const at = bookableTick();
    await addOpenSlot(id, at);
    await addOpenSlot(id, at);

    const res = await nearby().expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    const tick = found.slots.find((s: { startAt: string }) => s.startAt === at.toISOString());
    expect(tick.capacity).toBe(2);
  });

  it('omits a slot that is already booked', async () => {
    const id = await makeLocation({ code: `booked-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    const at = bookableTick();
    const operatorId = await addOpenSlot(id, at);
    await getTestDb().update(operatorSlots).set({ status: 'booked' });

    const res = await nearby().expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found?.slots ?? []).not.toContainEqual(
      expect.objectContaining({ startAt: at.toISOString() }),
    );
    expect(operatorId).toBeTruthy();
  });

  it('omits a tick inside the booking lead time', async () => {
    const id = await makeLocation({ code: `soon-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    // The current tick has already started, so it is inside the lead time.
    const tooSoon = new Date(Math.floor(Date.now() / SLOT_MS) * SLOT_MS);
    await addOpenSlot(id, tooSoon);

    const res = await nearby().expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found?.slots ?? []).not.toContainEqual(
      expect.objectContaining({ startAt: tooSoon.toISOString() }),
    );
  });

  it('returns a location with no session types and a null minimum price', async () => {
    const id = await makeLocation({ code: `bare-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addOpenSlot(id, bookableTick());

    const res = await nearby().expect(200);

    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    expect(found).toBeDefined();
    expect(found.minPrice).toBeNull();
  });

  it('honours an explicit radius wider than the default', async () => {
    // ~1.1 km north: outside the 300 m default, inside an explicit 2 km.
    const id = await makeLocation({
      code: `wide-${uuidv7().slice(0, 8)}`,
      lat: LAT + 0.01,
      lng: LNG,
    });
    await addOpenSlot(id, bookableTick());

    const tooTight = await nearby().expect(200);
    expect(findLocation(tooTight.body, id)).toBeUndefined();

    const wide = await request(app.server)
      .get(`/discovery/locations?lat=${LAT}&lng=${LNG}&radius=2000`)
      .expect(200);
    expect(findLocation(wide.body, id)).toBeDefined();
  });

  it('rejects missing coordinates with 422', async () => {
    await request(app.server).get('/discovery/locations').expect(422);
  });

  it('is public — no token required', async () => {
    await nearby().expect(200);
  });

  it('never consults operators.presence — an offline operator still has inventory', async () => {
    const id = await makeLocation({ code: `pres-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    const at = bookableTick();
    await addOpenSlot(id, at);
    // Presence is display state; the open slot row is the only source of truth.
    await getTestDb().update(operators).set({ presence: 'offline' });

    const res = await nearby().expect(200);
    const found = res.body.locations.find((l: { id: string }) => l.id === id);
    const tick = found.slots.find((s: { startAt: string }) => s.startAt === at.toISOString());
    expect(tick.capacity).toBe(1);
  });
});

describe('GET /discovery/locations/:id', () => {
  it('returns active session types with prices', async () => {
    const id = await makeLocation({ code: `detail-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    await addSessionType(id, 'extreme', '250.00');
    await addOpenSlot(id, bookableTick());

    const res = await request(app.server).get(`/discovery/locations/${id}`).expect(200);

    expect(res.body.sessionTypes).toHaveLength(2);
    // Equal sortOrder, so code breaks the tie: 'extreme' before 'mild'.
    expect(res.body.sessionTypes[0]).toMatchObject({ code: 'extreme', price: '250.00' });
  });

  it('honours sortOrder ahead of code', async () => {
    const id = await makeLocation({ code: `sorted-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'extreme', '250.00', 5);
    await addSessionType(id, 'mild', '100.00', 1);

    const res = await request(app.server).get(`/discovery/locations/${id}`).expect(200);
    expect(res.body.sessionTypes.map((t: { code: string }) => t.code)).toEqual([
      'mild',
      'extreme',
    ]);
  });

  it('omits a deactivated session type', async () => {
    const id = await makeLocation({ code: `hidden-${uuidv7().slice(0, 8)}`, lat: LAT, lng: LNG });
    await addSessionType(id, 'mild', '100.00');
    const retired = await addSessionType(id, 'retired', '10.00');
    await getTestDb()
      .update(locationSessionTypes)
      .set({ isActive: false })
      .where(eq(locationSessionTypes.id, retired));

    const res = await request(app.server).get(`/discovery/locations/${id}`).expect(200);
    expect(res.body.sessionTypes.map((t: { code: string }) => t.code)).toEqual(['mild']);
  });

  it('returns 404 for an inactive location', async () => {
    const id = await makeLocation({
      code: `gone-${uuidv7().slice(0, 8)}`,
      lat: LAT,
      lng: LNG,
      active: false,
    });
    await request(app.server).get(`/discovery/locations/${id}`).expect(404);
  });

  it('returns 404 for a location that does not exist', async () => {
    await request(app.server).get(`/discovery/locations/${uuidv7()}`).expect(404);
  });
});
