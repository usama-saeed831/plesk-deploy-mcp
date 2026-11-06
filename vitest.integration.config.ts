import { defineConfig } from 'vitest/config';

// CI only (PLESK_IT_SSHD=1): needs Docker, and writes ~/.ssh/config on the runner.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/setup/build.ts'],
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
