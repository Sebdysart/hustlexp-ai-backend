import { describe, it, expect, afterEach, vi } from 'vitest';

describe('validateEnv', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    // Restore saved env
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'STRIPE_SECRET_KEY', 'JWT_SECRET', 'R2_ACCOUNT_ID', 'STRIPE_WEBHOOK_SECRET']) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    vi.resetModules();
  });

  it('does not throw when all required vars are present', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    process.env.REDIS_URL = 'redis://test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.JWT_SECRET = 'secret';
    process.env.R2_ACCOUNT_ID = 'r2id';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const { validateEnv } = await import('../../src/lib/env-validator');
    expect(() => validateEnv()).not.toThrow();
  });

  it('throws with message containing the missing var name', async () => {
    delete process.env.DATABASE_URL;
    process.env.REDIS_URL = 'redis://test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.JWT_SECRET = 'secret';
    process.env.R2_ACCOUNT_ID = 'r2id';
    const { validateEnv } = await import('../../src/lib/env-validator');
    expect(() => validateEnv()).toThrowError('DATABASE_URL');
  });

  it('throws listing all missing vars when multiple are absent', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.JWT_SECRET = 'secret';
    process.env.R2_ACCOUNT_ID = 'r2id';
    const { validateEnv } = await import('../../src/lib/env-validator');
    expect(() => validateEnv()).toThrowError('REDIS_URL');
  });
});
