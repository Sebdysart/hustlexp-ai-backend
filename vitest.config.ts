import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    bail: 1,
    environment: 'node',
    testTimeout: 30000,
    include: ['backend/tests/**/*.test.ts'],
    reporters: ['verbose'],
    // Run test files sequentially to avoid database race conditions
    fileParallelism: false,
    // Run tests within a file sequentially
    sequence: {
      concurrent: false,
    },
  },
});
