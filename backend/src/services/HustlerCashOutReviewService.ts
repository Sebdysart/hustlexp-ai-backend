import type { ServiceResult } from '../types.js';
import {
  getProviderSnapshot,
  isActiveCashOutState,
  loadAccount,
  loadCashOutRows,
  publicDestination,
} from './HustlerWalletData.js';
import {
  DEFAULT_WALLET_MINIMUM_CENTS,
  HUSTLER_WALLET_POLICY_VERSION,
  RESTRICTED_WALLET_DESTINATION_STATUSES,
  WALLET_ARRIVAL_ESTIMATE,
} from './HustlerWalletPolicy.js';
import type {
  CashOutReview,
  MaskedPayoutDestination,
  WalletProvider,
  WalletProviderSnapshot,
} from './HustlerWalletTypes.js';

export interface CashOutReviewContext {
  review: CashOutReview;
  accountId: string | null;
  providerDestinationId: string | null;
}

function reviewBase(amountCents: number, minimumCents: number) {
  return {
    amountCents,
    feeCents: 0 as const,
    netCents: amountCents,
    minimumCents,
    method: 'standard' as const,
    arrivalEstimate: {
      label: WALLET_ARRIVAL_ESTIMATE,
      source: 'platform_estimate' as const,
      exact: false as const,
    },
    failureBehavior: 'If the bank rejects the payout, Stripe returns the funds to the connected balance and HustleXP shows a failed state with recovery steps.',
    policyVersion: HUSTLER_WALLET_POLICY_VERSION,
  };
}

function ineligibleReview(input: {
  amountCents: number;
  minimumCents: number;
  code: Exclude<CashOutReview['eligibilityCode'], 'ELIGIBLE'>;
  reason: string;
  availableCents?: number | null;
  destination?: MaskedPayoutDestination | null;
}): CashOutReview {
  return {
    ...reviewBase(input.amountCents, input.minimumCents),
    eligible: false,
    eligibilityCode: input.code,
    reason: input.reason,
    availableCents: input.availableCents ?? null,
    destination: publicDestination(input.destination ?? null),
  };
}

function evaluateReview(input: {
  amountCents: number;
  minimumCents: number;
  snapshot: WalletProviderSnapshot;
  hasActiveCashOut: boolean;
}): CashOutReview {
  const common = {
    amountCents: input.amountCents,
    minimumCents: input.minimumCents,
    availableCents: input.snapshot.availableCents,
    destination: input.snapshot.destination,
  };
  if (!input.snapshot.payoutsEnabled) return ineligibleReview({
    ...common,
    code: 'PAYOUTS_RESTRICTED',
    reason: input.snapshot.disabledReason || 'Stripe has restricted payouts for this account.',
  });
  if (!input.snapshot.destination) return ineligibleReview({
    ...common,
    code: 'DESTINATION_REQUIRED',
    reason: 'Add a bank payout destination in Stripe before cashing out.',
  });
  if (input.snapshot.destination.status
      && RESTRICTED_WALLET_DESTINATION_STATUSES.has(input.snapshot.destination.status)) {
    return ineligibleReview({
      ...common,
      code: 'DESTINATION_RESTRICTED',
      reason: 'The saved payout destination needs attention in Stripe.',
    });
  }
  if (input.hasActiveCashOut) return ineligibleReview({
    ...common,
    code: 'ACTIVE_CASH_OUT',
    reason: 'Wait for the current bank payout to finish before starting another.',
  });
  if (input.amountCents < input.minimumCents) return ineligibleReview({
    ...common,
    code: 'BELOW_MINIMUM',
    reason: `The minimum standard cash-out is ${input.minimumCents} cents.`,
  });
  if (input.amountCents > input.snapshot.availableCents) return ineligibleReview({
    ...common,
    code: 'INSUFFICIENT_AVAILABLE_BALANCE',
    reason: 'The requested amount exceeds the provider-verified available balance.',
  });
  return {
    ...reviewBase(input.amountCents, input.minimumCents),
    eligible: true,
    eligibilityCode: 'ELIGIBLE',
    reason: 'The amount, destination, and connected balance are eligible for a standard bank payout.',
    availableCents: input.snapshot.availableCents,
    destination: publicDestination(input.snapshot.destination),
  };
}

export async function buildCashOutReviewContext(
  workerId: string,
  amountCents: number,
  provider: WalletProvider,
): Promise<CashOutReviewContext> {
  const [account, cashOuts] = await Promise.all([
    loadAccount(workerId),
    loadCashOutRows(workerId),
  ]);
  const minimumCents = account?.minimum_payout_amount_cents ?? DEFAULT_WALLET_MINIMUM_CENTS;
  if (!account?.stripe_connect_id) return {
    review: ineligibleReview({
      amountCents,
      minimumCents,
      code: 'SETUP_REQUIRED',
      reason: 'Complete Stripe payout setup before cashing out.',
    }),
    accountId: null,
    providerDestinationId: null,
  };
  const snapshot = await getProviderSnapshot(account.stripe_connect_id, provider);
  if (!snapshot) return {
    review: ineligibleReview({
      amountCents,
      minimumCents,
      code: 'PROVIDER_UNAVAILABLE',
      reason: 'Stripe balance and destination data are temporarily unavailable.',
    }),
    accountId: account.stripe_connect_id,
    providerDestinationId: null,
  };
  return {
    review: evaluateReview({
      amountCents,
      minimumCents,
      snapshot,
      hasActiveCashOut: cashOuts.some((row) => isActiveCashOutState(row.state)),
    }),
    accountId: account.stripe_connect_id,
    providerDestinationId: snapshot.destination?.providerId ?? null,
  };
}

export async function reviewHustlerCashOut(
  workerId: string,
  amountCents: number,
  provider: WalletProvider,
): Promise<ServiceResult<CashOutReview>> {
  try {
    const context = await buildCashOutReviewContext(workerId, amountCents, provider);
    return { success: true, data: context.review };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'CASH_OUT_REVIEW_FAILED',
        message: error instanceof Error ? error.message : 'Cash-out eligibility could not be reviewed.',
      },
    };
  }
}
