import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { finalizePaidQuote } from '../QuotePaymentFinalizationService.js';
import { configuredQuotePaymentProvider, loadTilledConfig } from './TilledConfig.js';
import { normalizeTilledStatus, tilledClient, validateTilledIntentBinding } from './TilledQuotePaymentProvider.js';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const PAYMENT_INTENT_EVENTS = new Set([
  'payment_intent.created', 'payment_intent.processing',
  'payment_intent.requires_action', 'payment_intent.payment_failed',
  'payment_intent.canceled', 'payment_intent.succeeded',
  'payment_intent.amount_capturable_updated',
]);

interface TilledEvent {
  id: string;
  account_id: string;
  type: string;
  data?: { id?: string };
}

function isTilledEvent(value: unknown): value is TilledEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string' && /^evt_[A-Za-z0-9_]+$/.test(event.id)
    && typeof event.account_id === 'string' && /^acct_[A-Za-z0-9_]+$/.test(event.account_id)
    && typeof event.type === 'string' && event.type.length <= 120;
}

/** Tilled signs the exact HTTP body as HMAC-SHA256(timestamp + '.' + body). */
export function verifyTilledWebhookSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((part) => part.trim());
  const timestamps = parts.filter((part) => part.startsWith('t=')).map((part) => part.slice(2));
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (timestamps.length !== 1 || !/^\d{13}$/.test(timestamps[0]) || signatures.length === 0) return false;
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamps[0]}.${rawBody}`, 'utf8').digest();
  return signatures.some((signature) => {
    if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  });
}

export async function ingestTilledWebhook(rawBody: string, signature: string | undefined): Promise<
  { accepted: true; eventId: string } | { accepted: false; status: 400 | 401 | 503 }
> {
  if (configuredQuotePaymentProvider() !== 'tilled') return { accepted: false, status: 503 };
  const secret = process.env.TILLED_WEBHOOK_SECRET?.trim();
  if (!secret) return { accepted: false, status: 503 };
  if (Buffer.byteLength(rawBody, 'utf8') > 1_000_000) return { accepted: false, status: 400 };
  if (!verifyTilledWebhookSignature(rawBody, signature, secret)) return { accepted: false, status: 401 };
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return { accepted: false, status: 400 }; }
  if (!isTilledEvent(parsed)) return { accepted: false, status: 400 };
  const event = parsed;
  await db.query(`INSERT INTO payment_provider_events
    (provider, provider_event_id, provider_account_id, event_type, payload)
    VALUES ('tilled', $1, $2, $3, $4::jsonb)
    ON CONFLICT (provider, provider_event_id) DO NOTHING`,
  [event.id, event.account_id, event.type, rawBody]);
  return { accepted: true, eventId: event.id };
}

interface StoredEvent {
  id: string;
  provider_event_id: string;
  provider_account_id: string;
  event_type: string;
  payload: TilledEvent;
}

interface BoundPayment {
  id: string;
  quote_id: string;
  quote_version_id: string;
  task_draft_id: string;
  poster_user_id: string;
  business_organization_id: string;
  provider_merchant_id: string;
  provider_payment_id: string;
  amount_cents: number;
  platform_fee_cents: number;
}

async function processEvent(event: StoredEvent): Promise<'PROCESSED' | 'DEFERRED'> {
  if (event.payload?.id !== event.provider_event_id
    || event.payload?.account_id !== event.provider_account_id
    || event.payload?.type !== event.event_type) {
    throw new Error('EVENT_BINDING_MISMATCH');
  }
  // Unknown events are retained for audit; no payment state can be inferred from them.
  if (!PAYMENT_INTENT_EVENTS.has(event.event_type)) return 'PROCESSED';
  const intentId = event.payload?.data?.id;
  if (typeof intentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(intentId)) return 'DEFERRED';
  const config = loadTilledConfig();
  const paymentResult = await db.query<BoundPayment>(`
    SELECT payment.id, payment.quote_id, payment.quote_version_id,
      quote.task_draft_id, draft.poster_user_id, payment.business_organization_id,
      payment.provider_merchant_id, payment.provider_payment_id,
      payment.amount_cents, payment.platform_fee_cents
    FROM quote_payments payment
    JOIN quotes quote ON quote.id = payment.quote_id
      AND quote.active_version_id = payment.quote_version_id
    JOIN task_drafts draft ON draft.id = quote.task_draft_id
    WHERE payment.provider = 'tilled' AND payment.provider_environment = $1
      AND payment.provider_merchant_id = $2 AND payment.provider_payment_id = $3
      AND payment.intent_creation_state = 'BOUND'
    LIMIT 1`, [config.environment, event.provider_account_id, intentId]);
  const payment = paymentResult.rows[0];
  if (!payment?.poster_user_id) return 'DEFERRED';
  const intent = await tilledClient().getPaymentIntent(payment.provider_merchant_id, intentId);
  const binding = validateTilledIntentBinding(intent, {
    paymentIntentId: intentId,
    localPaymentId: payment.id,
    quoteId: payment.quote_id,
    quoteVersionId: payment.quote_version_id,
    taskDraftId: payment.task_draft_id,
    organizationId: payment.business_organization_id,
    merchantAccountId: payment.provider_merchant_id,
    posterId: payment.poster_user_id,
    amountCents: Number(payment.amount_cents),
    platformFeeCents: Number(payment.platform_fee_cents),
  }, false);
  if (!binding.success) throw new Error(binding.error.code);
  const status = normalizeTilledStatus(intent.status);
  if (status === 'unknown') return 'DEFERRED';
  await db.query(`UPDATE quote_payments SET provider_status = $2, updated_at = NOW()
    WHERE id = $1 AND provider = 'tilled' AND provider_payment_id = $3`,
  [payment.id, status, intentId]);
  if (status !== 'succeeded') return 'PROCESSED';
  const finalized = await finalizePaidQuote({
    quoteId: payment.quote_id,
    quoteVersionId: payment.quote_version_id,
    posterId: payment.poster_user_id,
    paymentIntentId: intentId,
    paymentMode: 'tilled',
  });
  if (!finalized.success) throw new Error(finalized.error.code);
  return 'PROCESSED';
}

/** Worker-driven, idempotent processing; the HTTP handler only persists events. */
export async function processPendingTilledWebhookEvents(limit = 25): Promise<number> {
  if (configuredQuotePaymentProvider() !== 'tilled') return 0;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25));
  const events = await db.query<StoredEvent>(`
    SELECT id, provider_event_id, provider_account_id, event_type, payload
    FROM payment_provider_events
    WHERE provider = 'tilled' AND processing_status IN ('RECEIVED', 'FAILED', 'DEFERRED')
    ORDER BY CASE processing_status
      WHEN 'RECEIVED' THEN 0 WHEN 'FAILED' THEN 1 ELSE 2 END,
      received_at, id LIMIT $1`, [boundedLimit]);
  for (const event of events.rows) {
    try {
      const status = await processEvent(event);
      await db.query(`UPDATE payment_provider_events SET processing_status = $2::text,
        processed_at = CASE WHEN $2::text = 'PROCESSED' THEN NOW() ELSE NULL END,
        last_error = NULL WHERE id = $1 AND processing_status <> 'PROCESSED'`, [event.id, status]);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN';
      logger.warn({ provider: 'tilled', eventId: event.provider_event_id, errorCode: code }, 'Tilled event processing deferred');
      await db.query(`UPDATE payment_provider_events SET processing_status = 'FAILED',
        last_error = $2 WHERE id = $1 AND processing_status <> 'PROCESSED'`, [event.id, code.slice(0, 120)]);
    }
  }
  return events.rows.length;
}
