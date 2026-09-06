import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 10_000,
    // Tests touch the same fs fixtures; serialize for safety.
    fileParallelism: false,
  },
});
