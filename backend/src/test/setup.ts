import { vi, beforeAll, afterAll, afterEach } from 'vitest';

const originalEnv = process.env;
const originalConsoleError = console.error;
let consoleErrorCallCount = 0;

export function assertTestEnv(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`Expected NODE_ENV to be 'test', but got '${process.env.NODE_ENV}'`);
  }
}

beforeAll(() => {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'test-key',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_test',
    JWT_SECRET: 'test-jwt-secret',
    CORS_ORIGINS: 'http://localhost:3000',
  };

  assertTestEnv();

  consoleErrorCallCount = 0;
  console.error = () => {
    consoleErrorCallCount += 1;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv;
  console.error = originalConsoleError;

  if (consoleErrorCallCount > 0) {
    originalConsoleError(
      `\n${consoleErrorCallCount} console.error call(s) were captured during tests; arguments withheld to prevent credential disclosure.\n`,
    );
  }
});
