import type { PartialStrykerOptions } from '@stryker-mutator/api/core';

const config: PartialStrykerOptions = {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'json'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  // Scope to files changed in this PR (injected via env)
  mutate: (process.env.MUTATE_FILES ?? 'backend/src/**/*.ts')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean),
  thresholds: {
    high: 95,
    low: 92,
    break: 92,   // exit 1 below this — gates the CI job
  },
  testFiles: ['tests-vault/**/*.test.ts', 'backend/tests/new/**/*.test.ts'],
  timeoutMS: 30000,
  concurrency: 4,
  jsonReporter: { fileName: 'stryker-report.json' },
};

export default config;
