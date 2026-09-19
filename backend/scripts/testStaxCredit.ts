import {
  creditStaxPaymentMethod,
} from '../src/services/payment/StaxClient.js';

const paymentMethodId =
  process.env.STAX_TEST_PAYMENT_METHOD_ID;

if (!paymentMethodId) {
  throw new Error(
    'STAX_TEST_PAYMENT_METHOD_ID is required.',
  );
}

const result =
  await creditStaxPaymentMethod({
    paymentMethodId,
    amountCents: 100,
    idempotencyId:
      `manual-credit-test-${Date.now()}`,
    meta: {
      purpose: 'hustlexp_payout_primitive_test',
      environment: 'sandbox',
    },
  });

console.dir(result, {
  depth: null,
});
