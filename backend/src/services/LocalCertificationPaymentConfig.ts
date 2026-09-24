/** Shared task/product certification gate; no provider or database dependencies. */
export function localCertificationPaymentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const environmentAllowed = env.NODE_ENV !== 'production' ||
    env.HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION === 'true';
  return environmentAllowed && env.HXOS_ALLOW_LOCAL_TEST_PAYMENT === 'true' &&
    env.ENGINE_API_MODE === 'test' &&
    (env.HXOS_LOCAL_TEST_PAYMENT_SECRET?.trim().length ?? 0) >= 32;
}
