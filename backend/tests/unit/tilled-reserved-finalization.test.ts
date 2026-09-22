import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn(), transaction: vi.fn() } }));
vi.mock('../../src/services/EscrowService.js', () => ({ EscrowService: { fund: vi.fn() } }));
vi.mock('../../src/services/TaskCreateService.js', () => ({ TaskCreateService: { materializeQuotedTaskInTransaction: vi.fn() } }));
vi.mock('../../src/services/QuoteServiceAddressService.js', () => ({ readQuoteServiceLocation: vi.fn(), consumeQuoteServiceAddress: vi.fn() }));
vi.mock('../../src/services/QuoteTaskParamsMapper.js', () => ({ mapQuoteToCreateTaskParams: vi.fn() }));
vi.mock('../../src/services/BusinessQuoteActivationService.js', () => ({ isBusinessQuoteProviderVerified: vi.fn() }));
vi.mock('../../src/services/NotificationService.js', () => ({ NotificationService: { createInTransaction: vi.fn(), createForBusinessInTransaction: vi.fn() } }));
vi.mock('../../src/services/AnalyticsService.js', () => ({ AnalyticsService: { track: vi.fn() } }));
vi.mock('../../src/services/payment/TilledConfig.js', () => ({ loadTilledConfig: vi.fn(() => ({ environment: 'sandbox' })) }));
vi.mock('../../src/services/payment/TilledQuotePaymentProvider.js', () => ({ TilledQuotePaymentProvider: { verifySucceededPayment: vi.fn() } }));
vi.mock('../../src/services/payment/TilledMerchantAccountService.js', () => ({ resolveTilledMerchantAccount: vi.fn() }));
vi.mock('../../src/services/ControlledTestQuotePaymentService.js', () => ({ controlledTestQuotePaymentEnabled: vi.fn(), settleControlledTestQuotePayment: vi.fn() }));

const { db } = await import('../../src/db.js');
const { TaskCreateService } = await import('../../src/services/TaskCreateService.js');
const { EscrowService } = await import('../../src/services/EscrowService.js');
const { isBusinessQuoteProviderVerified } = await import('../../src/services/BusinessQuoteActivationService.js');
const { mapQuoteToCreateTaskParams } = await import('../../src/services/QuoteTaskParamsMapper.js');
const { TilledQuotePaymentProvider } = await import('../../src/services/payment/TilledQuotePaymentProvider.js');
const { resolveTilledMerchantAccount } = await import('../../src/services/payment/TilledMerchantAccountService.js');
const { finalizePaidQuote } = await import('../../src/services/QuotePaymentFinalizationService.js');

const input = { quoteId: 'quote', quoteVersionId: 'reserved-version', posterId: 'poster', paymentIntentId: 'pi_reserved', paymentMode: 'tilled' as const };
let context: Record<string, unknown>;
let quote: Record<string, unknown>;
let payment: Record<string, unknown>;
const version = { id: 'reserved-version', quote_id: 'quote', status: 'draft', total_cents: 12000,
  hustler_payout_cents: 10000, expires_at: new Date('2020-01-01') };

beforeEach(() => {
  vi.clearAllMocks();
  context = { quote_id: 'quote', quote_version_id: 'reserved-version', quote_status: 'quote_send_ready',
    selected_quote_id: 'quote', total_cents: 12000, hustler_payout_cents: 10000,
    business_organization_id: 'org', payment_business_organization_id: 'org', provider_payment_id: 'pi_reserved',
    payment_id: 'local', task_draft_id: 'draft', payment_provider: 'tilled', payment_status: 'PENDING',
    payment_task_id: null, payment_amount_cents: 12000, provider_merchant_id: 'acct_reserved',
    provider_environment: 'sandbox', payment_platform_fee_cents: 2000, assessment_credit_cents: null,
    poster_user_id: 'poster', reserved_poster_id: 'poster', reserved_at: new Date('2019-12-31'),
    currency: 'usd', intent_creation_state: 'BOUND', finalization_state: 'PENDING', quote_environment: 'TEST', quote_is_test: true };
  quote = { id: 'quote', task_draft_id: 'draft', active_version_id: 'reserved-version',
    status: 'quote_send_ready', selected_quote_id: 'quote', poster_user_id: 'poster',
    business_organization_id: 'org', environment: 'TEST', is_test: true };
  payment = { id: 'local', task_id: null, provider: 'tilled', provider_payment_id: 'pi_reserved',
    amount_cents: 12000, platform_fee_cents: 2000, business_organization_id: 'org',
    provider_merchant_id: 'acct_reserved', provider_environment: 'sandbox', status: 'PENDING',
    reserved_poster_id: 'poster', reserved_at: new Date('2019-12-31'), currency: 'usd',
    intent_creation_state: 'BOUND', finalization_state: 'PENDING' };
  vi.mocked(db.transaction).mockImplementation(async (callback) => callback(db.query));
  vi.mocked(db.query).mockImplementation(async (rawSql) => {
    const sql = String(rawSql);
    if (sql.includes('q.id AS quote_id')) return { rows: [context] } as never;
    if (sql.includes('FOR UPDATE OF q, d')) return { rows: [quote] } as never;
    if (sql.includes('FROM quote_versions')) return { rows: [version] } as never;
    if (sql.includes('FROM quote_payments')) return { rows: [payment] } as never;
    if (sql.includes('FROM task_drafts')) return { rows: [{ id: 'draft', lead_id: 'lead' }] } as never;
    if (sql.includes('FROM leads')) return { rows: [{ id: 'lead', user_id: 'poster', email: null }] } as never;
    if (sql.includes('FROM users')) return { rows: [{ email: null }] } as never;
    if (sql.includes('AS escrow_state')) return { rows: [{ escrow_state: 'FUNDED', task_state: 'ACCEPTED' }] } as never;
    if (sql.includes('FROM escrows')) return { rows: [{ id: 'escrow', state: 'FUNDED', amount: 12000 }] } as never;
    if (sql.includes('UPDATE task_drafts')) return { rows: [{ task_id: 'task' }] } as never;
    return { rows: [{ id: 'local' }], rowCount: 1 } as never;
  });
  vi.mocked(isBusinessQuoteProviderVerified).mockResolvedValue(true);
  vi.mocked(resolveTilledMerchantAccount).mockResolvedValue({ accountId: 'acct_reserved' } as never);
  vi.mocked(TilledQuotePaymentProvider.verifySucceededPayment).mockResolvedValue({ success: true, data: undefined });
  vi.mocked(mapQuoteToCreateTaskParams).mockReturnValue({} as never);
  vi.mocked(TaskCreateService.materializeQuotedTaskInTransaction).mockResolvedValue({ success: true, data: { id: 'task' } } as never);
});

