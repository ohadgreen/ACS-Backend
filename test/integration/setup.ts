import { afterAll, afterEach, beforeAll } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/infra/db/migrate';
import {
  ADMIN_DATABASE_URL,
  TEST_DATABASE_URL,
  closeTestConnections,
  getTestRedis,
  truncateAll,
} from './db.helper';

beforeAll(async () => {
  // Create the dedicated test database if absent, then migrate it once for the
  // whole run. Individual tests truncate rather than re-migrate, which is what
  // keeps the TDD inner loop fast.
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const name = new URL(TEST_DATABASE_URL).pathname.slice(1);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) {
      // Identifier cannot be parameterised; the name comes from our own config.
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  await runMigrations(TEST_DATABASE_URL);
}, 60_000);

afterEach(async () => {
  await truncateAll();
  // Cooldowns, attempt counters and rate-limit windows all live in Redis, so a
  // leftover key from one test silently changes the next one's behaviour.
  await getTestRedis().flushdb();
});

afterAll(async () => {
  await closeTestConnections();
});
