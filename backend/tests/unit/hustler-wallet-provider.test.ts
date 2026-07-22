import { describe, expect, it, vi } from 'vitest';
import {
  createStripeWalletProvider,
  mapStripePayoutState,
} from '../../src/services/HustlerWalletProvider';

describe('Stripe Hustler wallet provider', () => {
  it('maps provider status without treating pending or transit as bank paid', () => {
    expect(mapStripePayoutState('pending')).toBe('submitted');
    expect(mapStripePayoutState('in_transit')).toBe('provider_processing');
    expect(mapStripePayoutState('paid')).toBe('paid');
    expect(mapStripePayoutState('failed')).toBe('failed');
    expect(mapStripePayoutState('canceled')).toBe('failed');
  });

  it('reads connected-account balances, masked destination and complete payout history', async () => {
    const stripe = {
      accounts: {
        retrieve: vi.fn(async () => ({
          id: 'acct_1', payouts_enabled: true, requirements: { disabled_reason: null },
        })),
        listExternalAccounts: vi.fn(async () => ({
          data: [{
            object: 'bank_account', id: 'ba_1', currency: 'usd',
            default_for_currency: true, last4: '6789', bank_name: 'Field Bank', status: 'verified',
          }],
          has_more: false,
        })),
      },
      balance: {
        retrieve: vi.fn(async () => ({
          available: [{ amount: 9000, currency: 'usd' }, { amount: 20, currency: 'cad' }],
          pending: [{ amount: 1500, currency: 'usd' }],
        })),
      },
      payouts: {
        list: vi.fn(async () => ({
          data: [{
            id: 'po_1', amount: 4000, currency: 'usd', status: 'paid',
            arrival_date: 1784462400, created: 1784376000,
            failure_code: null, failure_message: null,
          }],
          has_more: false,
        })),
        create: vi.fn(),
      },
    };
    const provider = createStripeWalletProvider(stripe as never);

    const result = await provider.getSnapshot('acct_1');

    expect(result).toMatchObject({
      accountId: 'acct_1', payoutsEnabled: true,
      availableCents: 9000, pendingCents: 1500,
      destination: { type: 'bank_account', last4: '6789', label: 'Field Bank', providerId: 'ba_1' },
      payoutHistoryComplete: true,
    });
    expect(result.payouts[0]).toMatchObject({ providerPayoutId: 'po_1', state: 'paid', amountCents: 4000 });
    expect(stripe.balance.retrieve).toHaveBeenCalledWith({}, { stripeAccount: 'acct_1' });
  });

  it('creates a standard payout with reviewed destination, account scope and replay key', async () => {
    const create = vi.fn(async () => ({
      id: 'po_new', status: 'pending', arrival_date: 1784462400,
      failure_code: null, failure_message: null,
    }));
    const provider = createStripeWalletProvider({ payouts: { create } } as never);

    const result = await provider.createStandardPayout({
      accountId: 'acct_1', amountCents: 5000, destinationId: 'ba_1',
      idempotencyKey: 'wallet:worker:key', requestId: 'req-1', workerId: 'worker-1',
    });

    expect(result).toMatchObject({ providerPayoutId: 'po_new', state: 'submitted' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 5000, currency: 'usd', method: 'standard', destination: 'ba_1',
      metadata: expect.objectContaining({
        connect_account_id: 'acct_1', wallet_request_id: 'req-1', worker_id: 'worker-1',
      }),
    }), { stripeAccount: 'acct_1', idempotencyKey: 'wallet:worker:key' });
  });
});
