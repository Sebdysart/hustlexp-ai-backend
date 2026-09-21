import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/logger.js', () => ({ logger: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} }));
vi.mock('../../src/services/BusinessQuoteActivationService.js', () => ({
  isBusinessQuoteProviderVerified: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/services/ManualTaskPolicy.js', () => ({
  buildManualTaskPolicyInput: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/services/RegionPolicyService.js', () => ({
  resolveRegionPolicy: vi.fn().mockResolvedValue({}),
  evaluateTaskAgainstRegionPolicy: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock('../../src/services/QuoteServiceAddressService.js', () => ({
  lockQuoteAddressForPayment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/QuotePaymentFinalizationService.js', () => ({ finalizePaidQuote: vi.fn() }));
vi.mock('../../src/services/payment/TilledMerchantAccountService.js', () => ({
  resolveTilledMerchantAccount: vi.fn(),
}));
vi.mock('../../src/services/payment/TilledQuotePaymentProvider.js', () => ({
  tilledClient: vi.fn(),
  TilledQuotePaymentProvider: { createPaymentIntent: vi.fn() },
  validateTilledIntentBinding: vi.fn(),
}));

const { db } = await import('../../src/db.js');
const { logger } = await import('../../src/logger.js');
const { lockQuoteAddressForPayment } = await import('../../src/services/QuoteServiceAddressService.js');
const { resolveTilledMerchantAccount } = await import('../../src/services/payment/TilledMerchantAccountService.js');
const { tilledClient, TilledQuotePaymentProvider, validateTilledIntentBinding } =
  await import('../../src/services/payment/TilledQuotePaymentProvider.js');
const { createOrResumeTilledCheckout } = await import('../../src/services/payment/TilledQuoteCheckoutService.js');
const { mapTilledCheckoutError } = await import('../../src/routers/quotePayment.js');
const { TilledApiError } = await import('../../src/services/payment/TilledClient.js');

const input = { quoteId: 'quote-one', quoteVersionId: 'version-one', posterId: 'poster-one' };
const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
const date = tomorrow.toISOString().slice(0, 10);
const quote = {
  quote_id: 'quote-one', task_draft_id: 'draft-one', quote_status: 'quote_ready',
  quote_environment: 'TEST', quote_is_test: true, selected_quote_id: 'quote-one',
  business_organization_id: 'org-one', total_cents: 12000, hustler_payout_cents: 10000,
  expires_at: new Date(Date.now() + 24 * 60 * 60_000),
  arrival_window_start: tomorrow, arrival_window_end: new Date(tomorrow.getTime() + 60 * 60_000),
  scheduled_service_date: date, arrival_start_date: date, arrival_end_date: date,
  dispatch_expires_at: new Date(), category: 'cleaning', region_code: 'SEA',
  region_policy_id: 'policy-one', region_policy_version: 'v1', region_policy_hash: 'hash',
  region_policy_snapshot: {}, validated_risk_level: 'LOW',
};
const payment = {
  id: 'payment-one', quote_id: 'quote-one', quote_version_id: 'version-one',
  task_id: null, provider: 'tilled', provider_payment_id: 'reservation-one',
  provider_merchant_id: 'acct_one', business_organization_id: 'org-one',
  amount_cents: 12000, platform_fee_cents: 2000,
  provider_environment: 'sandbox', provider_status: null,
  intent_creation_state: 'RESERVED', status: 'PENDING',
};
const intent = {
  id: 'pi_one', account_id: 'acct_one', amount: 12000, amount_received: 0,
  currency: 'usd', status: 'requires_payment_method', capture_method: 'automatic',
  client_secret: 'client-secret', platform_fee_amount: 2000,
  metadata: { hustlexp_payment_id: 'payment-one', quote_id: 'quote-one',
    quote_version_id: 'version-one', task_draft_id: 'draft-one', organization_id: 'org-one' },
};

let storedPayment: typeof payment | null;
let failBind: boolean;

beforeEach(() => {
  vi.stubEnv('QUOTE_PAYMENT_PROVIDER', 'tilled');
  vi.stubEnv('TILLED_ENV', 'sandbox');
  vi.stubEnv('TILLED_SECRET_KEY', 'test-secret');
  vi.stubEnv('TILLED_PUBLISHABLE_KEY', 'test-public');
  vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
  storedPayment = null;
  failBind = false;
  vi.mocked(resolveTilledMerchantAccount).mockResolvedValue({
    organizationId: 'org-one', accountId: 'acct_one', environment: 'sandbox',
    status: 'ACTIVE', chargesEnabled: true,
  });
  vi.mocked(TilledQuotePaymentProvider.createPaymentIntent).mockResolvedValue({
    success: true, data: { paymentIntentId: 'pi_one', clientSecret: 'client-secret',
      amountCents: 12000, status: 'requires_payment_method' },
  });
  vi.mocked(tilledClient).mockReturnValue({
    getPaymentIntent: vi.fn().mockResolvedValue(intent),
    findPaymentIntentsByLocalPaymentId: vi.fn().mockResolvedValue([intent]),
  } as never);
  vi.mocked(validateTilledIntentBinding).mockReturnValue({ success: true, data: undefined });
  vi.mocked(db.query).mockImplementation(async (sql) => {
    const query = String(sql);
    if (query.includes('SELECT q.id AS quote_id')) return { rows: [quote] } as never;
    if (query.includes('FROM quote_payments WHERE quote_id')) {
      return { rows: storedPayment ? [storedPayment] : [] } as never;
    }
    if (query.includes('FROM business_assessment_requests assessment')) return { rows: [] } as never;
    if (query.includes('INSERT INTO quote_payments')) {
      storedPayment = { ...payment };
      return { rows: [] } as never;
    }
    if (query.includes("intent_creation_state = 'RECONCILE_REQUIRED'")) {
      if (storedPayment) storedPayment.intent_creation_state = 'RECONCILE_REQUIRED';
      return { rows: [] } as never;
    }
    if (query.includes("intent_creation_state = 'CREATING'")) {
      if (storedPayment) storedPayment.intent_creation_state = 'CREATING';
      return { rows: [{ id: payment.id }] } as never;
    }
    if (query.includes('SET provider_payment_id = $2')) {
      if (failBind) throw new Error('simulated persistence failure');
      if (storedPayment) {
        storedPayment.provider_payment_id = 'pi_one';
        storedPayment.intent_creation_state = 'BOUND';
      }
      return { rows: [{ id: payment.id }] } as never;
    }
    return { rows: [] } as never;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Tilled checkout diagnostics before durable reservation', () => {
  it('binds UUID columns separately from the text reservation reference', async () => {
    await createOrResumeTilledCheckout(input);
    const reservation = vi.mocked(db.query).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO quote_payments'));

    expect(reservation).toBeDefined();
    const [sql, values] = reservation!;
    expect(String(sql)).toMatch(/VALUES \(\$1, \$2, 'tilled', 'tilled_reservation:' \|\| \$8::text \|\| ':' \|\| \$9::text/);
    expect(values).toEqual([
      input.quoteId, input.quoteVersionId, 12000, 2000,
      'org-one', 'acct_one', 'sandbox', input.quoteId, input.quoteVersionId,
    ]);
  });

  it('reports missing credentials and creates no local payment', async () => {
    vi.stubEnv('TILLED_SECRET_KEY', '');
    await expect(createOrResumeTilledCheckout(input)).rejects.toMatchObject({
      name: 'TilledConfigurationError',
    });
    expect(storedPayment).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'load_tilled_config', operation: 'tilled_create_checkout',
    }), expect.any(String));
  });

  it('distinguishes a missing merchant mapping', async () => {
    vi.mocked(resolveTilledMerchantAccount).mockResolvedValue(null);
    await expect(createOrResumeTilledCheckout(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: 'Business payment account is not configured for this environment.',
    });
    expect(storedPayment).toBeNull();
  });

  it('distinguishes an inactive or charges-disabled merchant', async () => {
    vi.mocked(resolveTilledMerchantAccount).mockResolvedValue({
      organizationId: 'org-one', accountId: 'acct_one', environment: 'sandbox',
      status: 'ACTIVE', chargesEnabled: false,
    });
    await expect(createOrResumeTilledCheckout(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: 'Business payment account is not active for charges.',
    });
    expect(storedPayment).toBeNull();
  });

  it('rejects a sandbox/quote environment mismatch before reservation', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ ...quote, quote_environment: 'LIVE' }] } as never);
    await expect(createOrResumeTilledCheckout(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: 'This quote and payment environment do not match.',
    });
    expect(storedPayment).toBeNull();
  });

  it('preserves the canonical creation freeze before reservation', async () => {
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    await expect(createOrResumeTilledCheckout(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(storedPayment).toBeNull();
    expect(TilledQuotePaymentProvider.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('logs the failing reservation stage for an internal database exception', async () => {
    vi.mocked(db.query).mockImplementationOnce(async () => ({ rows: [quote] } as never))
      .mockImplementationOnce(async () => ({ rows: [] } as never))
      .mockImplementationOnce(async () => ({ rows: [] } as never))
      .mockImplementationOnce(async () => { throw new Error('simulated insert failure'); });
    await expect(createOrResumeTilledCheckout(input)).rejects.toThrow('simulated insert failure');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'reserve_local_payment', error_name: 'Error',
      error_stack: expect.any(String),
    }), expect.any(String));
  });
});

describe('Tilled provider failure and safe retry', () => {
  it('marks an uncertain provider request for reconciliation without another intent', async () => {
    vi.mocked(TilledQuotePaymentProvider.createPaymentIntent).mockRejectedValueOnce(
      new TilledApiError('PROVIDER_TIMEOUT', undefined, { kind: 'timeout' }));
    await expect(createOrResumeTilledCheckout(input)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(storedPayment?.intent_creation_state).toBe('RECONCILE_REQUIRED');
    const created = await createOrResumeTilledCheckout(input);
    expect(created).toMatchObject({ finalized: false, localPaymentId: 'payment-one', providerPaymentIntentId: 'pi_one' });
    expect(TilledQuotePaymentProvider.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('recovers a created intent after local binding fails', async () => {
    failBind = true;
    await expect(createOrResumeTilledCheckout(input)).rejects.toThrow('simulated persistence failure');
    expect(storedPayment?.intent_creation_state).toBe('CREATING');
    failBind = false;
    const recovered = await createOrResumeTilledCheckout(input);
    expect(recovered).toMatchObject({ finalized: false, localPaymentId: 'payment-one' });
    expect(TilledQuotePaymentProvider.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('maps expected provider errors without leaking raw provider messages', () => {
    expect(mapTilledCheckoutError(new TilledApiError('invalid_request', 422))?.code)
      .toBe('PRECONDITION_FAILED');
    expect(mapTilledCheckoutError(new TilledApiError('bad_key', 401))?.code)
      .toBe('SERVICE_UNAVAILABLE');
    expect(mapTilledCheckoutError(new TilledApiError('gateway_error', 500))?.code)
      .toBe('SERVICE_UNAVAILABLE');
    expect(mapTilledCheckoutError(new TilledApiError('PROVIDER_TIMEOUT'))?.code)
      .toBe('SERVICE_UNAVAILABLE');
    expect(mapTilledCheckoutError(new TilledApiError('INVALID_PROVIDER_RESPONSE'))?.code)
      .toBe('BAD_GATEWAY');
    expect(mapTilledCheckoutError(new Error('unexpected bug'))).toBeNull();
  });
});
