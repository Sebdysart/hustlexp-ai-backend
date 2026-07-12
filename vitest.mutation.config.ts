import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    include: [
      'backend/tests/unit/task-location-service.test.ts',
      'backend/tests/unit/engine-automation-properties.test.ts',
      'backend/tests/unit/pending-payment-cancellation-properties.test.ts',
      'backend/tests/unit/engine-automation-differential.test.ts',
      'backend/tests/unit/automation-lifecycle-service.test.ts',
      'backend/tests/unit/pending-payment-cancellation-service.test.ts',
      'backend/tests/unit/stripe-payment-intent-cancellation-service.test.ts',
      'backend/tests/unit/dispatch-expiry-payment-cancel-worker.test.ts',
    ],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
