import { defineConfig } from 'vitest/config';

const commonRequiredTestConfig = {
  bail: 0,
  environment: 'node' as const,
  pool: 'forks' as const,
  isolate: true,
  setupFiles: ['./backend/tests/legacy-task-materialization-compatibility.setup.ts'],
  testTimeout: 30_000,
  env: {
    NODE_ENV: 'test',
    // Legacy assignment behavior is executable only inside Vitest. Runtime
    // code independently requires positive isolated-runner evidence.
    HX_HARD_ASSIGNMENT_MODE: 'enabled',
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...commonRequiredTestConfig,
          name: 'isolated',
          include: ['backend/tests/unit/**/*.test.ts', 'backend/tests/integration/**/*.test.ts'],
          fileParallelism: true,
          maxWorkers: 4,
          sequence: {
            concurrent: false,
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          ...commonRequiredTestConfig,
          name: 'database-serial',
          include: ['backend/tests/invariants/**/*.test.ts', 'backend/tests/system/**/*.test.ts'],
          // These files share two prepared PostgreSQL databases and include
          // cross-database journeys. They must never be sharded or overlap.
          fileParallelism: false,
          sequence: {
            concurrent: false,
            groupOrder: 1,
          },
        },
      },
    ],
  },
});
