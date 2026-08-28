import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    bail: 0,
    environment: 'node',
    testTimeout: 30000,
    fileParallelism: true,
    reporters: ['verbose'],
    sequence: {
      concurrent: false,
    },
    isolate: true,
  },
});
