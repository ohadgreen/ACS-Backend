import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { deviceTokens, users } from '../../src/infra/db/schema';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { getTestDb } from './db.helper';

const db = getTestDb();
const repo = new DevicesRepository(db);

const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

async function makeCustomer(phone: string) {
  const id = uuidv7();
  await db.insert(users).values({ id, role: 'customer', phone, preferredLocale: 'he' });
  return id;
}

let alice: string;
let bob: string;

beforeEach(async () => {
  alice = await makeCustomer('+972500000001');
  bob = await makeCustomer('+972500000002');
});

describe('device token registration', () => {
  it('stores a token and returns it as active', async () => {
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.listActiveFor(alice)).toEqual([TOKEN]);
  });

  it('is idempotent — re-registering touches last_seen_at instead of duplicating', async () => {
    await repo.register(alice, TOKEN, 'ios');
    const [first] = await db.select().from(deviceTokens);
    await repo.register(alice, TOKEN, 'ios');

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
  });

  it('records a platform change on re-registration', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.register(alice, TOKEN, 'android');
    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe('android');
  });

  // The privacy case: one handset, two users. If the old binding survived,
  // Alice's booking notifications would arrive on Bob's phone.
  it('revokes the previous owner when a live token is claimed by another user', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.register(bob, TOKEN, 'ios');

    expect(await repo.listActiveFor(alice)).toEqual([]);
    expect(await repo.listActiveFor(bob)).toEqual([TOKEN]);

    // Revoked, not deleted: the history of who held the device is the only
    // evidence available if a misdelivery is ever reported.
    const all = await db.select().from(deviceTokens);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.revokedAt !== null)).toHaveLength(1);
  });

  it('allows one user to hold several devices', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.register(alice, 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', 'android');
    expect(await repo.listActiveFor(alice)).toHaveLength(2);
  });
});

describe('device token revocation', () => {
  it('revokes a token the caller holds', async () => {
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.revoke(alice, TOKEN)).toBe(true);
    expect(await repo.listActiveFor(alice)).toEqual([]);
  });

  it('reports false for a token the caller does not hold', async () => {
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.revoke(bob, TOKEN)).toBe(false);
    expect(await repo.listActiveFor(alice)).toEqual([TOKEN]);
  });

  it('bulk-revokes dead tokens regardless of owner', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.revokeTokens([TOKEN]);
    const live = await db
      .select()
      .from(deviceTokens)
      .where(and(eq(deviceTokens.token, TOKEN), isNull(deviceTokens.revokedAt)));
    expect(live).toEqual([]);
  });

  it('tolerates an empty bulk revocation', async () => {
    await expect(repo.revokeTokens([])).resolves.toBeUndefined();
  });

  // A revoked token must be re-registerable: uninstall, reinstall, same token.
  it('allows a revoked token to be registered again', async () => {
    await repo.register(alice, TOKEN, 'ios');
    await repo.revokeTokens([TOKEN]);
    await repo.register(alice, TOKEN, 'ios');
    expect(await repo.listActiveFor(alice)).toEqual([TOKEN]);
  });
});
