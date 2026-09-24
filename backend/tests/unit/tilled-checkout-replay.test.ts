import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/services/QuotePaymentFinalizationService.js', () => ({ finalizePaidQuote: vi.fn() }));
vi.mock('../../src/services/payment/TilledConfig.js', () => ({ loadTilledConfig: vi.fn() }));
vi.mock('../../src/services/payment/TilledQuotePaymentProvider.js', () => ({
  tilledClient: vi.fn(), TilledQuotePaymentProvider: { createPaymentIntent: vi.fn() },
  validateTilledIntentBinding: vi.fn(),
}));

const { db } = await import('../../src/db.js');
const { finalizePaidQuote } = await import('../../src/services/QuotePaymentFinalizationService.js');
const { loadTilledConfig } = await import('../../src/services/payment/TilledConfig.js');
const { tilledClient } = await import('../../src/services/payment/TilledQuotePaymentProvider.js');
const { createOrResumeTilledCheckout } = await import('../../src/services/payment/TilledQuoteCheckoutService.js');

afterEach(() => vi.clearAllMocks());

describe('finalized Tilled quote replay', () => {
  it('returns the canonical task with no configuration or provider call', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ quote_id: 'quote-one', quote_status: 'paid' }] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: 'payment-one', provider: 'tilled', status: 'SUCCEEDED',
        task_id: 'task-one', intent_creation_state: 'BOUND', provider_payment_id: 'pi_one',
      }] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: 'payment-one', provider: 'tilled', status: 'SUCCEEDED',
        task_id: 'task-one', intent_creation_state: 'BOUND', provider_payment_id: 'pi_one',
      }] } as never);
    vi.mocked(finalizePaidQuote).mockResolvedValue({ success: true, data: {
      taskId: 'task-one', replayed: true,
    } } as never);

    expect(await createOrResumeTilledCheckout({
      quoteId: 'quote-one', quoteVersionId: 'version-one', posterId: 'poster-one',
    })).toEqual({ finalized: true, taskId: 'task-one', replayed: true });
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toEqual(['quote-one', 'version-one', 'poster-one']);
    expect(loadTilledConfig).not.toHaveBeenCalled();
    expect(tilledClient).not.toHaveBeenCalled();
    expect(finalizePaidQuote).toHaveBeenCalledTimes(1);
  });
});
