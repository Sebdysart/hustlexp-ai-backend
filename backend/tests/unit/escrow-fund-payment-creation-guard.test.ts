import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7 } from '../helpers/payment-underwriting-v7.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  logEscrowEvent: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.query,
    transaction: mocks.transaction,
  },
}));

vi.mock('../../src/logger.js', () => ({
  escrowLogger: { error: vi.fn() },
}));

vi.mock('../../src/services/EscrowServiceShared.js', () => ({
  logEscrowEvent: mocks.logEscrowEvent,
}));

const { fundEscrow } = await import('../../src/services/EscrowFundService.js');

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('EscrowFundService production payment-creation boundary', () => {
  it.each([
    {
      name: 'production labels and live credential with an enabled override',
      env: {
        NODE_ENV: 'production',
        ENGINE_API_MODE: 'production',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_hostile',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'production process pointed at test Stripe',
      env: {
        NODE_ENV: 'production',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_hostile_production_process',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'test process pointed at the production engine',
      env: {
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'production',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_hostile_production_engine',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'test labels with a live credential',
      env: {
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_live_hostile_test_labels',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'exact test labels and runner pointed at Railway production storage',
      env: {
        ...CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
        DATABASE_URL: 'postgresql://postgres:production@roundhouse.proxy.rlwy.net:5432/railway',
        HXOS_LOCAL_TEST_DATABASE_NAME: 'railway',
        HXOS_LOCAL_TEST_DATABASE_ROLE: 'postgres',
      },
    },
    {
      name: 'exact test labels and runner pointed at public storage',
      env: {
        ...CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
        DATABASE_URL: 'postgresql://hx_test_unit_guard@db.hustlexp.example:5432/hx_unit_test_guard',
      },
    },
    {
      name: 'exact test labels and runner pointed at a loopback production role',
      env: {
        ...CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
        DATABASE_URL: 'postgresql://hx_runtime@127.0.0.1:5432/hustlexp',
        HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp',
        HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_runtime',
      },
    },
  ])('rejects $name before any database or audit effect', async ({ env }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const result = await fundEscrow({
      escrowId: '10000000-0000-4000-8000-000000000001',
      stripePaymentIntentId: 'pi_hostile_environment',
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'PAYMENT_CREATION_FROZEN',
        details: { lane: 'escrow_funding' },
      },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.logEscrowEvent).not.toHaveBeenCalled();
  });

  it('keeps the acted-upon escrow guard as the first executable statement', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'backend/src/services/EscrowFundService.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /export const fundEscrow\s*=\s*async\s*\([^)]*\):[^{]+=>\s*\{\s*const frozen = newPaymentCreationFailure\('escrow_funding'\);\s*if \(frozen\) return frozen;/,
    );
  });
});
