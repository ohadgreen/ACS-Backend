import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import {
  locations,
  operatorCheckins,
  operatorSlots,
  operators,
  users,
} from '../../src/infra/db/schema';
import { makePoint } from '../../src/infra/db/types';
import { violatedConstraint } from '../../src/infra/db/pg-error';

const db = () => getTestDb();
let operatorA: string;
let operatorB: string;
let locationId: string;
let checkinId: string;

/**
 * Drizzle wraps the driver error, so the violated constraint name lives on the
 * cause chain rather than in the message. Asserting the name proves WHICH rule
 * fired — a plain `toThrow(/grid_aligned/)` would pass on any failure at all.
 */
async function failingConstraint(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return violatedConstraint(err);
  }
}

async function makeOperator(email: string) {
  const userId = uuidv7();
  const operatorId = uuidv7();
  await db().insert(users).values({ id: userId, role: 'operator', email, displayName: 'P' });
  await db()
    .insert(operators)
    .values({ id: operatorId, userId, displayName: 'P', approvalStatus: 'approved' });
  return operatorId;
}

beforeEach(async () => {
  operatorA = await makeOperator(`a-${uuidv7()}@example.com`);
  operatorB = await makeOperator(`b-${uuidv7()}@example.com`);

  locationId = uuidv7();
  await db().insert(locations).values({
    id: locationId,
    code: `loc-${locationId.slice(0, 8)}`,
    siteCode: 'hermon',
    siteName: { en: 'Hermon', he: 'חרמון' },
    name: { en: 'Slope', he: 'מסלול' },
    geog: makePoint(35.7896, 33.3053) as never,
  });

  checkinId = uuidv7();
  await db().insert(operatorCheckins).values({
    id: checkinId,
    operatorId: operatorA,
    locationId,
    availableFrom: new Date('2026-09-06T07:00:00.000Z'),
    availableUntil: new Date('2026-09-06T11:00:00.000Z'),
    checkedInGeog: makePoint(35.7896, 33.3053) as never,
  });
});

const slot = (
  operatorId: string,
  iso: string,
  status: 'open' | 'booked' | 'cancelled' = 'open',
) => ({
  id: uuidv7(),
  operatorId,
  locationId,
  checkinId,
  startAt: new Date(iso),
  status,
});

describe('slot inventory schema', () => {
  it('accepts a grid-aligned slot', async () => {
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z')),
    ).resolves.toBeDefined();
  });

  it('rejects an off-grid start time', async () => {
    expect(
      await failingConstraint(() =>
        db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:07:00.000Z')),
      ),
    ).toBe('grid_aligned');
  });

  it('rejects a start time with non-zero seconds', async () => {
    expect(
      await failingConstraint(() =>
        db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:15:30.000Z')),
      ),
    ).toBe('grid_aligned');
  });

  it('forbids one operator holding two slots at the same tick', async () => {
    await db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z'));
    expect(
      await failingConstraint(() =>
        db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z')),
      ),
    ).toBe('one_session_per_operator_per_tick');
  });

  it('allows two different operators at the same tick — that is capacity 2', async () => {
    await db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z'));
    await expect(
      db().insert(operatorSlots).values(slot(operatorB, '2026-09-06T08:00:00.000Z')),
    ).resolves.toBeDefined();
  });

  it('permits regenerating a tick that was cancelled — the index is partial', async () => {
    await db()
      .insert(operatorSlots)
      .values(slot(operatorA, '2026-09-06T08:00:00.000Z', 'cancelled'));
    // Without WHERE status <> 'cancelled', a check-out would poison this tick
    // permanently and the operator could never check in for it again.
    await expect(
      db().insert(operatorSlots).values(slot(operatorA, '2026-09-06T08:00:00.000Z')),
    ).resolves.toBeDefined();
  });

  it('requires the check-in window to be non-empty', async () => {
    expect(
      await failingConstraint(() =>
        db().insert(operatorCheckins).values({
          id: uuidv7(),
          operatorId: operatorB,
          locationId,
          availableFrom: new Date('2026-09-06T11:00:00.000Z'),
          availableUntil: new Date('2026-09-06T11:00:00.000Z'),
          checkedInGeog: makePoint(35.7896, 33.3053) as never,
        }),
      ),
    ).toBe('operator_checkins_window');
  });

  it('retains the reported check-in position for audit', async () => {
    const res = await db().execute<{ lat: number }>(sql`
      SELECT ST_Y(checked_in_geog::geometry) AS lat FROM operator_checkins WHERE id = ${checkinId}
    `);
    expect(Number(res.rows[0]?.lat)).toBeCloseTo(33.3053, 4);
  });
});
