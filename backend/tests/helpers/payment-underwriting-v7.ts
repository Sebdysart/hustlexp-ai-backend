import { vi } from 'vitest';
import { PAYMENT_TEST_DATABASE_ATTESTATION_V1 } from '../../src/services/NewPaymentCreationGuard.js';

export const CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7 = {
  NODE_ENV: 'test',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_controlled_unit',
  HX_PAYMENT_CREATION_MODE: 'enabled',
  DATABASE_URL: 'postgresql://hx_test_unit_guard@127.0.0.1:5432/hx_unit_test_guard',
  HXOS_LOCAL_TEST_DATABASE_ATTESTATION: PAYMENT_TEST_DATABASE_ATTESTATION_V1,
  HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_unit_test_guard',
  HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_test_unit_guard',
} as const;

export const HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7 = [
  {
    name: 'live production with an enabled override',
    env: {
      NODE_ENV: 'production', ENGINE_API_MODE: 'production', STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden', HX_PAYMENT_CREATION_MODE: 'enabled',
    },
  },
  {
    name: 'production process pointed at test Stripe',
    env: {
      NODE_ENV: 'production', ENGINE_API_MODE: 'test', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_forbidden_production_process',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    },
  },
  {
    name: 'test process pointed at the production engine',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'production', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_forbidden_production_engine',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    },
  },
  {
    name: 'test process pointed at live Stripe',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'test', STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden_test_process',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    },
  },
  {
    name: 'test-mode labels with a live credential',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'test', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_live_forbidden_test_labels',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    },
  },
  {
    name: 'exact test labels pointed at a Railway production database',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'test', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_forbidden_railway_database',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      DATABASE_URL: 'postgresql://postgres:production@roundhouse.proxy.rlwy.net:5432/railway',
      HXOS_LOCAL_TEST_DATABASE_ATTESTATION: PAYMENT_TEST_DATABASE_ATTESTATION_V1,
      HXOS_LOCAL_TEST_DATABASE_NAME: 'railway',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'postgres',
    },
  },
  {
    name: 'exact test labels pointed at a public database host',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'test', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_forbidden_public_database',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      DATABASE_URL: 'postgresql://hx_test_unit_guard@db.hustlexp.example:5432/hx_unit_test_guard',
      HXOS_LOCAL_TEST_DATABASE_ATTESTATION: PAYMENT_TEST_DATABASE_ATTESTATION_V1,
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_unit_test_guard',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_test_unit_guard',
    },
  },
  {
    name: 'exact test labels pointed at a loopback production database and role',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'test', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_forbidden_loopback_production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      DATABASE_URL: 'postgresql://hx_runtime:production@127.0.0.1:5432/hustlexp',
      HXOS_LOCAL_TEST_DATABASE_ATTESTATION: PAYMENT_TEST_DATABASE_ATTESTATION_V1,
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_runtime',
    },
  },
  {
    name: 'exact test labels with ambiguous database-role attestation',
    env: {
      NODE_ENV: 'test', ENGINE_API_MODE: 'test', STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_forbidden_ambiguous_role',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      DATABASE_URL: 'postgresql://hx_test_unit_guard@127.0.0.1:5432/hx_unit_test_guard',
      HXOS_LOCAL_TEST_DATABASE_ATTESTATION: PAYMENT_TEST_DATABASE_ATTESTATION_V1,
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_unit_test_guard',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_test_unit_different',
    },
  },
  {
    name: 'explicitly frozen production',
    env: {
      NODE_ENV: 'production', ENGINE_API_MODE: 'production', STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden_frozen', HX_PAYMENT_CREATION_MODE: 'frozen',
    },
  },
] as const;

export function stubPaymentCreationEnvironmentV7(
  env: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

export function enableControlledStripePaymentTestCohortV7(): void {
  stubPaymentCreationEnvironmentV7(CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7);
}
