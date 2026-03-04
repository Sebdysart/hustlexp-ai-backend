import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    bail: 0,
    environment: 'node',
    testTimeout: 30000,
    include: ['backend/tests/**/*.test.ts', 'src/**/*.test.ts'],
    reporters: ['verbose'],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
