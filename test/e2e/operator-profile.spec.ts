import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { operators, users } from '../../src/infra/db/schema';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let tokens: TokenService;

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
});
afterAll(async () => {
  await app?.close();
});

async function makeOperator(approval: 'approved' | 'pending' = 'approved') {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({ id: userId, role: 'operator', email: `${operatorId}@example.com`, displayName: 'P' });
  await getTestDb()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'Pilot', approvalStatus: approval });

  return {
    operatorId,
    auth: `Bearer ${tokens.issueAccessToken({
      sub: userId,
      role: 'operator',
      operatorId,
      jti: uuidv7(),
    })}`,
  };
}

describe('/operators/me', () => {
  it('returns the calling operator only', async () => {
    const me = await makeOperator();
    const other = await makeOperator();

    const res = await request(app.server)
      .get('/operators/me')
      .set('Authorization', me.auth)
      .expect(200);

    expect(res.body.id).toBe(me.operatorId);
    expect(res.body.id).not.toBe(other.operatorId);
  });

  it('never exposes credential material', async () => {
    const me = await makeOperator();
    const res = await request(app.server)
      .get('/operators/me')
      .set('Authorization', me.auth)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('updates only the editable fields', async () => {
    const me = await makeOperator();
    const res = await request(app.server)
      .patch('/operators/me')
      .set('Authorization', me.auth)
      .send({ displayName: 'Ace', bio: 'Ten years flying.', gearTags: ['mavic-3', 'fpv'] })
      .expect(200);

    expect(res.body).toMatchObject({
      displayName: 'Ace',
      bio: 'Ten years flying.',
      gearTags: ['mavic-3', 'fpv'],
    });
  });

  it('ignores an attempt to self-approve', async () => {
    const me = await makeOperator('pending');

    const res = await request(app.server)
      .patch('/operators/me')
      .set('Authorization', me.auth)
      .send({ displayName: 'Sneaky', approvalStatus: 'approved' })
      .expect(200);

    // Approval is an admin act; the DTO strips the field rather than trusting it.
    expect(res.body.approvalStatus).toBe('pending');
    expect(res.body.displayName).toBe('Sneaky');
  });

  it('ignores an attempt to set presence directly', async () => {
    const me = await makeOperator();
    const res = await request(app.server)
      .patch('/operators/me')
      .set('Authorization', me.auth)
      .send({ presence: 'in_session' })
      .expect(200);
    expect(res.body.presence).toBe('offline');
  });

  it('allows clearing the bio', async () => {
    const me = await makeOperator();
    await request(app.server)
      .patch('/operators/me')
      .set('Authorization', me.auth)
      .send({ bio: 'something' })
      .expect(200);
    const res = await request(app.server)
      .patch('/operators/me')
      .set('Authorization', me.auth)
      .send({ bio: null })
      .expect(200);
    expect(res.body.bio).toBeNull();
  });

  it('rejects an empty display name with 422', async () => {
    const me = await makeOperator();
    await request(app.server)
      .patch('/operators/me')
      .set('Authorization', me.auth)
      .send({ displayName: '' })
      .expect(422);
  });

  it('rejects a customer token with 403', async () => {
    const customer = `Bearer ${tokens.issueAccessToken({
      sub: uuidv7(),
      role: 'customer',
      jti: uuidv7(),
    })}`;
    await request(app.server).get('/operators/me').set('Authorization', customer).expect(403);
  });

  it('rejects an anonymous request with 401', async () => {
    await request(app.server).get('/operators/me').expect(401);
  });

  it('serves an unapproved operator their own profile', async () => {
    // Login and profile completion must work while approval is pending.
    const me = await makeOperator('pending');
    await request(app.server).get('/operators/me').set('Authorization', me.auth).expect(200);
  });
});
