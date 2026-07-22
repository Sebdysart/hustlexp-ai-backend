import type { ServiceResult } from '../types.js';

export type NewPaymentLane = 'escrow_funding' | 'xp_tax' | 'tip' | 'subscription';
export type NewPaymentCreationMode = 'enabled' | 'frozen';
type Environment = Record<string, string | undefined>;

export const PAYMENT_CREATION_FROZEN_CODE = 'PAYMENT_CREATION_FROZEN';
export const PAYMENT_CREATION_FROZEN_MESSAGE =
  'New payments are temporarily paused while existing payment records are reconciled. No new charge was created. Try again after Operations clears the payment incident.';

/**
 * New-customer-money writes fail closed in production. Existing cancellation,
 * refund, dispute, transfer-reversal, and payout-recovery paths remain available.
 * Enabling production creation requires one explicit, auditable environment value.
 */
export function newPaymentCreationMode(
  env: Environment = process.env,
): NewPaymentCreationMode {
  const configured = env.HX_PAYMENT_CREATION_MODE?.trim().toLowerCase();
  if (configured === 'frozen') return 'frozen';
  if (configured === 'enabled') return 'enabled';
  return env.NODE_ENV === 'production' ? 'frozen' : 'enabled';
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
      details: { lane },
    },
  };
}
