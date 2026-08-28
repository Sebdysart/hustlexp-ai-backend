import { stripeWalletProvider } from './HustlerWalletProvider.js';
import { getHustlerWalletOverview } from './HustlerWalletOverviewService.js';
import { reviewHustlerCashOut } from './HustlerCashOutReviewService.js';
import {
  requestHustlerCashOut,
  syncHustlerProviderPayoutEvent,
} from './HustlerCashOutRequestService.js';

export { HUSTLER_WALLET_POLICY_VERSION } from './HustlerWalletPolicy.js';

export const HustlerWalletService = {
  getOverview: (
    workerId: string,
    provider = stripeWalletProvider,
  ) => getHustlerWalletOverview(workerId, provider),

  reviewCashOut: (
    workerId: string,
    amountCents: number,
    provider = stripeWalletProvider,
  ) => reviewHustlerCashOut(workerId, amountCents, provider),

  requestCashOut: (
    input: { workerId: string; amountCents: number; idempotencyKey: string },
    provider = stripeWalletProvider,
  ) => requestHustlerCashOut(input, provider),

  syncProviderPayoutEvent: syncHustlerProviderPayoutEvent,
};

export type {
  CashOutRecord,
  CashOutReview,
  HustlerWalletOverview,
  ProviderPayoutEventInput,
  WalletProvider,
} from './HustlerWalletTypes.js';
