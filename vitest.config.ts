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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['backend/src/**/*.ts'],
      exclude: [
        'backend/src/**/*.d.ts',
        'backend/src/**/index.ts',
        'backend/src/types.ts',
        'backend/src/jobs/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
