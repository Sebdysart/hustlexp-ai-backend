import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recoverOrphanQuotePayment = vi.hoisted(() => vi.fn());
const dbQuery = vi.hoisted(() => vi.fn());
const dbTransaction = vi.hoisted(() => vi.fn());
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
    {
      name: 'the former isolated Stripe test cohort',
      env: {
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_tombstoned_quote_lane',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      },
    },
  ])('rejects $name before provider or canonical writes', async ({ env }) => {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    await expect(
      caller().createPaymentIntent({
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { applicationCode: 'PAYMENT_CREATION_FROZEN' },
    });

    expect(dbQuery).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(finalizePaidQuote).not.toHaveBeenCalled();
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
  });

  it('keeps the historical test-confirm route as an environment-independent tombstone', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ENGINE_API_MODE', 'test');
    vi.stubEnv('STRIPE_MODE', 'test');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_tombstoned_quote_confirmation');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');

    await expect(
      caller().confirmTestPayment({
        paymentIntentId: input.paymentIntentId,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { applicationCode: 'PAYMENT_CREATION_FROZEN' },
    });

    expect(dbQuery).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(finalizePaidQuote).not.toHaveBeenCalled();
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
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

  it('rejects non-Poster callers before recovery work', async () => {
    await expect(caller('worker').recoverOrphanPayment(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
  });

  it('rejects browser-supplied reason authority at the request boundary', async () => {
    await expect(
      caller().recoverOrphanPayment({
        ...input,
        reasonCode: 'UNDERWRITING_CONTAINMENT',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(recoverOrphanQuotePayment).not.toHaveBeenCalled();
  });
});
