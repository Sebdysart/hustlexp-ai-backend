import { createHmac } from 'node:crypto';
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
const { ingestTilledWebhook, processPendingTilledWebhookEvents, verifyTilledWebhookSignature } =
  await import('../../src/services/payment/TilledWebhookService.js');

const event = {
  id: 'evt_one', account_id: 'acct_one', type: 'payment_intent.succeeded',
  data: { id: 'pi_one', status: 'succeeded' },
};
const payment = {
  id: 'local-one', quote_id: 'quote-one', quote_version_id: 'version-one',
  task_draft_id: 'draft-one', poster_user_id: 'poster-one',
  business_organization_id: 'org-one', provider_merchant_id: 'acct_one',
  provider_payment_id: 'pi_one', amount_cents: 12000, platform_fee_cents: 2000,
};
const intent = {
  id: 'pi_one', account_id: 'acct_one', amount: 12000, amount_received: 12000,
  currency: 'usd', status: 'succeeded', capture_method: 'automatic',
  client_secret: 'browser-secret', platform_fee_amount: 2000,
  metadata: { hustlexp_payment_id: 'local-one', quote_id: 'quote-one',
    quote_version_id: 'version-one', task_draft_id: 'draft-one', organization_id: 'org-one' },
};

function enableTilled(): void {
  vi.stubEnv('QUOTE_PAYMENT_PROVIDER', 'tilled');
  vi.stubEnv('TILLED_ENV', 'sandbox');
  vi.stubEnv('TILLED_SECRET_KEY', 'test-secret');
  vi.stubEnv('TILLED_PUBLISHABLE_KEY', 'test-public');
  vi.stubEnv('TILLED_WEBHOOK_SECRET', 'webhook-secret');
}

function signed(raw: string, timestamp = Date.now()): string {
  const digest = createHmac('sha256', 'webhook-secret').update(`${timestamp}.${raw}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Tilled webhook signature and durable ingestion', () => {
  it('verifies raw-body HMAC, timestamp, and multiple v1 signatures', () => {
    const raw = JSON.stringify(event);
    const header = signed(raw);
    expect(verifyTilledWebhookSignature(raw, header, 'webhook-secret')).toBe(true);
    expect(verifyTilledWebhookSignature(raw, `v1=${'0'.repeat(64)},${header}`, 'webhook-secret')).toBe(true);
    expect(verifyTilledWebhookSignature(`${raw} `, header, 'webhook-secret')).toBe(false);
    expect(verifyTilledWebhookSignature(raw, signed(raw, Date.now() - 10 * 60_000), 'webhook-secret')).toBe(false);
    expect(verifyTilledWebhookSignature(raw, undefined, 'webhook-secret')).toBe(false);
  });

  it('rejects invalid signatures before any database write', async () => {
    enableTilled();
    expect(await ingestTilledWebhook(JSON.stringify(event), 'bad')).toEqual({ accepted: false, status: 401 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('persists verified events with provider-event deduplication', async () => {
    enableTilled();
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    const raw = JSON.stringify(event);
    expect(await ingestTilledWebhook(raw, signed(raw))).toEqual({ accepted: true, eventId: 'evt_one' });
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).toContain('ON CONFLICT (provider, provider_event_id) DO NOTHING');
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toEqual(['evt_one', 'acct_one', event.type, raw]);
  });

  it('fails closed when the webhook secret is missing', async () => {
    enableTilled();
    vi.stubEnv('TILLED_WEBHOOK_SECRET', '');
    expect(await ingestTilledWebhook(JSON.stringify(event), signed(JSON.stringify(event))))
      .toEqual({ accepted: false, status: 503 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('Tilled webhook processing', () => {
  it('uses the stored account and provider intent before canonical finalization', async () => {
    enableTilled();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ ...event, provider_event_id: event.id,
        provider_account_id: event.account_id, event_type: event.type, payload: event }] } as never)
      .mockResolvedValueOnce({ rows: [payment] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    vi.mocked(tilledClient).mockReturnValue({ getPaymentIntent: vi.fn().mockResolvedValue(intent) } as never);
    vi.mocked(finalizePaidQuote).mockResolvedValue({ success: true, data: { taskId: 'task-one' } } as never);
    expect(await processPendingTilledWebhookEvents()).toBe(1);
    expect(tilledClient().getPaymentIntent).toHaveBeenCalledWith('acct_one', 'pi_one');
    expect(finalizePaidQuote).toHaveBeenCalledWith({
      quoteId: 'quote-one', quoteVersionId: 'version-one', posterId: 'poster-one',
      paymentIntentId: 'pi_one', paymentMode: 'tilled',
    });
    expect(vi.mocked(db.query).mock.calls.at(-1)?.[1]).toEqual([event.id, 'PROCESSED']);
  });

  it('defers an event with no bound local payment', async () => {
    enableTilled();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ ...event, provider_event_id: event.id,
        provider_account_id: event.account_id, event_type: event.type, payload: event }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    expect(await processPendingTilledWebhookEvents()).toBe(1);
    expect(finalizePaidQuote).not.toHaveBeenCalled();
    expect(vi.mocked(db.query).mock.calls.at(-1)?.[1]).toEqual([event.id, 'DEFERRED']);
  });

  it('never finalizes when provider account binding is different', async () => {
    enableTilled();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ ...event, provider_event_id: event.id,
        provider_account_id: event.account_id, event_type: event.type, payload: event }] } as never)
      .mockResolvedValueOnce({ rows: [payment] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    vi.mocked(tilledClient).mockReturnValue({ getPaymentIntent: vi.fn().mockResolvedValue({
      ...intent, account_id: 'acct_other',
    }) } as never);
    expect(await processPendingTilledWebhookEvents()).toBe(1);
    expect(finalizePaidQuote).not.toHaveBeenCalled();
    expect(vi.mocked(db.query).mock.calls.at(-1)?.[1]).toEqual([event.id, 'PAYMENT_ACCOUNT_MISMATCH']);
  });
});
