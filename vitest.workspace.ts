import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      testTimeout: 30000,
      include: ['backend/tests/unit/**/*.test.ts'],
      exclude: [
        'backend/tests/unit/src-layer-services-batch.test.ts',
        'backend/tests/unit/errors-branches.test.ts',
        'backend/tests/unit/safety-branches.test.ts',
        'backend/tests/unit/stripe-money-engine.test.ts',
        'backend/tests/unit/stripe-service-src.test.ts',
        'backend/tests/unit/service-tax-compliance-extra.test.ts',
        'backend/tests/unit/service-feed-query.test.ts',
        'backend/tests/unit/service-capability-profile.test.ts',
        'backend/tests/unit/query-cache-extra.test.ts',
      ],
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
