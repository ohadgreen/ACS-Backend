import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { swcOptions } from './vitest.swc';

export default defineConfig({
  plugins: [swc.vite(swcOptions)],
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    // Explicit rather than relying on Vitest's implicit default: the config
    // module keys off this to ignore a developer's local .env file.
    env: { NODE_ENV: 'test' },
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
