import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { swcOptions } from './vitest.swc';

export default defineConfig({
  plugins: [swc.vite(swcOptions)],
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['test/integration/setup.ts'],
    // Every suite shares one Postgres database and truncates between tests, so
    // parallel files would clobber each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
