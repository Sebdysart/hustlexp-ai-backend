import { vi } from 'vitest';

export function enableControlledStripePaymentTestCohortV7(): void {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ENGINE_API_MODE', 'test');
  vi.stubEnv('STRIPE_MODE', 'test');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_controlled_unit');
  vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
}
