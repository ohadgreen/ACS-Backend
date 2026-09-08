import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import * as schema from '../../src/infra/db/schema';

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;
let redis: Redis | undefined;

export const ADMIN_DATABASE_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://acs:acs@localhost:5432/postgres';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://acs:acs@localhost:5432/acs_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

export function getTestDb() {
  if (!db) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    db = drizzle(pool, { schema });
  }
  return db;
}

export function getTestRedis() {
  redis ??= new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  return redis;
}

/**
 * Truncates every application table, leaving drizzle's migration bookkeeping
 * intact. CASCADE makes foreign-key order irrelevant, so tests never have to
 * know the dependency graph.
 */
export async function truncateAll() {
  const database = getTestDb();
  const result = await database.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '__drizzle%'
      AND tablename NOT IN ('spatial_ref_sys', 'geography_columns', 'geometry_columns')
  `);
  const tables = result.rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length === 0) return;
  await database.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`));
}

export async function closeTestConnections() {
  await pool?.end();
  await redis?.quit();
  pool = undefined;
  db = undefined;
  redis = undefined;
}
