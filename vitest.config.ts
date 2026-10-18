import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false, // Ensures sequential execution so tests do not collide on the DB
    globalSetup: 'tests/integration/global-setup.ts',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000
  }
});
