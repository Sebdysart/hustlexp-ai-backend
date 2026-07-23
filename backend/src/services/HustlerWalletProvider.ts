import Stripe from 'stripe';
import { config } from '../config.js';
import type {
  MaskedPayoutDestination,
  ProviderBankPayout,
  ProviderReportedPayoutState,
  WalletProvider,
  WalletProviderPayoutResult,
  WalletProviderSnapshot,
} from './HustlerWalletTypes.js';

const MAX_PAYOUT_PAGES = 20;
const PAYOUT_PAGE_SIZE = 100;

function centsForCurrency(
  amounts: Array<{ amount: number; currency: string }> | null | undefined,
  currency: string,
): number {
  return (amounts ?? [])
    .filter((entry) => entry.currency.toLowerCase() === currency)
    .reduce((total, entry) => total + entry.amount, 0);
}

export function mapStripePayoutState(status: Stripe.Payout['status']): ProviderReportedPayoutState {
  if (status === 'paid') return 'paid';
  if (status === 'in_transit') return 'provider_processing';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return 'submitted';
}

function isoFromSeconds(value: number | null | undefined): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

function payoutSummary(payout: Stripe.Payout): ProviderBankPayout | null {
  if (payout.currency.toLowerCase() !== 'usd') return null;
  return {
    providerPayoutId: payout.id,
    amountCents: payout.amount,
    currency: 'usd',
    state: mapStripePayoutState(payout.status),
    estimatedArrivalAt: isoFromSeconds(payout.arrival_date),
    createdAt: new Date(payout.created * 1000).toISOString(),
    failureCode: payout.failure_code ?? null,
    failureMessage: payout.failure_message ?? null,
  };
}

function bankDestination(account: Stripe.BankAccount): MaskedPayoutDestination {
  return {
    type: 'bank_account',
    last4: account.last4,
    label: account.bank_name || 'Bank account',
    providerId: account.id,
    status: account.status ?? null,
  };
}

function cardDestination(card: Stripe.Card): MaskedPayoutDestination {
  return {
    type: 'debit_card',
    last4: card.last4,
    label: card.brand || 'Debit card',
    providerId: card.id,
    status: null,
  };
}

function selectDestination(accounts: Stripe.ApiList<Stripe.ExternalAccount>): MaskedPayoutDestination | null {
  const bank = accounts.data.find((item): item is Stripe.BankAccount => (
    item.object === 'bank_account'
    && item.currency?.toLowerCase() === 'usd'
    && item.default_for_currency === true
  ));
  if (bank) return bankDestination(bank);
  const card = accounts.data.find((item): item is Stripe.Card => item.object === 'card');
  return card ? cardDestination(card) : null;
}

async function listPayouts(
  stripe: Stripe,
  accountId: string,
): Promise<{ payouts: ProviderBankPayout[]; complete: boolean }> {
  const payouts: ProviderBankPayout[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAYOUT_PAGES; page += 1) {
    const response = await stripe.payouts.list(
      { limit: PAYOUT_PAGE_SIZE, starting_after: startingAfter },
      { stripeAccount: accountId },
    );
    for (const payout of response.data) {
      const summary = payoutSummary(payout);
      if (summary) payouts.push(summary);
    }
    if (!response.has_more) return { payouts, complete: true };
    startingAfter = response.data.at(-1)?.id;
    if (!startingAfter) return { payouts, complete: false };
  }
  return { payouts, complete: false };
}

export function createStripeWalletProvider(client?: Stripe | null): WalletProvider {
  const stripe = client === undefined
    ? (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')
      ? new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' })
      : null)
    : client;

  return {
    isConfigured: () => stripe !== null,

    async getSnapshot(accountId: string): Promise<WalletProviderSnapshot> {
      if (!stripe) throw new Error('STRIPE_NOT_CONFIGURED');
      const [account, balance, externalAccounts, payoutHistory] = await Promise.all([
        stripe.accounts.retrieve(accountId),
        stripe.balance.retrieve({}, { stripeAccount: accountId }),
        stripe.accounts.listExternalAccounts(accountId, { limit: 100 }),
        listPayouts(stripe, accountId),
      ]);
      if (account.deleted) throw new Error('STRIPE_ACCOUNT_DELETED');
      const requirements = account.requirements as Stripe.Account.Requirements | null;
      return {
        accountId,
        payoutsEnabled: account.payouts_enabled,
        disabledReason: requirements?.disabled_reason ?? null,
        availableCents: centsForCurrency(balance.available, 'usd'),
        pendingCents: centsForCurrency(balance.pending, 'usd'),
        destination: selectDestination(externalAccounts),
        payouts: payoutHistory.payouts,
        payoutHistoryComplete: payoutHistory.complete,
        capturedAt: new Date().toISOString(),
      };
    },

    async createStandardPayout(input): Promise<WalletProviderPayoutResult> {
      if (!stripe) throw new Error('STRIPE_NOT_CONFIGURED');
      const payout = await stripe.payouts.create({
        amount: input.amountCents,
        currency: 'usd',
        method: 'standard',
        destination: input.destinationId,
        metadata: {
          connect_account_id: input.accountId,
          wallet_request_id: input.requestId,
          worker_id: input.workerId,
        },
      }, {
        stripeAccount: input.accountId,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        providerPayoutId: payout.id,
        state: mapStripePayoutState(payout.status),
        estimatedArrivalAt: isoFromSeconds(payout.arrival_date),
        failureCode: payout.failure_code ?? null,
        failureMessage: payout.failure_message ?? null,
      };
    },
  };
}

export const stripeWalletProvider = createStripeWalletProvider();
