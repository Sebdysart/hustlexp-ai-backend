import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));

const { db } = await import('../../src/db.js');
const { configuredQuotePaymentProvider, loadTilledConfig } = await import('../../src/services/payment/TilledConfig.js');
const { TilledClient } = await import('../../src/services/payment/TilledClient.js');
const { resolveTilledMerchantAccount } = await import('../../src/services/payment/TilledMerchantAccountService.js');
const { normalizeTilledStatus, validateTilledIntentBinding } = await import('../../src/services/payment/TilledQuotePaymentProvider.js');

const config = {
  environment: 'sandbox' as const,
  apiBaseUrl: 'https://sandbox-api.tilled.com',
  secretKey: 'secret-only-for-this-test',
  publishableKey: 'public-only-for-this-test',
};
const binding = {
  paymentIntentId: 'pi_one', localPaymentId: 'payment-one',
  quoteId: 'quote-one', quoteVersionId: 'version-one', taskDraftId: 'draft-one',
  organizationId: 'org-one', merchantAccountId: 'acct_one', posterId: 'poster-one',
  amountCents: 12000, platformFeeCents: 2000,
};
const intent = {
  id: 'pi_one', account_id: 'acct_one', amount: 12000, amount_received: 12000,
  currency: 'usd', status: 'succeeded', capture_method: 'automatic',
  client_secret: 'browser-secret', platform_fee_amount: 2000,
  metadata: {
    hustlexp_payment_id: 'payment-one', quote_id: 'quote-one',
    quote_version_id: 'version-one', task_draft_id: 'draft-one', organization_id: 'org-one',
  },
};

afterEach(() => vi.clearAllMocks());

describe('Tilled quote payment config', () => {
  it('does not need Tilled credentials when local test is selected', () => {
    expect(configuredQuotePaymentProvider({})).toBe('local_test');
  });
  it('derives the sandbox and production hosts from one environment', () => {
    expect(loadTilledConfig({ TILLED_ENV: 'sandbox', TILLED_SECRET_KEY: 'secret', TILLED_PUBLISHABLE_KEY: 'public' }).apiBaseUrl)
      .toBe('https://sandbox-api.tilled.com');
    expect(loadTilledConfig({ TILLED_ENV: 'production', TILLED_SECRET_KEY: 'secret', TILLED_PUBLISHABLE_KEY: 'public' }).apiBaseUrl)
      .toBe('https://api.tilled.com');
  });
  it('rejects invalid environment and missing keys', () => {
    expect(() => loadTilledConfig({ TILLED_ENV: 'other', TILLED_SECRET_KEY: 'secret', TILLED_PUBLISHABLE_KEY: 'public' })).toThrow();
    expect(() => loadTilledConfig({ TILLED_ENV: 'sandbox' })).toThrow();
  });
});

describe('merchant account authority', () => {
  it('uses the exact organization and environment and requires payment readiness', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{
      organization_id: 'org-one', provider_account_id: 'acct_one', environment: 'sandbox',
      status: 'ACTIVE', charges_enabled: true,
    }] } as never);
    expect((await resolveTilledMerchantAccount('org-one', 'sandbox'))?.accountId).toBe('acct_one');
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toEqual(['org-one', 'sandbox']);
  });
  it('rejects missing and inactive merchant mappings', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{
        organization_id: 'org-one', provider_account_id: 'acct_one', environment: 'sandbox',
        status: 'PENDING', charges_enabled: false,
      }] } as never);
    expect(await resolveTilledMerchantAccount('org-one', 'sandbox')).toBeNull();
    expect(await resolveTilledMerchantAccount('org-one', 'sandbox')).toBeNull();
  });
});

describe('Tilled payment intent contract', () => {
  it('sends only server-created economics, metadata and merchant-scoped headers', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => intent });
    const client = new TilledClient(config, fetcher);
    await client.createPaymentIntent({ accountId: 'acct_one', amountCents: 12000,
      platformFeeCents: 2000, metadata: intent.metadata });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://sandbox-api.tilled.com/v1/payment-intents');
    expect(init.headers['tilled-account']).toBe('acct_one');
    expect(init.headers['tilled-api-key']).toBe(config.secretKey);
    expect(JSON.parse(init.body)).toMatchObject({ amount: 12000, currency: 'usd',
      capture_method: 'automatic', platform_fee_amount: 2000, metadata: intent.metadata });
  });
  it('rejects invalid economics before network access', async () => {
    const fetcher = vi.fn();
    expect(() => new TilledClient(config, fetcher).createPaymentIntent({
      accountId: 'acct_one', amountCents: 100, platformFeeCents: 101, metadata: {},
    })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('filters recovery results by the exact local payment ID', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [intent, {
      ...intent, metadata: { hustlexp_payment_id: 'another-payment' },
    }] }) });
    const found = await new TilledClient(config, fetcher).findPaymentIntentsByLocalPaymentId('acct_one', 'payment-one');
    expect(found).toEqual([intent]);
  });
  it('accepts only exact successful binding', () => {
    expect(validateTilledIntentBinding(intent, binding, true).success).toBe(true);
  });
  it.each(['processing', 'requires_action', 'requires_capture', 'canceled', 'new_state'])(
    'does not finalize provider status %s', (status) => {
      expect(validateTilledIntentBinding({ ...intent, status }, binding, true).success).toBe(false);
    },
  );
  it.each([
    ['id', 'pi_other'], ['account_id', 'acct_other'], ['amount', 13000],
    ['currency', 'cad'], ['capture_method', 'manual'], ['platform_fee_amount', 100],
    ['amount_received', 11000],
  ] as const)('rejects mismatched %s', (field, value) => {
    expect(validateTilledIntentBinding({ ...intent, [field]: value }, binding, true).success).toBe(false);
  });
  it('rejects mismatched server correlation metadata', () => {
    expect(validateTilledIntentBinding({ ...intent, metadata: { ...intent.metadata, quote_id: 'quote-other' } }, binding, true).success).toBe(false);
  });
  it('normalizes unknown provider states to a fail-closed value', () => {
    expect(normalizeTilledStatus('novel_state')).toBe('unknown');
  });
});
