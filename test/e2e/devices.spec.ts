import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { users } from '../../src/infra/db/schema';
import { getTestDb } from '../integration/db.helper';

const db = getTestDb();

let app: TestApp;
let tokens: TokenService;
let devices: DevicesRepository;

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
  devices = app.app.get(DevicesRepository);
});
afterAll(async () => {
  await app?.close();
});

async function customerWithToken() {
  const id = uuidv7();
  await db
    .insert(users)
    .values({ id, role: 'customer', phone: `+9725${String(Date.now()).slice(-8)}`, preferredLocale: 'he' });
  const jwt = tokens.issueAccessToken({ sub: id, role: 'customer', jti: uuidv7() });
  return { id, jwt };
}

const PUSH_TOKEN = 'ExponentPushToken[cccccccccccccccccccccc]';

describe('POST /me/devices', () => {
  it('registers a token and answers 200, not 201', async () => {
    const { id, jwt } = await customerWithToken();
    const res = await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN, platform: 'ios' });

    // 200: repeat registration updates rather than creates, so this route
    // does not genuinely create a resource every time.
    expect(res.status).toBe(200);
    expect(await devices.listActiveFor(id)).toEqual([PUSH_TOKEN]);
  });

  it('is idempotent across repeated registrations', async () => {
    const { id, jwt } = await customerWithToken();
    const agent = request(app.server);
    await agent.post('/me/devices').set('Authorization', `Bearer ${jwt}`).send({ token: PUSH_TOKEN, platform: 'ios' });
    await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN, platform: 'ios' });

    expect(await devices.listActiveFor(id)).toEqual([PUSH_TOKEN]);
  });

  it('rejects a missing platform with 422', async () => {
    const { jwt } = await customerWithToken();
    const res = await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty token with 422', async () => {
    const { jwt } = await customerWithToken();
    const res = await request(app.server)
      .post('/me/devices')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: '', platform: 'ios' });
    expect(res.status).toBe(422);
  });
});

describe('POST /me/devices/revoke', () => {
  it('revokes a token the caller holds', async () => {
    const { id, jwt } = await customerWithToken();
    await devices.register(id, PUSH_TOKEN, 'ios');

    const res = await request(app.server)
      .post('/me/devices/revoke')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN });

    expect(res.status).toBe(200);
    expect(await devices.listActiveFor(id)).toEqual([]);
  });

  // Deliberately not a silent success: a client revoking a token it does not
  // hold has a bookkeeping bug worth surfacing, and nothing leaks because the
  // caller already presented the token.
  it('answers 404 for a token the caller does not hold', async () => {
    const other = await customerWithToken();
    await devices.register(other.id, PUSH_TOKEN, 'ios');
    const { jwt } = await customerWithToken();

    const res = await request(app.server)
      .post('/me/devices/revoke')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ token: PUSH_TOKEN });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEVICE_NOT_FOUND');
    expect(await devices.listActiveFor(other.id)).toEqual([PUSH_TOKEN]);
  });
});
