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
        // Phase 1 (baseline):  2% — no regression baseline
        // Phase 2 (current):   5% — after encrypted-session, router, E2E tests
        // Phase 3 (Sprint):   15% — after full service-layer coverage
        // Phase 4 (GA):       40% — after router + middleware coverage
        // Phase 5 (Mature):   70% — production target
        lines: 4,
        functions: 3,
        branches: 2,
        statements: 4,
      },
    },
  },
});
