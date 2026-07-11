import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    include: [
      'backend/tests/unit/task-location-service.test.ts',
      'backend/tests/unit/engine-automation-properties.test.ts',
      'backend/tests/unit/engine-automation-differential.test.ts',
    ],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
