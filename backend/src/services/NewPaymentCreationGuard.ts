import type { ServiceResult } from '../types.js';
import { PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7 } from '../contracts/PaymentUnderwritingAuthorityV7.js';

export type NewPaymentLane =
  | 'escrow_funding'
  | 'xp_tax'
  | 'tip'
  | 'subscription'
  | 'quote_payment'
  | 'quote_materialization';
export type NewPaymentCreationMode = 'enabled' | 'frozen';
type Environment = Record<string, string | undefined>;

export const PAYMENT_CREATION_FROZEN_CODE = 'PAYMENT_CREATION_FROZEN';
export const PAYMENT_CREATION_FROZEN_MESSAGE =
  'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.';

export function paymentCreationErrorCause(
  code: string,
): { applicationCode: typeof PAYMENT_CREATION_FROZEN_CODE } | undefined {
  return code === PAYMENT_CREATION_FROZEN_CODE
    ? { applicationCode: PAYMENT_CREATION_FROZEN_CODE }
    : undefined;
}

/**
 * Processor-specific customer-money writes are disabled while the written
 * underwriting decisions remain unresolved. Only the exact controlled local
 * Stripe test cohort may exercise sandbox adapters. Existing cancellation,
 * refund, dispute, transfer-reversal, and payout-recovery paths remain available.
 */
export function newPaymentCreationMode(
  env: Environment = process.env,
): NewPaymentCreationMode {
  const configured = env.HX_PAYMENT_CREATION_MODE?.trim().toLowerCase();
  if (configured === 'frozen') return 'frozen';
  const controlledStripeTest =
    configured === 'enabled' &&
    env.NODE_ENV === 'test' &&
    env.ENGINE_API_MODE === 'test' &&
    env.STRIPE_MODE === 'test' &&
    env.STRIPE_SECRET_KEY?.startsWith('sk_test_') === true;
  return controlledStripeTest ? 'enabled' : 'frozen';
}

export function newPaymentCreationFailure(
  lane: NewPaymentLane,
  env: Environment = process.env,
): Extract<ServiceResult<never>, { success: false }> | null {
  if (newPaymentCreationMode(env) === 'enabled') return null;
  return {
    success: false,
    error: {
      code: PAYMENT_CREATION_FROZEN_CODE,
      message: PAYMENT_CREATION_FROZEN_MESSAGE,
      details: {
        lane,
        authority: PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7,
      },
    },
  };
}

export function newPaymentCreationHealth(env: Environment = process.env): {
  mode: NewPaymentCreationMode;
  acceptsNewCustomerMoney: boolean;
  authority: typeof PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7;
} {
  const mode = newPaymentCreationMode(env);
  return {
    mode,
    acceptsNewCustomerMoney: mode === 'enabled',
    authority: PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7,
  };
}
