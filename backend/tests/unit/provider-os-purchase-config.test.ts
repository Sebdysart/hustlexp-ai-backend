import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/db.js', () => ({ db: {} }));
import { providerOsProduct } from '../../src/services/ProviderOsProduct.js';
const testEnv = {
  NODE_ENV: 'test',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  PAYMENT_PROVIDER: 'local_test',
  HXOS_ALLOW_LOCAL_TEST_PAYMENT: 'true',
  HXOS_LOCAL_TEST_PAYMENT_SECRET: 'controlled-product-test-secret-32-characters',
  PROVIDER_OS_TEST_PURCHASE_ENABLED: 'true',
  PROVIDER_OS_TEST_AMOUNT_CENTS: '1234',
  PROVIDER_OS_TEST_PERIOD_DAYS: '30',
  PROVIDER_OS_TEST_CURRENCY: 'usd',
};
describe('Provider OS controlled test catalog', () => {
  it('requires every controlled-test gate and an explicit test price/period', () => {
    expect(providerOsProduct(testEnv)).toMatchObject({
      provider: 'local_test',
      amountCents: 1234,
      periodDays: 30,
      testMode: true,
    });
    for (const key of Object.keys(testEnv).filter((k) => k !== 'NODE_ENV'))
      expect(providerOsProduct({ ...testEnv, [key]: '' })).toBeNull();
  });
  const productionEnv = {
    ...testEnv,
    NODE_ENV: 'production',
    HX_PAYMENT_CREATION_MODE: 'enabled',
    HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION: 'true',
  };
  it('allows production-shaped certification through the existing production override', () => {
    expect(providerOsProduct(productionEnv)).toMatchObject({ provider: 'local_test', testMode: true });
  });
  it.each(['false', undefined, 'TRUE'])('requires the exact existing production override: %s', (override) => {
    expect(providerOsProduct({ ...productionEnv, HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION: override })).toBeNull();
  });
  it.each([
    { PAYMENT_PROVIDER: 'stripe' },
    { HXOS_ALLOW_LOCAL_TEST_PAYMENT: 'false' },
    { ENGINE_API_MODE: 'live' },
    { STRIPE_MODE: 'live' },
    { HXOS_LOCAL_TEST_PAYMENT_SECRET: 'invalid' },
    { PROVIDER_OS_TEST_PURCHASE_ENABLED: 'false' },
    { PROVIDER_OS_TEST_AMOUNT_CENTS: '' },
    { PROVIDER_OS_TEST_CURRENCY: '' },
    { PROVIDER_OS_TEST_PERIOD_DAYS: '' },
    { HX_PAYMENT_CREATION_MODE: 'frozen' },
    { HX_PAYMENT_CREATION_MODE: undefined },
  ])('production override does not bypass another gate: %j', (invalid) => {
    expect(providerOsProduct({ ...productionEnv, ...invalid })).toBeNull();
  });
  it('production override alone is insufficient', () => {
    expect(providerOsProduct({ NODE_ENV: 'production', HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION: 'true' })).toBeNull();
  });
  it('does not require the production override outside production', () => {
    expect(providerOsProduct({ ...testEnv, HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION: 'false' })).not.toBeNull();
  });
  it('respects global payment freeze', () =>
    expect(providerOsProduct({ ...testEnv, HX_PAYMENT_CREATION_MODE: 'frozen' })).toBeNull());
  it.each(['0', '-1', '1.5', 'NaN', '999999999'])('rejects invalid amounts %s', (amount) =>
    expect(providerOsProduct({ ...testEnv, PROVIDER_OS_TEST_AMOUNT_CENTS: amount })).toBeNull()
  );
  it('rejects invalid duration and currency', () => {
    expect(providerOsProduct({ ...testEnv, PROVIDER_OS_TEST_PERIOD_DAYS: '0' })).toBeNull();
    expect(providerOsProduct({ ...testEnv, PROVIDER_OS_TEST_CURRENCY: 'eur' })).toBeNull();
  });
});

it('registers product purchases once after organization entitlement prerequisites',()=> {
  const names=REQUIRED_MIGRATION_FILES.map(m=>m.name as string);
  expect(names.filter(n=>n==='20260921_provider_os_purchases')).toHaveLength(1);
  expect(names.indexOf('20260921_provider_os_purchases')).toBeGreaterThan(names.indexOf('20260918_provider_os_organization_access'));
});
