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
        // Coverage gate ramp-up plan:
        // Phase 1 (now):   2% baseline — enforce no regression
        // Phase 2 (Sprint): 10% — after money-path integration tests
        // Phase 3 (GA):     40% — after router + service coverage
        // Phase 4 (Mature): 70% — production target
        lines: 2,
        functions: 1,
        branches: 1,
        statements: 2,
      },
    },
  },
});
