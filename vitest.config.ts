import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
    pool: 'forks',
    // Kept low on purpose: the maintainer's laptop has 8 GB. CI can raise it.
    maxWorkers: process.env.CI ? '50%' : 2,
    testTimeout: 30_000,
  },
});
