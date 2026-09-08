import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { getTestDb, getTestRedis } from '../integration/db.helper';
import { users } from '../../src/infra/db/schema';
import { PasswordService } from '../../src/common/crypto/password.service';
import { FakeSmsProvider } from '../../src/modules/sms/fake-sms.provider';
import { SMS_PROVIDER } from '../../src/modules/sms/sms-provider';
import { createTestApp, type TestApp } from './app.helper';

let app: TestApp;
let sms: FakeSmsProvider;
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  sms = new FakeSmsProvider();
  app = await createTestApp({ overrides: [{ token: SMS_PROVIDER, value: sms }] });
});
beforeEach(async () => {
  await getTestRedis().flushdb();
  sms.sent.length = 0;
});
afterAll(async () => {
  await app?.close();
});

describe('auth rate limiting', () => {
  it('applies the OTP resend cooldown per phone', async () => {
    await request(app.server).post('/auth/otp/request').send({ phone: '0507770001' }).expect(204);
    const res = await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '0507770001' })
      .expect(429);

    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    // The rejected request must not have cost an SMS.
    expect(sms.sent).toHaveLength(1);
  });

  it('counts normalized forms of one number as the same phone', async () => {
    await request(app.server).post('/auth/otp/request').send({ phone: '0507770002' }).expect(204);
    await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '+972507770002' })
      .expect(429);
    await request(app.server)
      .post('/auth/otp/request')
      .send({ phone: '050-777-0002' })
      .expect(429);
    expect(sms.sent).toHaveLength(1);
  });

  it('limits repeated failed logins for one email', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.server)
        .post('/auth/login')
        .send({ email: 'brute@example.com', password: 'nope' })
        .expect(401);
    }
    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'brute@example.com', password: 'nope' })
      .expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('counts login attempts per email regardless of case', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.server)
        .post('/auth/login')
        .send({ email: i % 2 ? 'MiXeD@example.com' : 'mixed@example.com', password: 'nope' })
        .expect(401);
    }
    await request(app.server)
      .post('/auth/login')
      .send({ email: 'mixed@example.com', password: 'nope' })
      .expect(429);
  });

  it('clears the email counter on a successful login', async () => {
    const userId = uuidv7();
    await getTestDb()
      .insert(users)
      .values({
        id: userId,
        role: 'admin',
        email: 'typos@example.com',
        displayName: 'Admin',
        passwordHash: await new PasswordService().hash(PASSWORD),
      });

    // Four typos, then success — the counter resets, so four more typos are
    // still allowed rather than locking out a legitimate user.
    for (let i = 0; i < 4; i++) {
      await request(app.server)
        .post('/auth/login')
        .send({ email: 'typos@example.com', password: 'wrong' })
        .expect(401);
    }
    await request(app.server)
      .post('/auth/login')
      .send({ email: 'typos@example.com', password: PASSWORD })
      .expect(200);

    for (let i = 0; i < 4; i++) {
      await request(app.server)
        .post('/auth/login')
        .send({ email: 'typos@example.com', password: 'wrong' })
        .expect(401);
    }
  });
});
