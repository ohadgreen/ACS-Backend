import 'reflect-metadata';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';
import { users } from '../infra/db/schema';
import * as schema from '../infra/db/schema';
import { PasswordService } from '../common/crypto/password.service';
import { normalizeEmail } from '../modules/users/users.repository';

/**
 * Admins are provisioned out of band only — never through an HTTP route.
 *
 * Usage: pnpm seed:admin admin@example.com 'a-long-password' 'Admin Name'
 */
async function main() {
  const [email, password, displayName] = process.argv.slice(2);
  if (!email || !password || !displayName) {
    throw new Error("Usage: pnpm seed:admin <email> <password> '<display name>'");
  }
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  try {
    await db.insert(users).values({
      id: uuidv7(),
      role: 'admin',
      email: normalizeEmail(email),
      displayName,
      passwordHash: await new PasswordService().hash(password),
      status: 'active',
    });
    console.log(`Created admin ${normalizeEmail(email)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
