import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/services/QuotePaymentFinalizationService.js', () => ({ finalizePaidQuote: vi.fn() }));
vi.mock('../../src/services/payment/TilledQuotePaymentProvider.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/services/payment/TilledQuotePaymentProvider.js')>()),
  tilledClient: vi.fn(),
}));

const { db } = await import('../../src/db.js');
const { finalizePaidQuote } = await import('../../src/services/QuotePaymentFinalizationService.js');
const { tilledClient } = await import('../../src/services/payment/TilledQuotePaymentProvider.js');
const { reconcileTilledQuotePayments } = await import('../../src/services/payment/TilledQuoteReconciliationService.js');

const payment = {
  id: 'local-one', quote_id: 'quote-one', quote_version_id: 'version-one',
  task_draft_id: 'draft-one', poster_user_id: 'poster-one',
  business_organization_id: 'org-one', provider_merchant_id: 'acct_one',
  provider_payment_id: 'pi_one', amount_cents: 12000, platform_fee_cents: 2000,
  intent_creation_state: 'BOUND' as const,
};
const intent = {
  id: 'pi_one', account_id: 'acct_one', amount: 12000, amount_received: 12000,
  currency: 'usd', status: 'succeeded', capture_method: 'automatic',
  client_secret: 'browser-secret', platform_fee_amount: 2000,
  metadata: { hustlexp_payment_id: 'local-one', quote_id: 'quote-one',
    quote_version_id: 'version-one', task_draft_id: 'draft-one', organization_id: 'org-one' },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function enableTilled(): void {
  vi.stubEnv('QUOTE_PAYMENT_PROVIDER', 'tilled');
  vi.stubEnv('TILLED_ENV', 'sandbox');
  vi.stubEnv('TILLED_SECRET_KEY', 'test-secret');
  vi.stubEnv('TILLED_PUBLISHABLE_KEY', 'test-public');
}

describe('Tilled quote reconciliation', () => {
  it('does nothing when another quote payment provider is selected', async () => {
    vi.stubEnv('QUOTE_PAYMENT_PROVIDER', 'local_test');
    expect(await reconcileTilledQuotePayments()).toEqual({ scanned: 0, finalized: 0, deferred: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('finalizes a succeeded merchant-bound payment using the canonical service', async () => {
    enableTilled();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [payment] } as never)
      .mockResolvedValueOnce({ rows: [{ id: payment.id }] } as never);
    vi.mocked(tilledClient).mockReturnValue({ getPaymentIntent: vi.fn().mockResolvedValue(intent) } as never);
    vi.mocked(finalizePaidQuote).mockResolvedValue({ success: true, data: { taskId: 'task-one' } } as never);

    expect(await reconcileTilledQuotePayments()).toEqual({ scanned: 1, finalized: 1, deferred: 0 });
    expect(tilledClient().getPaymentIntent).toHaveBeenCalledWith('acct_one', 'pi_one');
    expect(finalizePaidQuote).toHaveBeenCalledWith({
      quoteId: 'quote-one', quoteVersionId: 'version-one', posterId: 'poster-one',
      paymentIntentId: 'pi_one', paymentMode: 'tilled',
    });
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toEqual(['sandbox', 25]);
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).not.toContain('quote.active_version_id');
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).toContain('payment.reserved_poster_id AS poster_user_id');
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).toContain("payment.finalization_state = 'PENDING'");
  });

  it('never finalizes a processing payment', async () => {
    enableTilled();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [payment] } as never)
      .mockResolvedValueOnce({ rows: [{ id: payment.id }] } as never);
    vi.mocked(tilledClient).mockReturnValue({ getPaymentIntent: vi.fn().mockResolvedValue({ ...intent, status: 'processing' }) } as never);
    expect(await reconcileTilledQuotePayments()).toEqual({ scanned: 1, finalized: 0, deferred: 1 });
    expect(finalizePaidQuote).not.toHaveBeenCalled();
  });

  it('rejects a merchant mismatch before binding or finalization', async () => {
    enableTilled();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [payment] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    vi.mocked(tilledClient).mockReturnValue({ getPaymentIntent: vi.fn().mockResolvedValue({ ...intent, account_id: 'acct_other' }) } as never);
    expect(await reconcileTilledQuotePayments()).toEqual({ scanned: 1, finalized: 0, deferred: 1 });
    expect(finalizePaidQuote).not.toHaveBeenCalled();
  });

  it('recovers exactly one previously created intent without creating another', async () => {
    enableTilled();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{
      ...payment, intent_creation_state: 'RECONCILE_REQUIRED',
      provider_payment_id: 'tilled_reservation:quote-one:version-one',
    }] } as never).mockResolvedValueOnce({ rows: [{ id: payment.id }] } as never);
    const findPaymentIntentsByLocalPaymentId = vi.fn().mockResolvedValue([intent]);
    vi.mocked(tilledClient).mockReturnValue({ findPaymentIntentsByLocalPaymentId } as never);
    vi.mocked(finalizePaidQuote).mockResolvedValue({ success: true, data: { taskId: 'task-one' } } as never);
    expect(await reconcileTilledQuotePayments()).toEqual({ scanned: 1, finalized: 1, deferred: 0 });
    expect(findPaymentIntentsByLocalPaymentId).toHaveBeenCalledWith('acct_one', 'local-one');
    expect(finalizePaidQuote).toHaveBeenCalledTimes(1);
  });
});
