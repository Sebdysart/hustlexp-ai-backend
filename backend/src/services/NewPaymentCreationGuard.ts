import type { ServiceResult } from '../types.js';
import { PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7 } from '../contracts/PaymentUnderwritingAuthorityV7.js';

export type NewPaymentLane =
  | 'escrow_funding'
  | 'xp_tax'
  | 'tip'
  | 'subscription'
  | 'quote_payment'
  | 'quote_materialization'
  | 'settlement_transfer'
  | 'cash_out_payout'
  | 'processor_account';
export type NewPaymentCreationMode = 'enabled' | 'frozen';
type Environment = Record<string, string | undefined>;
interface PaymentCreationRuntimeBoundary {
  isolatedTestRunner: boolean;
}

const LOOPBACK_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DISPOSABLE_DATABASE_NAME =
  /^hx_(unit|integration|e2e|system|payment|payout)_test(?:_[a-z0-9]+)*$/;
const RESTRICTED_TEST_DATABASE_ROLE =
  /^hx_test_(unit|integration|e2e|system|payment|payout)(?:_[a-z0-9]+)*$/;
const PRODUCTION_LIKE_DATABASE_TOKEN =
  /(?:^|_)(?:admin|migrator|migration|owner|postgres|prod|production|railway|root|runtime|superuser)(?:_|$)/;

export const PAYMENT_CREATION_FROZEN_CODE = 'PAYMENT_CREATION_FROZEN';
export const PAYMENT_TEST_DATABASE_ATTESTATION_V1 =
  'DISPOSABLE_LOOPBACK_RESTRICTED_PAYMENT_TEST_DATABASE_V1';
export const PAYMENT_CREATION_FROZEN_MESSAGE =
  'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.';
export const PAYMENT_DISBURSEMENT_FROZEN_MESSAGE =
  'New transfer and payout creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new disbursement was created.';
export const PAYMENT_PROCESSOR_ACCOUNT_FROZEN_MESSAGE =
  'Processor account creation and mutation are disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No processor account change was made.';

export function paymentCreationErrorCause(
  code: string
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
function isIsolatedTestRunner(): boolean {
  const runnerEvidence = [...process.argv, ...process.execArgv]
    .some((argument) => /(?:^|\/)(?:@?vitest|vite-node)(?:\/|\.|$)/.test(argument));
  const stackEvidence = new Error().stack?.includes('/node_modules/@vitest/') === true;
  return process.env.VITEST === 'true'
    && typeof process.env.VITEST_WORKER_ID === 'string'
    && (runnerEvidence || stackEvidence);
}

/**
 * The controlled test cohort must prove that every canonical write is bound to
 * one explicitly attested, loopback-only disposable database. This check is
 * deliberately synchronous so it dominates processor and database effects.
 */
function hasAttestedDisposableTestDatabase(env: Environment): boolean {
  if (env.HXOS_LOCAL_TEST_DATABASE_ATTESTATION !== PAYMENT_TEST_DATABASE_ATTESTATION_V1) {
    return false;
  }

  try {
    const rawDatabaseUrl = env.DATABASE_URL;
    if (!rawDatabaseUrl || rawDatabaseUrl !== rawDatabaseUrl.trim()) return false;
    const databaseUrl = new URL(rawDatabaseUrl);
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) return false;
    if (!LOOPBACK_DATABASE_HOSTS.has(databaseUrl.hostname)) return false;
    if (databaseUrl.search || databaseUrl.hash) return false;

    const databaseName = databaseUrl.pathname.slice(1);
    const databaseMatch = DISPOSABLE_DATABASE_NAME.exec(databaseName);
    const roleMatch = RESTRICTED_TEST_DATABASE_ROLE.exec(databaseUrl.username);
    if (!databaseMatch || !roleMatch || databaseMatch[1] !== roleMatch[1]) return false;
    if (
      PRODUCTION_LIKE_DATABASE_TOKEN.test(databaseName)
      || PRODUCTION_LIKE_DATABASE_TOKEN.test(databaseUrl.username)
    ) return false;

    return env.HXOS_LOCAL_TEST_DATABASE_NAME === databaseName
      && env.HXOS_LOCAL_TEST_DATABASE_ROLE === databaseUrl.username;
  } catch {
    return false;
  }
}

export function newPaymentCreationMode(
  env: Environment = process.env,
  runtime?: PaymentCreationRuntimeBoundary,
): NewPaymentCreationMode {
  const configured = env.HX_PAYMENT_CREATION_MODE?.trim().toLowerCase();
  if (configured === 'frozen') return 'frozen';
  const isolatedTestRunner = runtime?.isolatedTestRunner
    ?? isIsolatedTestRunner();
  const controlledStripeTest =
    isolatedTestRunner &&
    configured === 'enabled' &&
    env.NODE_ENV === 'test' &&
    env.ENGINE_API_MODE === 'test' &&
    env.STRIPE_MODE === 'test' &&
    env.STRIPE_SECRET_KEY?.startsWith('sk_test_') === true &&
    hasAttestedDisposableTestDatabase(env);
  return controlledStripeTest ? 'enabled' : 'frozen';
}

export function newPaymentCreationFailure(
  lane: NewPaymentLane,
  env: Environment = process.env
): Extract<ServiceResult<never>, { success: false }> | null {
  if (newPaymentCreationMode(env) === 'enabled') return null;
  const message = lane === 'processor_account'
    ? PAYMENT_PROCESSOR_ACCOUNT_FROZEN_MESSAGE
    : lane === 'settlement_transfer' || lane === 'cash_out_payout'
    ? PAYMENT_DISBURSEMENT_FROZEN_MESSAGE
    : PAYMENT_CREATION_FROZEN_MESSAGE;
  return {
    success: false,
    error: {
      code: PAYMENT_CREATION_FROZEN_CODE,
      message,
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
