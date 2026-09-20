import { uuidv7 } from 'uuidv7';
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
import { getTestDb } from './db.helper';

type Status = 'confirmed' | 'customer_ready' | 'in_progress' | 'completed' | 'cancelled' | 'no_show' | 'expired';

let sequence = 0;

/**
 * A booking with every foreign key satisfied. `startAt` is passed in rather
 * than derived from the clock so a case can pin a booking anywhere relative to
 * the scan's `now`, and it must sit on a 15-minute tick — the slot this
 * booking hangs off carries the `grid_aligned` CHECK.
 */
export async function seedBookableBooking(options: { startAt: Date; status: Status }) {
  const db = getTestDb();
  const n = ++sequence;

  const customerId = uuidv7();
  const operatorUserId = uuidv7();
  const operatorId = uuidv7();
  const locationId = uuidv7();
  const sessionTypeId = uuidv7();
  const checkinId = uuidv7();
  const slotId = uuidv7();
  const bookingId = uuidv7();

  await db.insert(users).values([
    { id: customerId, role: 'customer', phone: `+97250000${String(n).padStart(4, '0')}`, preferredLocale: 'he' },
    { id: operatorUserId, role: 'operator', email: `op${n}@example.com`, preferredLocale: 'en' },
  ]);
  await db.insert(operators).values({ id: operatorId, userId: operatorUserId, displayName: `Op ${n}` });

  const name = { en: `Loc ${n}`, he: `מיקום ${n}` };
  await db.insert(locations).values({
    id: locationId,
    code: `loc-${n}`,
    siteCode: `site-${n}`,
    siteName: name,
    name,
    geog: makePoint(34.78, 32.08) as never,
  });
  await db.insert(locationSessionTypes).values({
    id: sessionTypeId,
    locationId,
    code: `type-${n}`,
    name,
    price: '100.00',
    currency: 'ILS',
  });

  const windowStart = new Date(options.startAt.getTime() - 60 * 60_000);
  await db.insert(operatorCheckins).values({
    id: checkinId,
    operatorId,
    locationId,
    availableFrom: windowStart,
    availableUntil: new Date(options.startAt.getTime() + 60 * 60_000),
    checkedInGeog: makePoint(34.78, 32.08) as never,
  });
  await db.insert(operatorSlots).values({
    id: slotId,
    operatorId,
    locationId,
    checkinId,
    startAt: options.startAt,
    status: 'booked',
  });

  await db.insert(bookings).values({
    id: bookingId,
    operatorSlotId: slotId,
    customerId,
    operatorId,
    locationId,
    locationSessionTypeId: sessionTypeId,
    priceSnapshot: '100.00',
    currency: 'ILS',
    startAt: options.startAt,
    status: options.status,
  });

  return { id: bookingId, customerId, operatorId, operatorUserId, slotId, locationId };
}
