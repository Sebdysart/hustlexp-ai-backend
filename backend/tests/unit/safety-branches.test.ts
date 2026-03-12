/**
 * safety.ts branch coverage tests
 *
 * Covers all 19 uncovered branches in src/config/safety.ts:
 * - PAYOUTS_DISABLED killswitch with/without context
 * - Missing/placeholder Stripe key in production
 * - Non-live Stripe key in production
 * - Happy paths (no throws)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('assertPayoutsEnabled', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAYOUTS_DISABLED;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.PAYOUTS_DISABLED = savedEnv.PAYOUTS_DISABLED;
    process.env.STRIPE_SECRET_KEY = savedEnv.STRIPE_SECRET_KEY;
    process.env.NODE_ENV = savedEnv.NODE_ENV;
  });

  async function getAssert() {
    const mod = await import('../../../src/config/safety');
    return mod.assertPayoutsEnabled;
  }

  // ---- PAYOUTS_DISABLED killswitch ----

  it('throws when PAYOUTS_DISABLED=true (no context)', async () => {
    process.env.PAYOUTS_DISABLED = 'true';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).toThrow('PAYOUTS DISABLED');
  });

  it('throws with context appended when PAYOUTS_DISABLED=true', async () => {
    process.env.PAYOUTS_DISABLED = 'true';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled('escrow-release')).toThrow('Context: escrow-release');
  });

  it('does not throw when PAYOUTS_DISABLED is absent', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).not.toThrow();
  });

  it('does not throw when PAYOUTS_DISABLED=false', async () => {
    process.env.PAYOUTS_DISABLED = 'false';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).not.toThrow();
  });

  // ---- Production: missing/placeholder Stripe key ----

  it('throws in production when STRIPE_SECRET_KEY is empty', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = '';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).toThrow('PAYOUTS BLOCKED');
  });

  it('throws in production when STRIPE_SECRET_KEY contains placeholder', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'placeholder_test_key';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).toThrow('PAYOUTS BLOCKED');
  });

  it('includes context in production placeholder error', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'placeholder_test_key';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled('tax-payout')).toThrow('Context: tax-payout');
  });

  it('throws in production when STRIPE_SECRET_KEY is missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.STRIPE_SECRET_KEY;
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).toThrow('missing or contains placeholder');
  });

  // ---- Production: non-live key ----

  it('throws in production when key does not start with sk_live_', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).toThrow('live Stripe key');
  });

  it('includes context in non-live key error', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled('release')).toThrow('Context: release');
  });

  // ---- Production: happy path with live key ----

  it('does not throw in production with sk_live_ key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).not.toThrow();
  });

  // ---- Non-production happy paths ----

  it('does not throw in test environment with any key', async () => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).not.toThrow();
  });

  it('does not throw in development with missing key', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.STRIPE_SECRET_KEY;
    const assertPayoutsEnabled = await getAssert();
    expect(() => assertPayoutsEnabled()).not.toThrow();
  });
});
