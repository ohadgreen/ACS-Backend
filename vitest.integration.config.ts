import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { swcOptions } from './vitest.swc';

/**
 * These must be set here rather than inside a test helper: ConfigModule.forRoot()
 * validates the environment when the module file is first imported, which
 * happens while the test file's imports are hoisted — before any beforeAll runs.
 *
 * Each falls back to a local docker-compose default, so CI can redirect the
 * suite by setting TEST_DATABASE_URL / TEST_REDIS_URL.
 */
const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://acs:acs@localhost:5432/acs_test',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
  JWT_SECRET: process.env.JWT_SECRET ?? 'test-jwt-secret-at-least-32-characters',
  OTP_SECRET: process.env.OTP_SECRET ?? 'test-otp-secret-at-least-32-characters',
  SMS_PROVIDER: 'fake',
};

export default defineConfig({
  plugins: [swc.vite(swcOptions)],
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    env: testEnv,
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['test/integration/setup.ts'],
    // Every suite shares one Postgres database and truncates between tests, so
    // parallel files would clobber each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
