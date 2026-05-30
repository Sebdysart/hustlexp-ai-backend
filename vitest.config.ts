import { defineConfig } from 'vitest/config';

// NOTE: This config is kept for backward compatibility with direct `vitest run`
// invocations. The primary test configuration is in vitest.workspace.ts which
// defines separate projects for unit (parallel), integration (sequential),
// and system/invariant (sequential) tests.
//
// Use `vitest run` — Vitest auto-detects vitest.workspace.ts when present.

export default defineConfig({
  test: {
    bail: 0,
    environment: 'node',
    testTimeout: 30000,
    include: ['backend/tests/**/*.test.ts'],
    reporters: ['verbose'],
    // NOTE: fileParallelism is now managed per-project in vitest.workspace.ts.
    // Unit tests run in parallel; integration/system tests run sequentially.
    // This fallback config retains sequential mode for safety.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['backend/src/**/*.ts'],
      exclude: [
        'backend/src/**/*.d.ts',
        'backend/src/**/index.ts',
        'backend/src/types.ts',
        'backend/src/jobs/**',
        'backend/src/test/**',
        'backend/src/server.ts',
      ],
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 10,
        statements: 10,
      },
    },
  },
});
