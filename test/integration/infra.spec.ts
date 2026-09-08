import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, getTestRedis } from './db.helper';

describe('infrastructure', () => {
  it('has the postgis extension installed', async () => {
    const db = getTestDb();
    const rows = await db.execute<{ extname: string }>(
      sql`SELECT extname FROM pg_extension WHERE extname = 'postgis'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('exposes PostGIS distance functions', async () => {
    const db = getTestDb();
    const rows = await db.execute<{ m: number }>(sql`
      SELECT ST_Distance(
        ST_MakePoint(34.7818, 32.0853)::geography,
        ST_MakePoint(34.7818, 32.0863)::geography
      ) AS m
    `);
    expect(Number(rows.rows[0]?.m)).toBeGreaterThan(100);
  });

  it('reaches redis', async () => {
    const redis = getTestRedis();
    await redis.set('probe', 'pong');
    expect(await redis.get('probe')).toBe('pong');
  });
});
