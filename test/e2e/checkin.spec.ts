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

async function makeOperator(approval: 'approved' | 'pending' = 'approved') {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: approval });

  return {
    operatorId,
    auth: `Bearer ${app.app
      .get(TokenService)
      .issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() })}`,
  };
}

const window = (fromIso: string, toIso: string) => ({
  locationId,
  availableFrom: fromIso,
  availableUntil: toIso,
  lat: LAT,
  lng: LNG,
});

describe('POST /operators/me/checkins', () => {
  it('materializes one slot per grid tick in the window', async () => {
    const op = await makeOperator();
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(201);

    expect(res.body.slotsCreated).toBe(4);

    const rows = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(eq(operatorSlots.operatorId, op.operatorId));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'open')).toBe(true);
  });

  it('sets operator presence to online', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(201);

    const [row] = await getTestDb().select().from(operators).where(eq(operators.id, op.operatorId));
    expect(row?.presence).toBe('online');
  });

  it('refuses an operator who is not approved', async () => {
    const op = await makeOperator('pending');
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(403);
    expect(res.body.error.code).toBe('OPERATOR_NOT_APPROVED');
  });

  it('refuses a position far from the location', async () => {
    const op = await makeOperator();
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send({
        ...window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'),
        lat: 32.0853,
        lng: 34.7818,
      })
      .expect(422);
    expect(res.body.error.code).toBe('NOT_AT_LOCATION');
  });

  it('rejects an off-grid window with 422', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:07:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(422);
  });

  it('rejects a window crossing local midnight with 422', async () => {
    const op = await makeOperator();
    // 20:00 UTC is 23:00 local; 22:00 UTC is 01:00 local the next day.
    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T20:00:00.000Z', '2026-09-06T22:00:00.000Z'))
      .expect(422);
    expect(res.body.error.code).toBe('WINDOW_CROSSES_BUSINESS_DAY');
  });

  it('rejects an inverted window with 422', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T08:00:00.000Z', '2026-09-06T07:00:00.000Z'))
      .expect(422);
  });

  it('rejects an inactive location', async () => {
    const op = await makeOperator();
    await getTestDb().update(locations).set({ isActive: false }).where(eq(locations.id, locationId));
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(404);
  });

  it('returns 409 with the conflicting ticks rather than a partial check-in', async () => {
    const op = await makeOperator();
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(201);

    const res = await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', op.auth)
      .send(window('2026-09-06T07:30:00.000Z', '2026-09-06T08:30:00.000Z'))
      .expect(409);

    expect(res.body.error.code).toBe('CHECKIN_TICK_CONFLICT');
    expect(res.body.error.details.conflicts).toEqual([
      '2026-09-06T07:30:00.000Z',
      '2026-09-06T07:45:00.000Z',
    ]);

    // The whole request rolled back — no partial second check-in survives.
    const rows = await getTestDb()
      .select()
      .from(operatorSlots)
      .where(and(eq(operatorSlots.operatorId, op.operatorId), eq(operatorSlots.status, 'open')));
    expect(rows).toHaveLength(4);
  });

  it('rejects a customer token with 403', async () => {
    const customer = `Bearer ${app.app
      .get(TokenService)
      .issueAccessToken({ sub: uuidv7(), role: 'customer', jti: uuidv7() })}`;
    await request(app.server)
      .post('/operators/me/checkins')
      .set('Authorization', customer)
      .send(window('2026-09-06T07:00:00.000Z', '2026-09-06T08:00:00.000Z'))
      .expect(403);
  });
});
