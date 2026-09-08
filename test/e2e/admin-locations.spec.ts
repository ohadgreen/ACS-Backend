import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from '../integration/db.helper';
import { users } from '../../src/infra/db/schema';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';

let app: TestApp;
let adminAuth: string;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

/** The admin row is recreated per test because the global afterEach truncates. */
beforeEach(async () => {
  const adminId = uuidv7();
  await getTestDb()
    .insert(users)
    .values({
      id: adminId,
      role: 'admin',
      email: `loc-admin-${adminId}@example.com`,
      displayName: 'Admin',
    });
  adminAuth = `Bearer ${app.app
    .get(TokenService)
    .issueAccessToken({ sub: adminId, role: 'admin', jti: uuidv7() })}`;
});

const validLocation = (code: string) => ({
  code,
  siteCode: 'hermon',
  siteName: { en: 'Hermon Resort', he: 'אתר החרמון' },
  name: { en: 'Beginner Slope', he: 'מסלול מתחילים' },
  description: { en: 'Gentle gradient.', he: 'שיפוע מתון.' },
  lat: 33.3053,
  lng: 35.7896,
});

describe('admin locations', () => {
  it('creates a location and echoes every locale', async () => {
    const res = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('beginner-slope'))
      .expect(201);

    expect(res.body.name).toEqual({ en: 'Beginner Slope', he: 'מסלול מתחילים' });
    expect(res.body.lat).toBeCloseTo(33.3053, 4);
    expect(res.body.lng).toBeCloseTo(35.7896, 4);
  });

  it('rejects a name missing Hebrew with 422', async () => {
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send({ ...validLocation('missing-he'), name: { en: 'English only' } })
      .expect(422);
  });

  it('rejects out-of-range coordinates with 422', async () => {
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send({ ...validLocation('bad-coords'), lat: 100, lng: 35 })
      .expect(422);
  });

  it('rejects a duplicate code with 409', async () => {
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('dup-code'))
      .expect(201);
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('dup-code'))
      .expect(409);
  });

  it('adds a session type with a price', async () => {
    const loc = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('with-types'))
      .expect(201);

    const res = await request(app.server)
      .post(`/admin/locations/${loc.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send({
        code: 'extreme',
        name: { en: 'Extreme', he: 'אקסטרים' },
        price: '250.00',
        currency: 'ILS',
      })
      .expect(201);

    expect(res.body).toMatchObject({ code: 'extreme', price: '250.00', currency: 'ILS' });
  });

  it('lets two locations reuse the same session-type code', async () => {
    const a = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('reuse-a'))
      .expect(201);
    const b = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('reuse-b'))
      .expect(201);

    const body = { code: 'mild', name: { en: 'Mild', he: 'רגוע' }, price: '100.00' };
    await request(app.server)
      .post(`/admin/locations/${a.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send(body)
      .expect(201);
    await request(app.server)
      .post(`/admin/locations/${b.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send(body)
      .expect(201);
  });

  it('rejects a duplicate session-type code at the same location with 409', async () => {
    const loc = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('dup-type'))
      .expect(201);

    const body = { code: 'mild', name: { en: 'Mild', he: 'רגוע' }, price: '100.00' };
    await request(app.server)
      .post(`/admin/locations/${loc.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send(body)
      .expect(201);
    await request(app.server)
      .post(`/admin/locations/${loc.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send(body)
      .expect(409);
  });

  it('deactivates a location without deleting it', async () => {
    const loc = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('deactivate-me'))
      .expect(201);

    const res = await request(app.server)
      .patch(`/admin/locations/${loc.body.id}`)
      .set('Authorization', adminAuth)
      .send({ isActive: false })
      .expect(200);

    expect(res.body.isActive).toBe(false);
  });

  it('updates a session type price without touching its code', async () => {
    const loc = await request(app.server)
      .post('/admin/locations')
      .set('Authorization', adminAuth)
      .send(validLocation('repriced'))
      .expect(201);

    const type = await request(app.server)
      .post(`/admin/locations/${loc.body.id}/session-types`)
      .set('Authorization', adminAuth)
      .send({ code: 'mild', name: { en: 'Mild', he: 'רגוע' }, price: '100.00' })
      .expect(201);

    const res = await request(app.server)
      .patch(`/admin/session-types/${type.body.id}`)
      .set('Authorization', adminAuth)
      .send({ price: '150.00' })
      .expect(200);

    expect(res.body).toMatchObject({ code: 'mild', price: '150.00' });
  });

  it('returns 404 when patching a location that does not exist', async () => {
    await request(app.server)
      .patch(`/admin/locations/${uuidv7()}`)
      .set('Authorization', adminAuth)
      .send({ isActive: false })
      .expect(404);
  });

  it('rejects a non-admin with 403', async () => {
    const operator = `Bearer ${app.app.get(TokenService).issueAccessToken({
      sub: uuidv7(),
      role: 'operator',
      operatorId: uuidv7(),
      jti: uuidv7(),
    })}`;
    await request(app.server)
      .post('/admin/locations')
      .set('Authorization', operator)
      .send(validLocation('forbidden'))
      .expect(403);
  });
});
