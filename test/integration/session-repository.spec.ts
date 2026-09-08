import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { getTestDb } from './db.helper';
import { users } from '../../src/infra/db/schema';
import { SessionRepository } from '../../src/modules/auth/session.repository';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let repo: SessionRepository;
let userId: string;
let phoneCounter = 0;

beforeEach(async () => {
  // The @Inject decorators are metadata only, so direct construction works
  // outside the Nest container.
  repo = new SessionRepository(getTestDb(), REFRESH_TTL_MS);
  userId = uuidv7();
  phoneCounter += 1;
  await getTestDb()
    .insert(users)
    .values({
      id: userId,
      role: 'customer',
      phone: `+9725${String(phoneCounter).padStart(8, '0')}`,
    });
});

describe('SessionRepository', () => {
  it('issues a token whose plaintext is never stored', async () => {
    const { token } = await repo.issue(userId, null, 'iPhone');
    const row = await repo.findByToken(token);
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.userId).toBe(userId);
  });

  it('sets an expiry from the configured TTL', async () => {
    const { token } = await repo.issue(userId, null, null);
    const row = await repo.findByToken(token);
    const ms = row!.expiresAt.getTime() - Date.now();
    expect(ms).toBeGreaterThan(REFRESH_TTL_MS - 60_000);
    expect(ms).toBeLessThanOrEqual(REFRESH_TTL_MS);
  });

  it('starts a new family when none is supplied', async () => {
    const a = await repo.issue(userId, null, null);
    const b = await repo.issue(userId, null, null);
    expect(a.familyId).not.toBe(b.familyId);
  });

  it('rotation marks the old row replaced and keeps the family', async () => {
    const first = await repo.issue(userId, null, null);
    const firstRow = await repo.findByToken(first.token);
    const second = await repo.rotate(firstRow!.id, userId, first.familyId, null);

    const oldRow = await repo.findByToken(first.token);
    const newRow = await repo.findByToken(second.token);

    expect(oldRow?.replacedBy).toBe(newRow?.id);
    expect(newRow?.familyId).toBe(first.familyId);
  });

  it('revokeFamily stamps every member of the family', async () => {
    const first = await repo.issue(userId, null, null);
    const firstRow = await repo.findByToken(first.token);
    const second = await repo.rotate(firstRow!.id, userId, first.familyId, null);

    await repo.revokeFamily(first.familyId);

    expect((await repo.findByToken(first.token))?.revokedAt).not.toBeNull();
    expect((await repo.findByToken(second.token))?.revokedAt).not.toBeNull();
  });

  it('revokeFamily leaves a different family alone', async () => {
    const a = await repo.issue(userId, null, null);
    const b = await repo.issue(userId, null, null);
    await repo.revokeFamily(a.familyId);
    expect((await repo.findByToken(b.token))?.revokedAt).toBeNull();
  });

  it('revokeById stamps only that row', async () => {
    const a = await repo.issue(userId, null, null);
    const b = await repo.issue(userId, null, null);
    const aRow = await repo.findByToken(a.token);

    await repo.revokeById(aRow!.id);

    expect((await repo.findByToken(a.token))?.revokedAt).not.toBeNull();
    expect((await repo.findByToken(b.token))?.revokedAt).toBeNull();
  });

  it('revokeAllForUser stamps every session for that user', async () => {
    const a = await repo.issue(userId, null, null);
    const b = await repo.issue(userId, null, null);
    await repo.revokeAllForUser(userId);
    expect((await repo.findByToken(a.token))?.revokedAt).not.toBeNull();
    expect((await repo.findByToken(b.token))?.revokedAt).not.toBeNull();
  });

  it('does not overwrite an existing revocation timestamp', async () => {
    const { token } = await repo.issue(userId, null, null);
    const row = await repo.findByToken(token);
    await repo.revokeById(row!.id);
    const first = (await repo.findByToken(token))!.revokedAt;

    await repo.revokeAllForUser(userId);
    expect((await repo.findByToken(token))?.revokedAt?.getTime()).toBe(first?.getTime());
  });

  it('returns undefined for an unknown token', async () => {
    expect(await repo.findByToken('never-issued')).toBeUndefined();
  });
});
