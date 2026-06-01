import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      testTimeout: 30000,
      include: ['backend/tests/unit/**/*.test.ts'],
      // Unit tests use vi.mock() with no shared infrastructure.
      // Safe to run in parallel across files.
      fileParallelism: true,
      sequence: {
        concurrent: false,
      },
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      testTimeout: 30000,
      include: ['backend/tests/integration/**/*.test.ts'],
      // DB-dependent tests must run sequentially to avoid race conditions.
      fileParallelism: false,
      sequence: {
        concurrent: false,
      },
    },
  },
  {
    test: {
      name: 'system',
      environment: 'node',
      testTimeout: 30000,
      include: [
        'backend/tests/invariants/**/*.test.ts',
        'backend/tests/system/**/*.test.ts',
      ],
      // System/invariant tests are DB-dependent and sequential.
      fileParallelism: false,
      sequence: {
        concurrent: false,
      },
    },
  },
]);
