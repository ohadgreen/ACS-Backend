import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { operators, users } from '../../src/infra/db/schema';
import { PasswordService } from '../../src/common/crypto/password.service';
import { createTestApp, type TestApp } from './app.helper';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function seedOperator(opts: {
  email: string;
  password: string;
  userStatus?: 'active' | 'suspended' | 'operator_pending_setup';
  approval?: 'pending' | 'approved' | 'suspended';
}) {
  const userId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({
      id: userId,
      role: 'operator',
      email: opts.email,
      displayName: 'Pilot',
      passwordHash: await new PasswordService().hash(opts.password),
      status: opts.userStatus ?? 'active',
    });
  await getTestDb().insert(operators).values({
    id: uuidv7(),
    userId,
    displayName: 'Pilot',
    approvalStatus: opts.approval ?? 'approved',
  });
  return userId;
}

const PASSWORD = 'correct-horse-battery';

describe('POST /auth/login', () => {
  it('issues an access and refresh token for valid credentials', async () => {
    await seedOperator({ email: 'pilot@example.com', password: PASSWORD });

    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'pilot@example.com', password: PASSWORD })
      .expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is case-insensitive and trims the email', async () => {
    await seedOperator({ email: 'case@example.com', password: PASSWORD });
    await request(app.server)
      .post('/auth/login')
      .send({ email: '  CASE@Example.COM ', password: PASSWORD })
      .expect(200);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    await seedOperator({ email: 'wrong@example.com', password: PASSWORD });
    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'wrong@example.com', password: 'nope' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives the same code for an unknown email — no account enumeration', async () => {
    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'ghost@example.com', password: 'whatever' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a suspended account', async () => {
    await seedOperator({
      email: 'susp@example.com',
      password: PASSWORD,
      userStatus: 'suspended',
    });
    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'susp@example.com', password: PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('refuses an account that has not completed invite setup', async () => {
    const userId = uuidv7();
    await getTestDb().insert(users).values({
      id: userId,
      role: 'operator',
      email: 'presetup@example.com',
      displayName: 'Pilot',
      status: 'operator_pending_setup',
    });
    // No password is set, so this must fail on credentials, not status.
    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'presetup@example.com', password: PASSWORD })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('allows an approval-pending operator to log in — the two gates are independent', async () => {
    await seedOperator({
      email: 'pending@example.com',
      password: PASSWORD,
      approval: 'pending',
    });
    await request(app.server)
      .post('/auth/login')
      .send({ email: 'pending@example.com', password: PASSWORD })
      .expect(200);
  });

  it('embeds role and operatorId in the access token for operators', async () => {
    await seedOperator({ email: 'claims@example.com', password: PASSWORD });
    const res = await request(app.server)
      .post('/auth/login')
      .send({ email: 'claims@example.com', password: PASSWORD })
      .expect(200);

    const payload = JSON.parse(
      Buffer.from(String(res.body.accessToken).split('.')[1]!, 'base64url').toString(),
    ) as { role: string; operatorId?: string; sub: string };
    expect(payload.role).toBe('operator');
    expect(payload.operatorId).toEqual(expect.any(String));
  });

  it('rejects a malformed body with 422', async () => {
    await request(app.server).post('/auth/login').send({ email: 'x' }).expect(422);
  });
});
