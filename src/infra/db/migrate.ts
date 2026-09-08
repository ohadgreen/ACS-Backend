import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';

/**
 * Extensions are infrastructure rather than schema, and drizzle-kit does not
 * emit them. Creating postgis here — idempotently, before migrate() — keeps
 * drizzle/meta entirely generator-owned, so a hand-written migration never has
 * to be reconciled with a generated snapshot.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const db = drizzle(pool);
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis`);
    await migrate(db, { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}
