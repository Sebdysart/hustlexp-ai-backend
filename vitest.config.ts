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
      // json-summary → coverage/coverage-summary.json (read by omni-link scanner)
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['backend/src/**/*.ts'],
      exclude: [
        'backend/src/**/*.d.ts',
        'backend/src/**/index.ts',
        'backend/src/types.ts',
        'backend/src/jobs/**',
        'backend/src/test/**',       // Test helpers/factories — not source code
        'backend/src/server.ts',     // HTTP server entry point — integration-only
      ],
      thresholds: {
        // Coverage gate ramp-up plan:
        // Phase 1 (baseline):  2% — no regression baseline
        // Phase 2 (prev):      4% — after encrypted-session, router, E2E tests
        // Phase 3 (prev):      7% — after 8 service/middleware unit test suites
        // Phase 3b (prev):     6% — after SSRF/BIPA/AI-schema security hardening (new src files expanded denominator)
        // Phase 3c (prev):     8% — after production build plan + 5 gap fixes
        // Phase 4 (prev):     12% — after max-tier pipeline + TDAD enforcement (backend/src only)
        // Phase 4b (current): 10% — denominator expanded to include src/**/*.ts layer (13,924 lines total)
        // Phase 5 (GA):       40% — after router + middleware coverage
        // Phase 6 (Mature):   70% — production target
        lines: 10,
        functions: 10,
        branches: 10,
        statements: 10,
      },
    },
  },
});