describe('provider-successful reserved Tilled obligation', () => {
  it('materializes the exact paid reservation after quote expiry', async () => {
    expect(await finalizePaidQuote(input)).toMatchObject({ success: true, data: { taskId: 'task' } });
    expect(TaskCreateService.materializeQuotedTaskInTransaction).toHaveBeenCalledOnce();
    expect(vi.mocked(db.query).mock.calls[0][0]).not.toContain('qv.id = q.active_version_id');
  });

  it('materializes the reserved version after the active version changes', async () => {
    quote.active_version_id = 'new-version';
    quote.status = 'submitted';
    context.quote_status = 'submitted';
    expect(await finalizePaidQuote(input)).toMatchObject({ success: true, data: { taskId: 'task' } });
    expect(mapQuoteToCreateTaskParams).toHaveBeenCalledWith(expect.objectContaining({ quoteVersion: version }));
  });

  it.each([
    ['provider_payment_id', 'pi_wrong'], ['payment_provider', 'local_test'], ['reserved_poster_id', 'other-poster'],
  ])('rejects a mismatched %s before materialization', async (field, value) => {
    context[field] = value;
    expect(await finalizePaidQuote(input)).toMatchObject({ success: false });
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
  });

  it('rejects provider verification of a different merchant or version', async () => {
    vi.mocked(TilledQuotePaymentProvider.verifySucceededPayment).mockResolvedValue({ success: false,
      error: { code: 'PAYMENT_METADATA_MISMATCH', message: 'Payment context does not match.' } });
    expect(await finalizePaidQuote(input)).toMatchObject({ success: false, error: { code: 'PAYMENT_METADATA_MISMATCH' } });
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['amount_cents', 13000], ['platform_fee_cents', 1000],
    ['business_organization_id', 'other-org'], ['provider_merchant_id', 'other-account'],
    ['provider_environment', 'production'], ['reserved_poster_id', 'other-poster'],
  ])('rechecks the exact %s binding after acquiring payment locks', async (field, value) => {
    payment[field] = value;
    expect(await finalizePaidQuote(input)).toMatchObject({ success: false,
      error: { code: 'QUOTE_PAYMENT_RESERVATION_MISMATCH' } });
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
  });

  it('does not resurrect a payment refunded while provider verification was in flight', async () => {
    payment.status = 'REFUNDED';
    expect(await finalizePaidQuote(input)).toMatchObject({ success: false,
      error: { code: 'QUOTE_PAYMENT_REFUNDED' } });
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
  });

  it('returns the same manual-review outcome on replay without calling the provider', async () => {
    context.finalization_state = 'MANUAL_COMPENSATION_REQUIRED';
    context.payment_status = 'SUCCEEDED';
    expect(await finalizePaidQuote(input)).toMatchObject({ success: false,
      error: { code: 'QUOTE_PAYMENT_MANUAL_COMPENSATION_REQUIRED' } });
    expect(TilledQuotePaymentProvider.verifySucceededPayment).not.toHaveBeenCalled();
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
  });

  it('persists manual compensation for a business that became ineligible after payment', async () => {
    vi.mocked(isBusinessQuoteProviderVerified).mockResolvedValue(false);
    expect(await finalizePaidQuote(input)).toMatchObject({ success: false, error: { code: 'QUOTE_PAYMENT_MANUAL_COMPENSATION_REQUIRED' } });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("finalization_state = 'MANUAL_COMPENSATION_REQUIRED'"), expect.any(Array));
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
    expect(EscrowService.fund).not.toHaveBeenCalled();
  });

  it('replays the same task even if the version and business eligibility subsequently changed', async () => {
    context.payment_status = 'SUCCEEDED'; context.payment_task_id = 'task'; context.quote_status = 'paid';
    payment.status = 'SUCCEEDED'; payment.task_id = 'task'; payment.finalization_state = 'FINALIZED';
    quote.active_version_id = 'new-version';
    vi.mocked(isBusinessQuoteProviderVerified).mockResolvedValue(false);
    expect(await finalizePaidQuote(input)).toMatchObject({ success: true, data: { taskId: 'task', replayed: true } });
    expect(TaskCreateService.materializeQuotedTaskInTransaction).not.toHaveBeenCalled();
  });
});
