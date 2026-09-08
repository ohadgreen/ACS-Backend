import { describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import { operators, users } from '../../src/infra/db/schema';

const db = () => getTestDb();

/**
 * Drizzle wraps the driver error, so the violated constraint name lives on
 * error.cause.constraint rather than in the message. Asserting the name is
 * stronger than a substring match: it proves WHICH rule fired.
 */
async function violatedConstraint(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as { cause?: { constraint?: string } }).cause?.constraint;
  }
}

describe('identity schema', () => {
  it('accepts a customer identified only by phone', async () => {
    const [row] = await db()
      .insert(users)
      .values({ id: uuidv7(), role: 'customer', phone: '+972501234567' })
      .returning();
    expect(row?.status).toBe('active');
    expect(row?.preferredLocale).toBe('he');
    expect(row?.displayName).toBeNull();
  });

  it('rejects a customer carrying an email', async () => {
    const constraint = await violatedConstraint(() =>
      db().insert(users).values({
        id: uuidv7(),
        role: 'customer',
        phone: '+972501234568',
        email: 'nope@example.com',
      }),
    );
    expect(constraint).toBe('customer_identity');
  });

  it('rejects an operator carrying a phone — it would enable OTP login bypass', async () => {
    const constraint = await violatedConstraint(() =>
      db().insert(users).values({
        id: uuidv7(),
        role: 'operator',
        email: 'op@example.com',
        phone: '+972501234569',
        displayName: 'Op',
      }),
    );
    expect(constraint).toBe('staff_identity');
  });

  it('rejects a customer carrying a password hash', async () => {
    const constraint = await violatedConstraint(() =>
      db().insert(users).values({
        id: uuidv7(),
        role: 'customer',
        phone: '+972501234570',
        passwordHash: '$argon2id$whatever',
      }),
    );
    expect(constraint).toBe('customer_identity');
  });

  it('enforces phone uniqueness', async () => {
    await db().insert(users).values({ id: uuidv7(), role: 'customer', phone: '+972500000001' });
    await expect(
      db().insert(users).values({ id: uuidv7(), role: 'customer', phone: '+972500000001' }),
    ).rejects.toThrow();
  });

  it('enforces email uniqueness', async () => {
    await db()
      .insert(users)
      .values({ id: uuidv7(), role: 'admin', email: 'dupe@example.com', displayName: 'A' });
    await expect(
      db()
        .insert(users)
        .values({ id: uuidv7(), role: 'admin', email: 'dupe@example.com', displayName: 'B' }),
    ).rejects.toThrow();
  });

  it('links an operator profile 1:1 with its user', async () => {
    const userId = uuidv7();
    await db().insert(users).values({
      id: userId,
      role: 'operator',
      email: 'pilot@example.com',
      displayName: 'Pilot',
      status: 'operator_pending_setup',
    });
    const [op] = await db()
      .insert(operators)
      .values({ id: uuidv7(), userId, displayName: 'Pilot' })
      .returning();

    expect(op?.approvalStatus).toBe('pending');
    expect(op?.presence).toBe('offline');
    expect(op?.gearTags).toEqual([]);

    await expect(
      db().insert(operators).values({ id: uuidv7(), userId, displayName: 'Dupe' }),
    ).rejects.toThrow();
  });

  it('rejects an unknown enum value for status', async () => {
    await expect(
      db()
        .insert(users)
        .values({
          id: uuidv7(),
          role: 'customer',
          phone: '+972500000002',
          status: 'not_a_status' as never,
        }),
    ).rejects.toThrow();
  });
});
