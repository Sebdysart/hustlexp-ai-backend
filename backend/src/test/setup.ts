import { vi, beforeAll, afterAll, afterEach } from 'vitest';

const originalEnv = process.env;
const originalConsoleError = console.error;
let consoleErrorCalls: unknown[][] = [];

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
    JWT_SECRET: 'test-jwt-secret',
    CORS_ORIGINS: 'http://localhost:3000',
  };

  assertTestEnv();

  consoleErrorCalls = [];
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv;
  console.error = originalConsoleError;

  if (consoleErrorCalls.length > 0) {
    const originalError = originalConsoleError;
    originalError('\n=== Console.error calls captured during tests ===');
    consoleErrorCalls.forEach((call, index) => {
      originalError(`[${index + 1}]`, ...call);
    });
    originalError('===============================================\n');
  }
});
