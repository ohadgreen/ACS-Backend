import { describe, expect, it, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
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
import { BookingsRepository } from '../../src/modules/bookings/bookings.repository';

const db = () => getTestDb();
const START_AT = new Date('2026-09-06T10:00:00.000Z');
const DAY_START = new Date('2026-09-05T21:00:00.000Z');
const DAY_END = new Date('2026-09-06T21:00:00.000Z');

let repo: BookingsRepository;
let locationId: string;
let sessionTypeId: string;

async function seedOperatorWithSlot(startAt: Date) {
  const userId = uuidv7();
  const operatorId = uuidv7();
  const checkinId = uuidv7();
  await db()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await db()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
  await db().insert(operatorCheckins).values({
    id: checkinId,
    operatorId,
    locationId,
    availableFrom: startAt,
    availableUntil: new Date(startAt.getTime() + 15 * 60_000),
    checkedInGeog: makePoint(35.7896, 33.3053) as never,
  });
  await db()
    .insert(operatorSlots)
    .values({ id: uuidv7(), operatorId, locationId, checkinId, startAt });
  return operatorId;
}

// users.phone is globally unique and a customer must carry one, so a shared
// literal would collide on the second insert. A counter is deterministic where
// a slice of a uuid is not guaranteed to be.
let phoneSeq = 0;

async function seedCustomer() {
  const id = uuidv7();
  phoneSeq += 1;
  await db()
    .insert(users)
    .values({
      id,
      role: 'customer',
      phone: `+97250${String(phoneSeq).padStart(7, '0')}`,
      phoneVerifiedAt: new Date(),
    });
  return id;
}

beforeEach(async () => {
  repo = new BookingsRepository(db());

  locationId = uuidv7();
  await db().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(35.7896, 33.3053) as never,
  });

  sessionTypeId = uuidv7();
  await db().insert(locationSessionTypes).values({
    id: sessionTypeId,
    locationId,
    code: 'mild',
    name: { en: 'Mild', he: 'רגוע' },
    price: '100.00',
  });
});

const attempt = async (customerId: string) =>
  repo.createBooking({
    locationId,
    startAt: START_AT,
    sessionTypeId,
    customerId,
    dayStart: DAY_START,
    dayEnd: DAY_END,
  });

