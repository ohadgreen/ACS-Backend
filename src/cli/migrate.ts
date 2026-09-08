import { runMigrations } from '../infra/db/migrate';

/**
 * Use this rather than `drizzle-kit migrate`: runMigrations() also creates the
 * postgis extension, which drizzle-kit does not emit. On a fresh database,
 * skipping it makes the first geography migration fail.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  await runMigrations(url);
  console.log('Migrations applied.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
