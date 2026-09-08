import { beforeEach, describe, expect, it } from 'vitest';
import { getTestRedis } from './db.helper';
import { RateLimiterService } from '../../src/common/rate-limit/rate-limiter.service';

let limiter: RateLimiterService;

beforeEach(async () => {
  await getTestRedis().flushdb();
  limiter = new RateLimiterService(getTestRedis());
});

describe('RateLimiterService', () => {
  it('permits calls up to the limit', async () => {
    await limiter.consume('k', 3, 60);
    await limiter.consume('k', 3, 60);
    await expect(limiter.consume('k', 3, 60)).resolves.toBeUndefined();
  });

  it('throws once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('k', 3, 60);
    await expect(limiter.consume('k', 3, 60)).rejects.toMatchObject({ status: 429 });
  });

  it('reports a positive retryAfterSeconds', async () => {
    for (let i = 0; i < 2; i++) await limiter.consume('k', 2, 60);
    await limiter.consume('k', 2, 60).catch((e: { details: { retryAfterSeconds: number } }) => {
      expect(e.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(e.details.retryAfterSeconds).toBeLessThanOrEqual(60);
    });
  });

  it('tracks distinct keys independently', async () => {
    await limiter.consume('a', 1, 60);
    await expect(limiter.consume('b', 1, 60)).resolves.toBeUndefined();
  });

  it('does not slide the window forward on later calls', async () => {
    await limiter.consume('k', 5, 60);
    const first = await getTestRedis().ttl('rl:k');
    await getTestRedis().expire('rl:k', 10);
    await limiter.consume('k', 5, 60);
    // Re-arming the expiry on every call would make the window unbounded.
    expect(await getTestRedis().ttl('rl:k')).toBeLessThanOrEqual(10);
    expect(first).toBeGreaterThan(10);
  });

  it('reset clears the counter', async () => {
    await limiter.consume('k', 1, 60);
    await limiter.reset('k');
    await expect(limiter.consume('k', 1, 60)).resolves.toBeUndefined();
  });
});
