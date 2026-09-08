import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from '../e2e/app.helper';

let app: TestApp;

beforeAll(async () => {
  // Deliberately the FULL app, not a hand-assembled subset: the global
  // JwtAuthGuard only exists here, and a probe route that forgets @Public()
  // returns 401 to every load balancer. A partial module would not catch that.
  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe('health endpoints', () => {
  it('reports liveness anonymously, with the global auth guard active', async () => {
    const res = await request(app.server).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness anonymously after reaching Postgres and Redis', async () => {
    const res = await request(app.server).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready', db: 'up', redis: 'up' });
  });
});
