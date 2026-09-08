import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../integration/db.helper';
import { operators, users } from '../../src/infra/db/schema';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let tokens: TokenService;
const SETUP_PASSWORD = 'a-good-long-password';

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
});
afterAll(async () => {
  await app?.close();
});

/**
 * The admin row is recreated per test because the global afterEach truncates
 * every table.
 */
async function adminAuth() {
  const adminId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: adminId, role: 'admin', email: `admin-${adminId}@example.com`, displayName: 'Admin' });
  return `Bearer ${tokens.issueAccessToken({ sub: adminId, role: 'admin', jti: uuidv7() })}`;
}

const invite = (auth: string, email: string) =>
  request(app.server)
    .post('/admin/operators')
    .set('Authorization', auth)
    .send({ email, displayName: 'New Pilot', preferredLocale: 'he' });

describe('operator provisioning', () => {
  it('creates the user, the operator profile, and a setup token', async () => {
    const auth = await adminAuth();
    const res = await invite(auth, 'newpilot@example.com').expect(201);

    expect(res.body.operatorId).toEqual(expect.any(String));
    expect(res.body.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [user] = await getTestDb()
      .select()
      .from(users)
      .where(eq(users.email, 'newpilot@example.com'));
    expect(user?.status).toBe('operator_pending_setup');
    expect(user?.passwordHash).toBeNull();
    expect(user?.preferredLocale).toBe('he');

    const [operator] = await getTestDb()
      .select()
      .from(operators)
      .where(eq(operators.id, res.body.operatorId as string));
    expect(operator?.approvalStatus).toBe('pending');
  });

  it('refuses provisioning by a non-admin', async () => {
    const customer = `Bearer ${tokens.issueAccessToken({
      sub: uuidv7(),
      role: 'customer',
      jti: uuidv7(),
    })}`;
    await request(app.server)
      .post('/admin/operators')
      .set('Authorization', customer)
      .send({ email: 'x@example.com', displayName: 'X' })
      .expect(403);
  });

  it('refuses provisioning without a token at all', async () => {
    await request(app.server)
      .post('/admin/operators')
      .send({ email: 'y@example.com', displayName: 'Y' })
      .expect(401);
  });

  it('cannot log in before setup completes', async () => {
    const auth = await adminAuth();
    await invite(auth, 'presetup@example.com').expect(201);
    await request(app.server)
      .post('/auth/login')
      .send({ email: 'presetup@example.com', password: SETUP_PASSWORD })
      .expect(401);
  });

  it('setup sets the password and activates the account', async () => {
    const auth = await adminAuth();
    const created = await invite(auth, 'setup@example.com').expect(201);

    await request(app.server)
      .post(`/auth/setup/${created.body.setupToken}`)
      .send({ password: SETUP_PASSWORD })
      .expect(204);

    const [user] = await getTestDb()
      .select()
      .from(users)
      .where(eq(users.email, 'setup@example.com'));
    expect(user?.status).toBe('active');
    expect(user?.passwordHash).not.toBeNull();
  });

  it('rejects a reused setup token', async () => {
    const auth = await adminAuth();
    const created = await invite(auth, 'reuse@example.com').expect(201);
    await request(app.server)
      .post(`/auth/setup/${created.body.setupToken}`)
      .send({ password: SETUP_PASSWORD })
      .expect(204);

    const res = await request(app.server)
      .post(`/auth/setup/${created.body.setupToken}`)
      .send({ password: 'another-good-password' })
      .expect(401);
    expect(res.body.error.code).toBe('SETUP_TOKEN_INVALID');
  });

  it('rejects an unknown setup token', async () => {
    await request(app.server)
      .post(`/auth/setup/${'z'.repeat(43)}`)
      .send({ password: SETUP_PASSWORD })
      .expect(401);
  });

  it('rejects a too-short password at setup', async () => {
    const auth = await adminAuth();
    const created = await invite(auth, 'shortpw@example.com').expect(201);
    await request(app.server)
      .post(`/auth/setup/${created.body.setupToken}`)
      .send({ password: 'short' })
      .expect(422);
  });

  it('approve flips approval_status and records the approver', async () => {
    const auth = await adminAuth();
    const created = await invite(auth, 'approve@example.com').expect(201);
    await request(app.server)
      .post(`/admin/operators/${created.body.operatorId}/approve`)
      .set('Authorization', auth)
      .expect(204);

    const [op] = await getTestDb()
      .select()
      .from(operators)
      .where(eq(operators.id, created.body.operatorId as string));
    expect(op?.approvalStatus).toBe('approved');
    expect(op?.approvedBy).not.toBeNull();
    expect(op?.approvedAt).not.toBeNull();
  });

  it('approve returns 404 for an unknown operator', async () => {
    const auth = await adminAuth();
    await request(app.server)
      .post(`/admin/operators/${uuidv7()}/approve`)
      .set('Authorization', auth)
      .expect(404);
  });

  it('suspend revokes every refresh token for that operator', async () => {
    const auth = await adminAuth();
    const created = await invite(auth, 'suspend@example.com').expect(201);
    await request(app.server)
      .post(`/auth/setup/${created.body.setupToken}`)
      .send({ password: SETUP_PASSWORD })
      .expect(204);
    await request(app.server)
      .post(`/admin/operators/${created.body.operatorId}/approve`)
      .set('Authorization', auth)
      .expect(204);

    const login = await request(app.server)
      .post('/auth/login')
      .send({ email: 'suspend@example.com', password: SETUP_PASSWORD })
      .expect(200);

    await request(app.server)
      .post(`/admin/operators/${created.body.operatorId}/suspend`)
      .set('Authorization', auth)
      .expect(204);

    // Refresh must fail immediately — this is the revocation path that matters,
    // since the access token stays valid until it expires. The code is
    // REFRESH_TOKEN_INVALID, not REPLAYED: an admin revoking a session is a
    // deliberate act, not a theft signal.
    const refused = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
    expect(refused.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('rejects a duplicate email with 409', async () => {
    const auth = await adminAuth();
    await invite(auth, 'dupe@example.com').expect(201);
    await invite(auth, 'dupe@example.com').expect(409);
  });

  it('lists operators for an admin', async () => {
    const auth = await adminAuth();
    await invite(auth, 'listed@example.com').expect(201);
    const res = await request(app.server)
      .get('/admin/operators')
      .set('Authorization', auth)
      .expect(200);
    expect(res.body).toHaveLength(1);
  });
});
