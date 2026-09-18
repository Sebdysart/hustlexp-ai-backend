import { newPaymentCreationMode } from './NewPaymentCreationGuard.js';
import { localCertificationPaymentEnabled } from './LocalCertificationPaymentProvider.js';

export interface ProviderOsProduct {
  code: 'provider_os';
  provider: 'local_test';
  amountCents: number;
  currency: 'usd';
  periodDays: number;
  testMode: true;
}
export function providerOsControlledPurchaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.PAYMENT_PROVIDER === 'local_test' &&
    localCertificationPaymentEnabled(env) &&
    env.PROVIDER_OS_TEST_PURCHASE_ENABLED === 'true'
  );
}
/** No production price or live rail. Reuse controlled-test gates and require an explicit test catalog. */
export function providerOsProduct(env: NodeJS.ProcessEnv = process.env): ProviderOsProduct | null {
  if (!providerOsControlledPurchaseEnabled(env) || newPaymentCreationMode(env) !== 'enabled')
    return null;
  const amount = Number(env.PROVIDER_OS_TEST_AMOUNT_CENTS);
  const days = Number(env.PROVIDER_OS_TEST_PERIOD_DAYS);
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > 99999999 ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 366 ||
    env.PROVIDER_OS_TEST_CURRENCY !== 'usd'
  )
    return null;
  return {
    code: 'provider_os',
    provider: 'local_test',
    amountCents: amount,
    currency: 'usd',
    periodDays: days,
    testMode: true,
  };
}
