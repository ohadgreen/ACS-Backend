import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../integration/db.helper';
import { operators, users } from '../../src/infra/db/schema';
import { PasswordService } from '../../src/common/crypto/password.service';
import { createTestApp, type TestApp } from './app.helper';

let app: TestApp;
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function loginFreshOperator(email: string, approval: 'approved' | 'suspended' = 'approved') {
  const userId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({
      id: userId,
      role: 'operator',
      email,
      displayName: 'Pilot',
      passwordHash: await new PasswordService().hash(PASSWORD),
    });
  await getTestDb()
    .insert(operators)
    .values({ id: uuidv7(), userId, displayName: 'Pilot', approvalStatus: approval });

  const res = await request(app.server)
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return { userId, ...(res.body as { accessToken: string; refreshToken: string }) };
}

describe('POST /auth/refresh', () => {
  it('issues a new pair and rotates the refresh token', async () => {
    const session = await loginFreshOperator('rot@example.com');
    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    expect(res.body.refreshToken).not.toBe(session.refreshToken);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: 'a'.repeat(43) })
      .expect(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('detects replay and kills the whole family', async () => {
    const session = await loginFreshOperator('replay@example.com');

    const rotated = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    // Present the already-rotated token: this is the theft signal.
    const replay = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REPLAYED');

    // The successor must now be dead too, not merely the replayed row —
    // otherwise a thief who rotated once keeps a live session.
    await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
  });

  it('refuses to refresh once the user is suspended', async () => {
    const session = await loginFreshOperator('suspend-later@example.com');
    await getTestDb().update(users).set({ status: 'suspended' }).where(eq(users.id, session.userId));

    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('refuses to refresh once the operator loses approval', async () => {
    const session = await loginFreshOperator('unapprove@example.com');
    await getTestDb()
      .update(operators)
      .set({ approvalStatus: 'suspended' })
      .where(eq(operators.userId, session.userId));

    // This is the check that actually enforces "approved operators only" on an
    // ongoing basis; login alone would let them refresh indefinitely.
    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(403);
    expect(res.body.error.code).toBe('OPERATOR_NOT_APPROVED');
  });

  it('logout revokes only the presented token', async () => {
    const session = await loginFreshOperator('logout@example.com');
    await request(app.server)
      .post('/auth/logout')
      .send({ refreshToken: session.refreshToken })
      .expect(204);

    await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
  });

  it('logout is idempotent for an unknown token', async () => {
    await request(app.server)
      .post('/auth/logout')
      .send({ refreshToken: 'b'.repeat(43) })
      .expect(204);
  });

  it('logout-all revokes every session for the user', async () => {
    const a = await loginFreshOperator('logoutall@example.com');
    const b = await request(app.server)
      .post('/auth/login')
      .send({ email: 'logoutall@example.com', password: PASSWORD })
      .expect(200);

    await request(app.server)
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(204);

    await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: a.refreshToken })
      .expect(401);
    await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: b.body.refreshToken })
      .expect(401);
  });

  it('logout-all requires authentication', async () => {
    await request(app.server).post('/auth/logout-all').expect(401);
  });

  it('rotation preserves the family, so one chain does not fork', async () => {
    const session = await loginFreshOperator('chain@example.com');
    let token = session.refreshToken;
    for (let i = 0; i < 3; i++) {
      const res = await request(app.server)
        .post('/auth/refresh')
        .send({ refreshToken: token })
        .expect(200);
      token = res.body.refreshToken as string;
    }
    // Replaying the original still nukes the chain three rotations later.
    await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    await request(app.server).post('/auth/refresh').send({ refreshToken: token }).expect(401);
  });
});
