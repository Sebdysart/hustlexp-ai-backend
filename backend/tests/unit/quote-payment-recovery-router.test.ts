import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoverOrphanQuotePayment = vi.hoisted(() => vi.fn());

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/services/QuotePaymentRecoveryService.js', () => ({
  recoverOrphanQuotePayment,
}));

vi.mock('../../src/services/QuotePaymentFinalizationService.js', () => ({
  finalizePaidQuote: vi.fn(),
}));

vi.mock('../../src/services/payment/StripeQuotePaymentProvider.js', () => ({
  StripeQuotePaymentProvider: { createPaymentIntent: vi.fn() },
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: { confirmTestPaymentIntent: vi.fn() },
}));

const { quotePaymentRouter } = await import('../../src/routers/quotePayment.js');

const input = {
  quoteId: '10000000-0000-4000-8000-000000000001',
  quoteVersionId: '10000000-0000-4000-8000-000000000002',
  paymentIntentId: 'pi_orphan_quote_payment_123',
};

function caller(defaultMode = 'poster') {
  return quotePaymentRouter.createCaller({
    user: {
      id: '10000000-0000-4000-8000-000000000003',
      default_mode: defaultMode,
    } as never,
    firebaseUid: 'firebase-user',
  });
}

beforeEach(() => vi.clearAllMocks());

describe('quote payment recovery router', () => {
  it('binds the authenticated Poster and returns only normalized recovery state', async () => {
    recoverOrphanQuotePayment.mockResolvedValueOnce({
      success: true,
      data: {
        ...input,
        status: 'FAILED',
        recoveryAction: 'VOIDED',
        replayed: false,
      },
    });

    const result = await caller().recoverOrphanPayment(input);

    expect(recoverOrphanQuotePayment).toHaveBeenCalledWith({
      ...input,
      posterId: '10000000-0000-4000-8000-000000000003',
      reasonCode: 'POSTER_REQUESTED_CANCELLATION',
    });
    expect(result).not.toHaveProperty('providerStatus');
    expect(result).not.toHaveProperty('providerOperationId');
  });

  it('rejects non-Poster callers before recovery work', async () => {
    await expect(caller('worker').recoverOrphanPayment(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
  });

  it('rejects browser-supplied reason authority at the request boundary', async () => {
    await expect(caller().recoverOrphanPayment({
      ...input,
      reasonCode: 'UNDERWRITING_CONTAINMENT',
    } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
  });
});
