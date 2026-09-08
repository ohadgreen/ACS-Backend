import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { getTestDb, getTestRedis } from '../integration/db.helper';
import { users } from '../../src/infra/db/schema';
import { FakeSmsProvider } from '../../src/modules/sms/fake-sms.provider';
import { SMS_PROVIDER } from '../../src/modules/sms/sms-provider';
import { createTestApp, type TestApp } from './app.helper';

let app: TestApp;
let sms: FakeSmsProvider;

beforeAll(async () => {
  sms = new FakeSmsProvider();
  app = await createTestApp({ overrides: [{ token: SMS_PROVIDER, value: sms }] });
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  // Cooldowns and daily caps live in Redis; the global afterEach flushes it,
  // but clear the captured messages too.
  await getTestRedis().flushdb();
  sms.sent.length = 0;
});

/** Reads the real code off the wire, so the whole protocol is exercised. */
async function login(rawPhone: string, locale?: string) {
  await request(app.server)
    .post('/auth/otp/request')
    .send({ phone: rawPhone, ...(locale ? { locale } : {}) })
    .expect(204);

  const e164 = sms.sent.at(-1)!.phone;
  const code = sms.lastCodeFor(e164)!;
  return request(app.server).post('/auth/otp/verify').send({ phone: rawPhone, code });
}

describe('customer OTP', () => {
  it('sends a message to the normalized number', async () => {
    await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '050-123-4567', locale: 'he' })
      .expect(204);

    expect(sms.sent.at(-1)?.phone).toBe('+972501234567');
    expect(sms.sent.at(-1)?.message).toMatch(/\d{6}/);
  });

  it('sends Hebrew or English according to the requested locale', async () => {
    await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '0501110001', locale: 'en' })
      .expect(204);
    expect(sms.sent.at(-1)?.message).toContain('ACS code');

    await getTestRedis().flushdb();
    await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '0501110001', locale: 'he' })
      .expect(204);
    expect(sms.sent.at(-1)?.message).toContain('קוד');
  });

  it('creates the customer on first successful verify', async () => {
    const res = await login('0502222222');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const [row] = await getTestDb().select().from(users).where(eq(users.phone, '+972502222222'));
    expect(row?.role).toBe('customer');
    expect(row?.phoneVerifiedAt).not.toBeNull();
    expect(row?.displayName).toBeNull();
  });

  it('reuses the existing customer on a second login', async () => {
    expect((await login('0503333333')).status).toBe(200);
    await getTestRedis().flushdb();
    // A different written form of the same number must not create a second row.
    expect((await login('+972503333333')).status).toBe(200);

    const rows = await getTestDb().select().from(users).where(eq(users.phone, '+972503333333'));
    expect(rows).toHaveLength(1);
  });

  it('persists preferred_locale from the request', async () => {
    expect((await login('0504444444', 'en')).status).toBe(200);
    const [row] = await getTestDb().select().from(users).where(eq(users.phone, '+972504444444'));
    expect(row?.preferredLocale).toBe('en');
  });

  it('rejects a wrong code with OTP_INVALID', async () => {
    await request(app.server).post('/auth/otp/request').send({ phone: '0505555555' }).expect(204);
    const res = await request(app.server)
      .post('/auth/otp/verify')
      .send({ phone: '0505555555', code: '000000' })
      .expect(401);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('will not accept the same code twice', async () => {
    await request(app.server).post('/auth/otp/request').send({ phone: '0506660001' }).expect(204);
    const code = sms.lastCodeFor('+972506660001')!;
    await request(app.server)
      .post('/auth/otp/verify')
      .send({ phone: '0506660001', code })
      .expect(200);
    await request(app.server)
      .post('/auth/otp/verify')
      .send({ phone: '0506660001', code })
      .expect(401);
  });

  it('rejects an invalid phone number with 422', async () => {
    await request(app.server).post('/auth/otp/request').send({ phone: '12' }).expect(422);
  });

  it('rejects a non-Israeli number with PHONE_COUNTRY_UNSUPPORTED', async () => {
    const res = await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '+14155552671' })
      .expect(422);

    // Better an explicit failure than "code sent" for an SMS that never
    // arrives — that failure mode is near-undiagnosable from support tickets.
    expect(res.body.error.code).toBe('PHONE_COUNTRY_UNSUPPORTED');
    expect(sms.sent).toHaveLength(0);
  });

  it('rejects an unsupported locale with 422', async () => {
    await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '0506666666', locale: 'fr' })
      .expect(422);
  });

  it('rejects a non-six-digit code with 422', async () => {
    await request(app.server)
      .post('/auth/otp/verify')
      .send({ phone: '0506666666', code: '12' })
      .expect(422);
  });

  it('returns 502 when the gateway fails, and does not claim success', async () => {
    sms.failNext = true;
    const res = await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '0507770009' })
      .expect(502);
    expect(res.body.error.code).toBe('SMS_DELIVERY_FAILED');
  });

  it('never echoes the code in a response body', async () => {
    await request(app.server).post('/auth/otp/request').send({ phone: '0508880001' }).expect(204);
    const code = sms.lastCodeFor('+972508880001')!;
    const res = await request(app.server)
      .post('/auth/otp/verify')
      .send({ phone: '0508880001', code })
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain(code);
  });
});
