import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { locations, operatorSlots, operators, users } from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let locationId: string;
const LAT = 33.3053;
const LNG = 35.7896;

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
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(LNG, LAT) as never,
  });
});

async function checkedInOperator(
  fromIso = '2026-09-06T07:00:00.000Z',
  toIso = '2026-09-06T09:00:00.000Z',
) {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });

  const auth = `Bearer ${app.app
    .get(TokenService)
    .issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() })}`;

  const res = await request(app.server)
    .post('/operators/me/checkins')
    .set('Authorization', auth)
    .send({ locationId, availableFrom: fromIso, availableUntil: toIso, lat: LAT, lng: LNG })
    .expect(201);

  return { operatorId, auth, checkinId: res.body.checkinId as string };
}

const openSlots = (operatorId: string) =>
  getTestDb()
    .select()
    .from(operatorSlots)
    .where(and(eq(operatorSlots.operatorId, operatorId), eq(operatorSlots.status, 'open')));

describe('check-out', () => {
  it('cancels open slots and goes offline', async () => {
    const op = await checkedInOperator();
    const res = await request(app.server)
      .post(`/operators/me/checkins/${op.checkinId}/end`)
      .set('Authorization', op.auth)
      .expect(200);

    expect(res.body.slotsCancelled).toBe(8);
    expect(await openSlots(op.operatorId)).toHaveLength(0);

    const [row] = await getTestDb().select().from(operators).where(eq(operators.id, op.operatorId));
    expect(row?.presence).toBe('offline');
  });

  it('leaves booked slots alone — the commitment survives going offline', async () => {
    const op = await checkedInOperator();
    const [slot] = await openSlots(op.operatorId);
    await getTestDb()
      .update(operatorSlots)
      .set({ status: 'booked' })
      .where(eq(operatorSlots.id, slot!.id));

    await request(app.server)
      .post(`/operators/me/checkins/${op.checkinId}/end`)
      .set('Authorization', op.auth)
      .expect(200);

    const [after] = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(eq(operatorSlots.id, slot!.id));
    expect(after?.status).toBe('booked');
  });

  it("refuses to end another operator's check-in", async () => {
    const mine = await checkedInOperator();
    const theirs = await checkedInOperator();
    await request(app.server)
      .post(`/operators/me/checkins/${theirs.checkinId}/end`)
      .set('Authorization', mine.auth)
      .expect(404);

    // Nothing of theirs was touched.
    expect(await openSlots(theirs.operatorId)).toHaveLength(8);
  });
});

describe('mid-day break', () => {
  it('cancels only the open slots inside the range', async () => {
    const op = await checkedInOperator();
    const res = await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(200);

    expect(res.body.slotsCancelled).toBe(2);
    expect(await openSlots(op.operatorId)).toHaveLength(6);
  });

  it('rejects the break when a booked slot falls inside it', async () => {
    const op = await checkedInOperator();
    const target = (await openSlots(op.operatorId)).find(
      (s) => s.startAt.toISOString() === '2026-09-06T08:00:00.000Z',
    );
    await getTestDb()
      .update(operatorSlots)
      .set({ status: 'booked' })
      .where(eq(operatorSlots.id, target!.id));

    const res = await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(409);

    expect(res.body.error.code).toBe('BREAK_HAS_BOOKINGS');
    expect(res.body.error.details.conflicts).toEqual(['2026-09-06T08:00:00.000Z']);
    // Nothing was cancelled — the break is all or nothing.
    expect(await openSlots(op.operatorId)).toHaveLength(7);
  });

  it('lets the operator return early by checking in again for the remainder', async () => {
    const op = await checkedInOperator();
    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(200);

    // Cancelled rows are excluded from the partial unique index, so these
    // ticks can be regenerated cleanly.
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send({
        locationId,
        availableFrom: '2026-09-06T08:15:00.000Z',
        availableUntil: '2026-09-06T08:30:00.000Z',
        lat: LAT,
        lng: LNG,
      })
      .expect(201);

    expect(await openSlots(op.operatorId)).toHaveLength(7);
  });

  it('rejects an off-grid range with 422', async () => {
    const op = await checkedInOperator();
    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:07:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(422);
  });

  it('rejects an inverted range with 422', async () => {
    const op = await checkedInOperator();
    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:30:00.000Z', to: '2026-09-06T08:00:00.000Z' })
      .expect(422);
  });

  it("never touches another operator's slots", async () => {
    const mine = await checkedInOperator();
    const theirs = await checkedInOperator();

    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', mine.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(200);

    expect(await openSlots(theirs.operatorId)).toHaveLength(8);
  });
});

describe('operator schedule', () => {
  it('returns the calling operator’s own day only', async () => {
    const mine = await checkedInOperator();
    await checkedInOperator();

    const res = await request(app.server)
      .get('/operators/me/schedule?date=2026-09-06')
      .set('Authorization', mine.auth)
      .expect(200);

    expect(res.body.slots).toHaveLength(8);
    expect(
      res.body.slots.every((s: { operatorId: string }) => s.operatorId === mine.operatorId),
    ).toBe(true);
  });

  it('returns an empty day when nothing is scheduled', async () => {
    const op = await checkedInOperator();
    const res = await request(app.server)
      .get('/operators/me/schedule?date=2026-09-07')
      .set('Authorization', op.auth)
      .expect(200);
    expect(res.body.slots).toEqual([]);
  });

  it('includes cancelled slots so the operator can see what they gave up', async () => {
    const op = await checkedInOperator();
    await request(app.server)
      .post('/operators/me/breaks')
      .set('Authorization', op.auth)
      .send({ from: '2026-09-06T08:00:00.000Z', to: '2026-09-06T08:30:00.000Z' })
      .expect(200);

    const res = await request(app.server)
      .get('/operators/me/schedule?date=2026-09-06')
      .set('Authorization', op.auth)
      .expect(200);

    const statuses = (res.body.slots as Array<{ status: string }>).map((s) => s.status);
    expect(statuses.filter((s) => s === 'cancelled')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'open')).toHaveLength(6);
  });
});
