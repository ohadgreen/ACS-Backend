import type { Config } from 'drizzle-kit';

export default {
  schema: './src/infra/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
} satisfies Config;
