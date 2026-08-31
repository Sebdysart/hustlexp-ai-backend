import type { ServiceResult } from '../types.js';
import { PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7 } from '../contracts/PaymentUnderwritingAuthorityV7.js';

export type NewPaymentLane =
  | 'escrow_funding'
  | 'xp_tax'
  | 'tip'
  | 'subscription'
  | 'quote_payment'
  | 'quote_materialization'
  | 'escrow_transfer'
  | 'provider_payout'
  | 'connect_account'
  | 'connect_onboarding'
  | 'connect_login_link'
  | 'connect_payout_settings';
export type NewPaymentCreationMode = 'enabled' | 'frozen';
type Environment = Record<string, string | undefined>;
interface PaymentCreationRuntimeBoundary {
  isolatedTestRunner: boolean;
}

export const PAYMENT_CREATION_FROZEN_CODE = 'PAYMENT_CREATION_FROZEN';
export const LEGACY_QUOTE_PAYMENT_TOMBSTONED_CODE = 'LEGACY_QUOTE_PAYMENT_TOMBSTONED';
export const PAYMENT_CREATION_FROZEN_MESSAGE =
  'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.';
export const LEGACY_QUOTE_PAYMENT_TOMBSTONED_MESSAGE =
  'Legacy quote payment creation and pay-first materialization are retired. Use the Universal V1 TaskDraft, eligibility, scope, financial-security, and Work Order lifecycle. No payment was created.';
export const POSITIVE_MONEY_EFFECT_FROZEN_MESSAGE =
  'Real payment creation, settlement, payout, and Connect capability changes are disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No positive money effect was created.';

const TOMBSTONED_QUOTE_LANES = new Set<NewPaymentLane>(['quote_payment', 'quote_materialization']);

const POSITIVE_EFFECT_LANES = new Set<NewPaymentLane>([
  'escrow_transfer',
  'provider_payout',
  'connect_account',
  'connect_onboarding',
  'connect_login_link',
  'connect_payout_settings',
]);

export function paymentCreationFrozenMessage(lane: NewPaymentLane): string {
  if (TOMBSTONED_QUOTE_LANES.has(lane)) {
    return LEGACY_QUOTE_PAYMENT_TOMBSTONED_MESSAGE;
  }
  return POSITIVE_EFFECT_LANES.has(lane)
    ? POSITIVE_MONEY_EFFECT_FROZEN_MESSAGE
    : PAYMENT_CREATION_FROZEN_MESSAGE;
}

export function paymentCreationErrorCause(
  code: string
): { applicationCode: typeof PAYMENT_CREATION_FROZEN_CODE } | undefined {
  return code === PAYMENT_CREATION_FROZEN_CODE || code === LEGACY_QUOTE_PAYMENT_TOMBSTONED_CODE
    ? { applicationCode: PAYMENT_CREATION_FROZEN_CODE }
    : undefined;
}

/**
 * Processor-specific positive-money writes are disabled while the written
 * underwriting decisions remain unresolved. Only the exact controlled local
 * Stripe test cohort may exercise sandbox adapters. Existing cancellation,
 * refund, dispute, transfer-reversal, and payout-recovery paths remain available.
 */
function isIsolatedTestRunner(): boolean {
  const runnerEvidence = [...process.argv, ...process.execArgv].some((argument) =>
    /(?:^|\/)(?:@?vitest|vite-node)(?:\/|\.|$)/.test(argument)
  );
  const stackEvidence = new Error().stack?.includes('/node_modules/@vitest/') === true;
  return (
    process.env.VITEST === 'true' &&
    typeof process.env.VITEST_WORKER_ID === 'string' &&
    (runnerEvidence || stackEvidence)
  );
}

export function newPaymentCreationMode(
  env: Environment = process.env,
  runtime?: PaymentCreationRuntimeBoundary
): NewPaymentCreationMode {
  const configured = env.HX_PAYMENT_CREATION_MODE?.trim().toLowerCase();
  if (configured === 'frozen') return 'frozen';
  const isolatedTestRunner = runtime?.isolatedTestRunner ?? isIsolatedTestRunner();
  const controlledStripeTest =
    isolatedTestRunner &&
    configured === 'enabled' &&
    env.NODE_ENV === 'test' &&
    env.ENGINE_API_MODE === 'test' &&
    env.STRIPE_MODE === 'test' &&
    env.STRIPE_SECRET_KEY?.startsWith('sk_test_') === true;
  return controlledStripeTest ? 'enabled' : 'frozen';
}

export function newPaymentCreationFailure(
  lane: NewPaymentLane,
  env: Environment = process.env
): Extract<ServiceResult<never>, { success: false }> | null {
  const tombstoned = TOMBSTONED_QUOTE_LANES.has(lane);
  if (!tombstoned && newPaymentCreationMode(env) === 'enabled') return null;
  return {
    success: false,
    error: {
      code: tombstoned ? LEGACY_QUOTE_PAYMENT_TOMBSTONED_CODE : PAYMENT_CREATION_FROZEN_CODE,
      message: paymentCreationFrozenMessage(lane),
      details: {
        lane,
        authority: PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7,
        ...(tombstoned ? { disposition: 'TOMBSTONED' } : {}),
      },
    },
  };
}

/**
 * Fail-closed result for a legacy positive-money route that has no certified
 * provider-neutral coordinator. Unlike `newPaymentCreationFailure`, this
 * containment cannot be opened by the controlled adapter test mode.
 */
export function permanentlyContainedPositiveMoneyFailure(
  lane: NewPaymentLane,
  disposition: string
): Extract<ServiceResult<never>, { success: false }> {
  return {
    success: false,
    error: {
      code: PAYMENT_CREATION_FROZEN_CODE,
      message: paymentCreationFrozenMessage(lane),
      details: {
        lane,
        authority: PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7,
        disposition,
      },
    },
  };
}

export function newPaymentCreationHealth(env: Environment = process.env): {
  mode: NewPaymentCreationMode;
  acceptsNewCustomerMoney: boolean;
  permitsRealSettlement: boolean;
  permitsProviderPayouts: boolean;
  permitsConnectProvisioning: boolean;
  authority: typeof PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7;
} {
  const mode = newPaymentCreationMode(env);
  return {
    mode,
    acceptsNewCustomerMoney: mode === 'enabled',
    permitsRealSettlement: mode === 'enabled',
    permitsProviderPayouts: mode === 'enabled',
    permitsConnectProvisioning: mode === 'enabled',
    authority: PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7,
  };
}
