import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import { locations, locationSessionTypes } from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';

const db = () => getTestDb();

async function insertLocation(overrides: Partial<{ code: string; name: unknown }> = {}) {
  const id = uuidv7();
  await db()
    .insert(locations)
    .values({
      id,
      code: overrides.code ?? `loc-${id.slice(0, 8)}`,
      siteCode: 'hermon',
      siteName: { en: 'Hermon Resort', he: 'אתר החרמון' },
      name: (overrides.name ?? { en: 'Beginner Slope', he: 'מסלול מתחילים' }) as never,
      geog: makePoint(35.7896, 33.3053) as never,
    });
  return id;
}

describe('locations schema', () => {
  it('stores a location with localized names and a geography point', async () => {
    const id = await insertLocation();
    const res = await db().execute<{ lat: number; lng: number }>(sql`
      SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
      FROM locations WHERE id = ${id}
    `);
    expect(Number(res.rows[0]?.lat)).toBeCloseTo(33.3053, 4);
    expect(Number(res.rows[0]?.lng)).toBeCloseTo(35.7896, 4);
  });

  it('rejects a name missing a required locale', async () => {
    await expect(insertLocation({ name: { en: 'Only English' } })).rejects.toThrow();
  });

  it('enforces global code uniqueness', async () => {
    await insertLocation({ code: 'duplicate-code' });
    await expect(insertLocation({ code: 'duplicate-code' })).rejects.toThrow();
  });

  it('finds locations by radius using ST_DWithin', async () => {
    await insertLocation({ code: 'near' });
    const near = await db().execute<{ id: string }>(sql`
      SELECT id FROM locations
      WHERE ST_DWithin(geog, ${makePoint(35.7897, 33.3054)}, 300)
    `);
    const far = await db().execute<{ id: string }>(sql`
      SELECT id FROM locations
      WHERE ST_DWithin(geog, ${makePoint(34.7818, 32.0853)}, 300)
    `);
    expect(near.rows.length).toBeGreaterThan(0);
    expect(far.rows).toHaveLength(0);
  });

  it('scopes session type codes to their location', async () => {
    const a = await insertLocation({ code: 'loc-a' });
    const b = await insertLocation({ code: 'loc-b' });

    const make = (locationId: string) =>
      db().insert(locationSessionTypes).values({
        id: uuidv7(),
        locationId,
        code: 'extreme',
        name: { en: 'Extreme', he: 'אקסטרים' },
        price: '250.00',
      });

    await make(a);
    // The same code at a different location is a different offering entirely.
    await expect(make(b)).resolves.toBeDefined();
    // The same code at the same location is a duplicate.
    await expect(make(a)).rejects.toThrow();
  });

  it('rejects a negative price', async () => {
    const id = await insertLocation({ code: 'price-check' });
    await expect(
      db().insert(locationSessionTypes).values({
        id: uuidv7(),
        locationId: id,
        code: 'bad',
        name: { en: 'Bad', he: 'רע' },
        price: '-1.00',
      }),
    ).rejects.toThrow();
  });
});
