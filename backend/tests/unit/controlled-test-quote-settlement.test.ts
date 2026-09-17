import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  createIntent: vi.fn(),
  confirmIntent: vi.fn(),
  verifySucceededIntent: vi.fn(),
}));

vi.mock(
  '../../src/services/LocalCertificationPaymentProvider.js',
  () => ({
    localCertificationPaymentEnabled: () => true,
    LocalCertificationPaymentProvider: provider,
  }),
);

import { settleControlledTestQuotePayment } from '../../src/services/ControlledTestQuotePaymentService.js';

describe('controlled-test quote settlement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.PAYMENT_PROVIDER = 'local_test';

    provider.createIntent.mockResolvedValue({
      success: true,
      data: {
        paymentIntentId: 'pi_hxos_test_1234567890abcdef1234567890abcdef',
        clientSecret: 'local-secret',
        amount: 10000,
      },
    });
    provider.confirmIntent.mockResolvedValue({
      success: true,
      data: {
        paymentIntentId: 'pi_hxos_test_1234567890abcdef1234567890abcdef',
        status: 'succeeded',
        idempotencyReplayed: false,
      },
    });
    provider.verifySucceededIntent.mockResolvedValue({
      success: true,
      data: { status: 'succeeded', amountCents: 10000 },
    });
  });

  it('creates, confirms, and verifies the canonical local payment intent', async () => {
    const result = await settleControlledTestQuotePayment({
      taskId: 'task',
      escrowId: 'escrow',
      posterId: 'poster',
      amountCents: 10000,
    });

    expect(result).toMatchObject({
      success: true,
      data: { replayed: false },
    });
    expect(provider.createIntent).toHaveBeenCalledOnce();
    expect(provider.confirmIntent).toHaveBeenCalledOnce();
    expect(provider.verifySucceededIntent).toHaveBeenCalledOnce();
  });

  it('surfaces the provider replay instead of creating a second identity', async () => {
    provider.confirmIntent.mockResolvedValue({
      success: true,
      data: {
        paymentIntentId: 'pi_hxos_test_1234567890abcdef1234567890abcdef',
        status: 'succeeded',
        idempotencyReplayed: true,
      },
    });

    const result = await settleControlledTestQuotePayment({
      taskId: 'task',
      escrowId: 'escrow',
      posterId: 'poster',
      amountCents: 10000,
    });

    expect(result).toMatchObject({
      success: true,
      data: { replayed: true },
    });
  });
});
