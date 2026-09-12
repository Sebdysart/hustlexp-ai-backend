import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), create: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/trpc.js', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<{ user: { id: string } }>().create();
  return { router: t.router, posterProcedure: t.procedure };
});
vi.mock('../../src/services/payment/StripeQuotePaymentProvider.js', () => ({
  StripeQuotePaymentProvider: { createPaymentIntent: mocks.create },
}));
vi.mock('../../src/services/QuotePaymentFinalizationService.js', () => ({ finalizePaidQuote: vi.fn() }));
vi.mock('../../src/services/StripeService.js', () => ({ StripeService: {} }));

import { quotePaymentRouter } from '../../src/routers/quotePayment.js';

const input = {
  quoteId: '11111111-1111-4111-8111-111111111111',
  quoteVersionId: '22222222-2222-4222-8222-222222222222',
};
const caller = quotePaymentRouter.createCaller({ user: { id: 'poster' } } as never);
function validQuote() {
  return {
    selected_quote_id: input.quoteId,
    quote_status: 'quote_send_ready',
    business_organization_id: 'business',
    business_location_id: 'location',
    provider_service_profile_id: 'profile',
    total_cents: 10000,
    hustler_payout_cents: 8000,
    expires_at: new Date('2099-01-01T00:00:00Z'),
    arrival_window_start: new Date('2099-01-02T01:00:00Z'),
    arrival_window_end: new Date('2099-01-04T01:00:00Z'),
    dispatch_expires_at: new Date('2099-01-01T00:00:00Z'),
    scheduled_service_date: '2099-01-01',
    arrival_start_date: '2099-01-01',
    arrival_end_date: '2099-01-03',
  };
}
function setup(overrides: Record<string, unknown> = {}, existing?: Record<string, unknown>) {
  mocks.query.mockResolvedValueOnce({ rows: [{ ...validQuote(), ...overrides }] })
    .mockResolvedValueOnce({ rows: existing ? [existing] : [] })
    .mockResolvedValue({ rows: [] });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({ success: true, data: {
    paymentIntentId: 'pi_test_payment', clientSecret: 'test_secret', amountCents: 10000,
  } });
});

describe('quote payment preflight', () => {
  it.each([
    [{ business_location_id: null }, 'binding'],
    [{ provider_service_profile_id: null }, 'binding'],
    [{ total_cents: 0 }, 'invalid total'],
    [{ total_cents: -1 }, 'invalid total'],
    [{ total_cents: 1.5 }, 'invalid total'],
    [{ total_cents: Number.NaN }, 'invalid total'],
    [{ hustler_payout_cents: 0 }, 'invalid provider payout'],
    [{ hustler_payout_cents: -1 }, 'invalid provider payout'],
    [{ hustler_payout_cents: 1.5 }, 'invalid provider payout'],
    [{ hustler_payout_cents: 11000 }, 'invalid payment economics'],
    [{ scheduled_service_date: null }, 'Choose a service date'],
    [{ scheduled_service_date: '2098-12-31' }, 'outside the provider availability'],
    [{ scheduled_service_date: '2099-01-04' }, 'outside the provider availability'],
    [{ arrival_window_start: null }, 'invalid arrival window'],
    [{ arrival_window_end: new Date('2098-01-01') }, 'invalid arrival window'],
    [{ dispatch_expires_at: null }, 'invalid dispatch window'],
    [{ dispatch_expires_at: new Date('2099-01-03') }, 'invalid dispatch window'],
    [{ selected_quote_id: 'other' }, 'not been accepted'],
    [{ quote_status: 'submitted' }, 'cannot currently be paid'],
    [{ expires_at: new Date('2000-01-01') }, 'expired'],
  ])('rejects invalid quote %j before creating or reusing payment', async (override, message) => {
    setup(override, { status: 'PENDING', provider_payment_id: 'pi_existing', amount_cents: 10000 });
    await expect(caller.createPaymentIntent(input)).rejects.toThrow(message);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each(['2099-01-01', '2099-01-02', '2099-01-03'])('accepts inclusive Pacific date %s', async (date) => {
    setup({ scheduled_service_date: date });
    await expect(caller.createPaymentIntent(input)).resolves.toMatchObject({ replayed: false });
    expect(mocks.create).toHaveBeenCalledWith({ ...input, posterId: 'poster', amountCents: 10000 });
    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain("(qv.arrival_window_start AT TIME ZONE 'America/Los_Angeles')::date::text");
    expect(sql).toContain("(qv.arrival_window_end AT TIME ZONE 'America/Los_Angeles')::date::text");
  });

  it('allows zero margin and a past dispatch expiry when its ordering is valid', async () => {
    setup({ hustler_payout_cents: 10000, dispatch_expires_at: new Date('2000-01-01') });
    await expect(caller.createPaymentIntent(input)).resolves.toMatchObject({ replayed: false });
  });

  it('reuses a pending payment only after valid preflight', async () => {
    setup({}, { status: 'PENDING', provider_payment_id: 'pi_existing', amount_cents: 10000 });
    await expect(caller.createPaymentIntent(input)).resolves.toMatchObject({ replayed: true, paymentIntentId: 'pi_existing' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not require business bindings for a non-business quote', async () => {
    setup({ business_organization_id: null, business_location_id: null, provider_service_profile_id: null });
    await expect(caller.createPaymentIntent(input)).resolves.toMatchObject({ replayed: false });
  });
});
