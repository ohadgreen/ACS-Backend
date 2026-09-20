import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';
import { bookings } from '../../src/infra/db/schema';
import { getTestDb } from '../integration/db.helper';
import { seedBookableBooking } from '../integration/booking.fixture';

const db = getTestDb();

let app: TestApp;
let tokens: TokenService;

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
});
afterAll(async () => {
  await app?.close();
});

/**
 * A session starts on a 15-minute tick, and `operator_slots.grid_aligned`
 * rejects anything else — so the fixture's start is floored to the grid rather
 * than taken raw from the clock. Flooring rather than ceiling keeps the
 * session already begun, which is the state an acknowledgement belongs to.
 */
const SLOT_MS = 15 * 60_000;
const startedNow = () => new Date(Math.floor(Date.now() / SLOT_MS) * SLOT_MS);

const operatorJwt = (userId: string, operatorId: string) =>
  tokens.issueAccessToken({ sub: userId, role: 'operator', operatorId, jti: uuidv7() });

describe('operator acknowledgement', () => {
  it('lets the assigned operator acknowledge on the customer behalf', async () => {
    const booking = await seedBookableBooking({ startAt: startedNow(), status: 'confirmed' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set('Authorization', `Bearer ${operatorJwt(booking.operatorUserId, booking.operatorId)}`)
      .send({});

    expect(res.status).toBe(200);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('customer_ready');
    expect(row!.readyAckAt).not.toBeNull();
  });

  // The safety valve must not become a way to touch someone else's booking.
  it('refuses an operator who is not assigned to the booking', async () => {
    const booking = await seedBookableBooking({ startAt: startedNow(), status: 'confirmed' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set('Authorization', `Bearer ${operatorJwt(uuidv7(), uuidv7())}`)
      .send({});

    expect(res.status).toBe(403);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('confirmed');
  });

  it('still lets the customer acknowledge', async () => {
    const booking = await seedBookableBooking({ startAt: startedNow(), status: 'confirmed' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set(
        'Authorization',
        `Bearer ${tokens.issueAccessToken({ sub: booking.customerId, role: 'customer', jti: uuidv7() })}`,
      )
      .send({});

    expect(res.status).toBe(200);
  });

  it('refuses a second acknowledgement', async () => {
    const booking = await seedBookableBooking({ startAt: startedNow(), status: 'customer_ready' });

    const res = await request(app.server)
      .post(`/bookings/${booking.id}/ack`)
      .set('Authorization', `Bearer ${operatorJwt(booking.operatorUserId, booking.operatorId)}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });
});
