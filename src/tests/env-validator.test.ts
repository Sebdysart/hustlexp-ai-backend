/**
 * envValidator Unit Tests (TDD — RED phase)
 *
 * Tests for:
 *   validateEnv   — scans process.env and returns { valid, errors, warnings }
 *   logEnvStatus  — logs the result without throwing
 */
import { describe, it, expect } from 'vitest';

describe('validateEnv', () => {
  it('returns an object with valid (boolean), errors (array), and warnings (array)', async () => {
    const { validateEnv } = await import('../utils/envValidator.js');
    const result = validateEnv();

    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('produces at least one warning or error when DATABASE_URL is absent', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const { validateEnv } = await import('../utils/envValidator.js');
    const result = validateEnv();

    expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);

    if (original !== undefined) process.env.DATABASE_URL = original;
  });

  it('errors is empty and valid=true when all critical vars are set', async () => {
    // Temporarily inject the minimum required set.
    // Force NODE_ENV=test so the production-only ALLOWED_ORIGINS warning doesn't fire.
    const saved: Record<string, string | undefined> = {};
    const required = {
      DATABASE_URL: 'postgres://localhost/test',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
      NODE_ENV: 'test',
    };
    for (const [k, v] of Object.entries(required)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    const { validateEnv } = await import('../utils/envValidator.js');
    const result = validateEnv();

    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);

    // Restore
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});

describe('logEnvStatus', () => {
  it('does not throw when called with a passing result', async () => {
    const { validateEnv, logEnvStatus } = await import('../utils/envValidator.js');
    const result = validateEnv();
    expect(() => logEnvStatus(result)).not.toThrow();
  });

  it('does not throw when called with errors and warnings', async () => {
    const { logEnvStatus } = await import('../utils/envValidator.js');
    const failResult = {
      valid: false,
      errors: ['DATABASE_URL is required'],
      warnings: ['OPENAI_API_KEY not set — AI features disabled'],
    };
    expect(() => logEnvStatus(failResult)).not.toThrow();
  });

  it('logs info when result is valid (covers valid=true branch)', async () => {
    const { logEnvStatus } = await import('../utils/envValidator.js');
    const passResult = {
      valid: true,
      errors: [],
      warnings: ['some warning'],
    };
    expect(() => logEnvStatus(passResult)).not.toThrow();
  });
});

describe('validateEnv — production-specific branches', () => {
  it('warns when ALLOWED_ORIGINS is not set in production', async () => {
    const saved: Record<string, string | undefined> = {};
    const vars: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    };
    // Save and set
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v !== undefined) process.env[k] = v;
    }
    // Ensure ALLOWED_ORIGINS is unset
    saved['ALLOWED_ORIGINS'] = process.env['ALLOWED_ORIGINS'];
    delete process.env['ALLOWED_ORIGINS'];

    const { validateEnv } = await import('../utils/envValidator.js');
    const result = validateEnv();

    expect(result.warnings.some((w: string) => w.includes('ALLOWED_ORIGINS') && w.includes('production'))).toBe(true);

    // Restore
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('warns when AI_DEGRADED_MODE=true in production', async () => {
    const saved: Record<string, string | undefined> = {};
    const vars: Record<string, string> = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/test',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
      ALLOWED_ORIGINS: 'https://hustlexp.com',
      AI_DEGRADED_MODE: 'true',
    };
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    const { validateEnv } = await import('../utils/envValidator.js');
    const result = validateEnv();

    expect(result.warnings.some((w: string) => w.includes('AI_DEGRADED_MODE'))).toBe(true);

    // Restore
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