describe('booking concurrency', () => {
  it('lets exactly 2 of 12 concurrent attempts win when capacity is 2', async () => {
    await seedOperatorWithSlot(START_AT);
    await seedOperatorWithSlot(START_AT);

    const customers = await Promise.all(Array.from({ length: 12 }, () => seedCustomer()));
    const results = await Promise.all(customers.map((c) => attempt(c)));

    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(2);
    expect(results.filter((r) => r === null)).toHaveLength(10);

    // No mock can tell you whether FOR UPDATE SKIP LOCKED behaves.
    const rows = await db().select().from(bookings);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.operatorId)).size).toBe(2);
  });

  it('marks both slots booked and leaves none open', async () => {
    await seedOperatorWithSlot(START_AT);
    await seedOperatorWithSlot(START_AT);

    const customers = await Promise.all(Array.from({ length: 6 }, () => seedCustomer()));
    await Promise.all(customers.map((c) => attempt(c)));

    const open = await db()
      .select()
      .from(operatorSlots)
      .where(and(eq(operatorSlots.startAt, START_AT), eq(operatorSlots.status, 'open')));
    expect(open).toHaveLength(0);
  });

  it('returns null rather than throwing when nothing is available', async () => {
    const customer = await seedCustomer();
    expect(await attempt(customer)).toBeNull();
  });

  it('ignores a slot that is not open', async () => {
    const operatorId = await seedOperatorWithSlot(START_AT);
    await db()
      .update(operatorSlots)
      .set({ status: 'cancelled' })
      .where(eq(operatorSlots.operatorId, operatorId));

    expect(await attempt(await seedCustomer())).toBeNull();
  });

  it('assigns the operator with the fewest bookings today', async () => {
    const busy = await seedOperatorWithSlot(START_AT);
    const idle = await seedOperatorWithSlot(START_AT);

    // Give `busy` an earlier booking today so the fairness ORDER BY must skip it.
    const earlier = new Date('2026-09-06T09:00:00.000Z');
    const busyCheckin = (
      await db().select().from(operatorCheckins).where(eq(operatorCheckins.operatorId, busy))
    )[0]!;
    const earlierSlot = uuidv7();
    await db().insert(operatorSlots).values({
      id: earlierSlot,
      operatorId: busy,
      locationId,
      checkinId: busyCheckin.id,
      startAt: earlier,
      status: 'booked',
    });
    await db().insert(bookings).values({
      id: uuidv7(),
      operatorSlotId: earlierSlot,
      customerId: await seedCustomer(),
      operatorId: busy,
      locationId,
      locationSessionTypeId: sessionTypeId,
      priceSnapshot: '100.00',
      currency: 'ILS',
      startAt: earlier,
    });

    const booking = await attempt(await seedCustomer());
    expect(booking?.operatorId).toBe(idle);
  });

  it('counts upcoming bookings, not just finished ones, when measuring load', async () => {
    const busy = await seedOperatorWithSlot(START_AT);
    const idle = await seedOperatorWithSlot(START_AT);

    // Later today and still 'confirmed'. Counting only completed sessions
    // would leave both operators at zero and route every advance booking to
    // whichever row Postgres happened to return first.
    const later = new Date('2026-09-06T14:00:00.000Z');
    const busyCheckin = (
      await db().select().from(operatorCheckins).where(eq(operatorCheckins.operatorId, busy))
    )[0]!;
    const laterSlot = uuidv7();
    await db().insert(operatorSlots).values({
      id: laterSlot,
      operatorId: busy,
      locationId,
      checkinId: busyCheckin.id,
      startAt: later,
      status: 'booked',
    });
    await db().insert(bookings).values({
      id: uuidv7(),
      operatorSlotId: laterSlot,
      customerId: await seedCustomer(),
      operatorId: busy,
      locationId,
      locationSessionTypeId: sessionTypeId,
      priceSnapshot: '100.00',
      currency: 'ILS',
      startAt: later,
      status: 'confirmed',
    });

    const booking = await attempt(await seedCustomer());
    expect(booking?.operatorId).toBe(idle);
  });

  it('does not count a cancelled booking against an operator', async () => {
    const cancelledOn = await seedOperatorWithSlot(START_AT);
    const other = await seedOperatorWithSlot(START_AT);

    const earlier = new Date('2026-09-06T09:00:00.000Z');
    const checkin = (
      await db()
        .select()
        .from(operatorCheckins)
        .where(eq(operatorCheckins.operatorId, cancelledOn))
    )[0]!;
    const slotId = uuidv7();
    await db().insert(operatorSlots).values({
      id: slotId,
      operatorId: cancelledOn,
      locationId,
      checkinId: checkin.id,
      startAt: earlier,
      status: 'cancelled',
    });
    await db().insert(bookings).values({
      id: uuidv7(),
      operatorSlotId: slotId,
      customerId: await seedCustomer(),
      operatorId: cancelledOn,
      locationId,
      locationSessionTypeId: sessionTypeId,
      priceSnapshot: '100.00',
      currency: 'ILS',
      startAt: earlier,
      status: 'cancelled',
    });

    // Both operators are at load 0, so either may win — what matters is that
    // no error is raised and exactly one booking is made.
    const booking = await attempt(await seedCustomer());
    expect(booking).not.toBeNull();
    expect([cancelledOn, other]).toContain(booking!.operatorId);
  });

  it('snapshots the price so later edits do not change what is owed', async () => {
    await seedOperatorWithSlot(START_AT);
    const booking = await attempt(await seedCustomer());

    await db()
      .update(locationSessionTypes)
      .set({ price: '999.00' })
      .where(eq(locationSessionTypes.id, sessionTypeId));

    const [row] = await db().select().from(bookings).where(eq(bookings.id, booking!.id));
    expect(row?.priceSnapshot).toBe('100.00');
    expect(row?.currency).toBe('ILS');
  });

  it('refuses to book the same customer into two locations at one tick', async () => {
    await seedOperatorWithSlot(START_AT);
    const other = uuidv7();
    await db().insert(locations).values({
      id: other,
      // Not a uuid prefix: uuidv7 leads with a millisecond timestamp, so two
      // ids minted in the same tick share their first 8 characters.
      code: `loc-other-${other.slice(-8)}`,
      siteCode: 'hermon',
      siteName: { en: 'Hermon', he: 'חרמון' },
      name: { en: 'Other Slope', he: 'מסלול אחר' },
      geog: makePoint(35.7897, 33.3054) as never,
    });

    const customer = await seedCustomer();
    expect(await attempt(customer)).not.toBeNull();

    // The operator-side constraint does not cover the customer side; at a ski
    // site with adjacent locations this is an easy accidental double-book.
    const previousLocation = locationId;
    locationId = other;
    sessionTypeId = uuidv7();
    await db().insert(locationSessionTypes).values({
      id: sessionTypeId,
      locationId: other,
      code: 'mild',
      name: { en: 'Mild', he: 'רגוע' },
      price: '100.00',
    });
    await seedOperatorWithSlot(START_AT);

    await expect(attempt(customer)).rejects.toThrow();
    expect(previousLocation).toBeTruthy();
  });
});
