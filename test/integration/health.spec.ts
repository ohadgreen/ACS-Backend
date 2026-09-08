import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { RedisModule } from '../../src/infra/redis/redis.module';
import { HealthModule } from '../../src/modules/health/health.module';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './db.helper';

let app: INestApplication;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.JWT_SECRET ??= 'x'.repeat(32);
  process.env.OTP_SECRET ??= 'y'.repeat(32);
  process.env.SMS_PROVIDER = 'fake';

  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, DrizzleModule, RedisModule, HealthModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('health endpoints', () => {
  it('reports liveness without touching any dependency', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness only after reaching Postgres and Redis', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready', db: 'up', redis: 'up' });
  });
});
