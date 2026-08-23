import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  dbTransaction: vi.fn(),
  escrowFund: vi.fn(),
  taskCreate: vi.fn(),
  verifySucceededPayment: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.dbQuery,
    transaction: mocks.dbTransaction,
  },
}));

vi.mock('../../src/services/EscrowService.js', () => ({
  EscrowService: { fund: mocks.escrowFund },
}));

vi.mock('../../src/services/TaskCreateService.js', () => ({
  TaskCreateService: { createInTransaction: mocks.taskCreate },
}));

vi.mock('../../src/services/QuoteTaskParamsMapper.js', () => ({
  mapQuoteToCreateTaskParams: vi.fn(),
}));

vi.mock('../../src/services/payment/StripeQuotePaymentProvider.js', () => ({
  StripeQuotePaymentProvider: {
    verifySucceededPayment: mocks.verifySucceededPayment,
  },
}));

import { finalizePaidQuote } from '../../src/services/QuotePaymentFinalizationService.js';

describe('quote payment underwriting containment v7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENGINE_API_MODE', 'production');
    vi.stubEnv('STRIPE_MODE', 'live');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_forbidden');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks legacy captured-payment materialization before DB or provider work', async () => {
    const result = await finalizePaidQuote({
      quoteId: '10000000-0000-4000-8000-000000000001',
      quoteVersionId: '10000000-0000-4000-8000-000000000002',
      posterId: '10000000-0000-4000-8000-000000000003',
      paymentIntentId: 'pi_forbidden_underwriting_v7',
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'PAYMENT_CREATION_FROZEN',
        message:
          'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.',
        details: {
          lane: 'quote_materialization',
          authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
        },
      },
    });
    expect(mocks.dbQuery).not.toHaveBeenCalled();
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
    expect(mocks.verifySucceededPayment).not.toHaveBeenCalled();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
    expect(mocks.escrowFund).not.toHaveBeenCalled();
  });
});
