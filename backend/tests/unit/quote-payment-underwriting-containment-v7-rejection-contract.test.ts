import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  dbTransaction: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.dbQuery,
    transaction: mocks.dbTransaction,
  },
}));

import { finalizePaidQuote } from '../../src/services/QuotePaymentFinalizationService.js';

const input = {
  quoteId: '10000000-0000-4000-8000-000000000001',
  quoteVersionId: '10000000-0000-4000-8000-000000000002',
  posterId: '10000000-0000-4000-8000-000000000003',
  paymentIntentId: 'pi_historical_quote_reference',
};

const tombstone = {
  success: false,
  error: {
    code: 'LEGACY_QUOTE_PAYMENT_TOMBSTONED',
    message:
      'Legacy quote payment creation and pay-first materialization are retired. Use the Universal V1 TaskDraft, eligibility, scope, financial-security, and Work Order lifecycle. No payment was created.',
    details: {
      lane: 'quote_materialization',
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
      disposition: 'TOMBSTONED',
    },
  },
};

describe('quote payment underwriting containment v7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('tombstones every nonmaterialized quote after one read-only replay lookup', async () => {
    const result = await finalizePaidQuote(input);

    expect(result).toEqual(tombstone);
    expect(mocks.dbQuery).toHaveBeenCalledOnce();
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('replays an exact historical materialization without provider or mutation work', async () => {
    mocks.dbQuery.mockResolvedValueOnce({
      rows: [{ task_id: 'task-existing', escrow_id: 'escrow-existing' }],
      rowCount: 1,
    });

    const result = await finalizePaidQuote({
      ...input,
      paymentIntentId: 'pi_existing_materialized',
    });

    expect(result).toEqual({
      success: true,
      data: {
        taskId: 'task-existing',
        escrowId: 'escrow-existing',
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        paymentIntentId: 'pi_existing_materialized',
        replayed: true,
      },
    });
    expect(mocks.dbQuery).toHaveBeenCalledOnce();
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('cannot be revived by the former isolated Stripe test cohort', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ENGINE_API_MODE', 'test');
    vi.stubEnv('STRIPE_MODE', 'test');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_quote_lane_must_stay_tombstoned');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');

    expect(await finalizePaidQuote(input)).toEqual(tombstone);
    expect(mocks.dbQuery).toHaveBeenCalledOnce();
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('holds replay whenever any durable orphan-recovery operation exists', async () => {
    await finalizePaidQuote(input);

    const sql = String(mocks.dbQuery.mock.calls[0]?.[0]);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('quote_payment_recovery_operations');
    expect(sql).toContain('recovery.quote_payment_id = qp.id');
  });
});
