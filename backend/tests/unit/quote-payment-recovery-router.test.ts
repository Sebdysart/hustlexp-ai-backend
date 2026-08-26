import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7.js';

const recoverOrphanQuotePayment = vi.hoisted(() => vi.fn());
const dbQuery = vi.hoisted(() => vi.fn());
const dbTransaction = vi.hoisted(() => vi.fn());
const createQuotePaymentIntent = vi.hoisted(() => vi.fn());
const finalizePaidQuote = vi.hoisted(() => vi.fn());

vi.mock('../../src/db.js', () => ({
  db: { query: dbQuery, transaction: dbTransaction },
}));

vi.mock('../../src/services/QuotePaymentRecoveryService.js', () => ({
  recoverOrphanQuotePayment,
}));

vi.mock('../../src/services/QuotePaymentFinalizationService.js', () => ({
  finalizePaidQuote,
}));

vi.mock('../../src/services/payment/StripeQuotePaymentProvider.js', () => ({
  StripeQuotePaymentProvider: { createPaymentIntent: createQuotePaymentIntent },
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

afterEach(() => vi.unstubAllEnvs());

describe('quote payment recovery router', () => {
  it.each([
    {
      name: 'live production with an enabled override',
      env: {
        NODE_ENV: 'production',
        ENGINE_API_MODE: 'production',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_forbidden',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'production process pointed at test Stripe',
      env: {
        NODE_ENV: 'production',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_forbidden_production_process',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'test process pointed at the production engine',
      env: {
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'production',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_forbidden_production_engine',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'test process pointed at live Stripe',
      env: {
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_forbidden_test_process',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'test-mode labels with a live credential',
      env: {
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_live_forbidden_test_labels',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
    {
      name: 'explicitly frozen production',
      env: {
        NODE_ENV: 'production',
        ENGINE_API_MODE: 'production',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_forbidden_frozen',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
    },
  ])('rejects $name before provider or canonical writes', async ({ env }) => {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    await expect(caller().createPaymentIntent({
      quoteId: input.quoteId,
      quoteVersionId: input.quoteVersionId,
    })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { applicationCode: 'PAYMENT_CREATION_FROZEN' },
    });

    expect(createQuotePaymentIntent).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(finalizePaidQuote).not.toHaveBeenCalled();
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a null draft actor link',
      row: {
        draft_poster_id: null,
        lead_user_id: '10000000-0000-4000-8000-000000000003',
      },
    },
    {
      name: 'a null lead actor link',
      row: {
        draft_poster_id: '10000000-0000-4000-8000-000000000003',
        lead_user_id: null,
      },
    },
    {
      name: 'conflicting case-variant email accounts',
      row: {
        draft_poster_id: '20000000-0000-4000-8000-000000000001',
        lead_user_id: '10000000-0000-4000-8000-000000000003',
        poster_email: 'Poster@Example.com',
        lead_email: 'poster@example.com',
      },
    },
  ])('rejects quote creation owned through $name', async ({ row }) => {
    enableControlledStripePaymentTestCohortV7();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_actor_authority');
    dbQuery.mockResolvedValueOnce({
      rows: [{
        quote_id: input.quoteId,
        task_draft_id: '10000000-0000-4000-8000-000000000004',
        active_version_id: input.quoteVersionId,
        quote_status: 'quote_ready',
        quote_environment: 'TEST',
        quote_is_test: true,
        total_cents: 12_500,
        expires_at: new Date(Date.now() + 60_000),
        ...row,
      }],
      rowCount: 1,
    });

    await expect(caller().createPaymentIntent({
      quoteId: input.quoteId,
      quoteVersionId: input.quoteVersionId,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const ownershipSql = String(dbQuery.mock.calls[0]?.[0]);
    expect(ownershipSql).toContain('d.poster_user_id AS draft_poster_id');
    expect(ownershipSql).toContain('l.user_id AS lead_user_id');
    expect(ownershipSql).not.toMatch(/\bemail\b/i);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(createQuotePaymentIntent).not.toHaveBeenCalled();
  });

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

  it('surfaces task-bound reconciliation without entering a router-side provider or write lane', async () => {
    recoverOrphanQuotePayment.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
        message:
          'Task-bound quote payment recovery requires operator reconciliation; automatic processor recovery is disabled.',
      },
    });

    await expect(caller().recoverOrphanPayment(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        'Task-bound quote payment recovery requires operator reconciliation; automatic processor recovery is disabled.',
    });

    expect(recoverOrphanQuotePayment).toHaveBeenCalledWith({
      ...input,
      posterId: '10000000-0000-4000-8000-000000000003',
      reasonCode: 'POSTER_REQUESTED_CANCELLATION',
    });
    expect(createQuotePaymentIntent).not.toHaveBeenCalled();
    expect(finalizePaidQuote).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
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
