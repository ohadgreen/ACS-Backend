import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { swcOptions } from './vitest.swc';

export default defineConfig({
  plugins: [swc.vite(swcOptions)],
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
