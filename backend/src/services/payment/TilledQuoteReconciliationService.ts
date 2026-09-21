import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { finalizePaidQuote } from '../QuotePaymentFinalizationService.js';
import { configuredQuotePaymentProvider, loadTilledConfig } from './TilledConfig.js';
import { normalizeTilledStatus, tilledClient, validateTilledIntentBinding } from './TilledQuotePaymentProvider.js';
import type { TilledPaymentIntent } from './TilledClient.js';

interface PendingTilledPayment {
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
  intent_creation_state: 'BOUND' | 'CREATING' | 'RECONCILE_REQUIRED';
}

export interface TilledReconciliationResult {
  scanned: number;
  finalized: number;
  deferred: number;
}

/** Recovers a charged quote when the customer's browser never reached finalize. */
export async function reconcileTilledQuotePayments(limit = 25): Promise<TilledReconciliationResult> {
  if (configuredQuotePaymentProvider() !== 'tilled') {
    return { scanned: 0, finalized: 0, deferred: 0 };
  }
  const config = loadTilledConfig();
  const client = tilledClient();
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25));
  const pending = await db.query<PendingTilledPayment>(`
    SELECT payment.id, payment.quote_id, payment.quote_version_id,
      quote.task_draft_id, draft.poster_user_id,
      payment.business_organization_id, payment.provider_merchant_id,
      payment.provider_payment_id, payment.amount_cents,
      payment.platform_fee_cents, payment.intent_creation_state
    FROM quote_payments payment
    JOIN quotes quote ON quote.id = payment.quote_id
      AND quote.active_version_id = payment.quote_version_id
    JOIN task_drafts draft ON draft.id = quote.task_draft_id
    WHERE payment.provider = 'tilled' AND payment.status = 'PENDING'
      AND payment.provider_environment = $1
      AND payment.intent_creation_state IN ('BOUND', 'CREATING', 'RECONCILE_REQUIRED')
      AND payment.business_organization_id = quote.business_organization_id
      AND draft.poster_user_id IS NOT NULL
      AND payment.updated_at < NOW() - INTERVAL '20 seconds'
    ORDER BY payment.updated_at, payment.id
    LIMIT $2`, [config.environment, boundedLimit]);

  const result = { scanned: pending.rows.length, finalized: 0, deferred: 0 };
  for (const payment of pending.rows) {
    try {
      let intent: TilledPaymentIntent;
      if (payment.intent_creation_state === 'BOUND') {
        intent = await client.getPaymentIntent(payment.provider_merchant_id, payment.provider_payment_id);
      } else {
        const found = await client.findPaymentIntentsByLocalPaymentId(payment.provider_merchant_id, payment.id);
        if (found.length !== 1) {
          // Never create a second intent when the first request's outcome is uncertain.
          await db.query(`UPDATE quote_payments SET intent_creation_state = 'RECONCILE_REQUIRED', updated_at = NOW()
            WHERE id = $1 AND status = 'PENDING' AND intent_creation_state IN ('CREATING', 'RECONCILE_REQUIRED')`, [payment.id]);
          logger.warn({ provider: 'tilled', paymentId: payment.id, matches: found.length }, 'Tilled intent requires manual reconciliation');
          result.deferred += 1;
          continue;
        }
        intent = found[0];
      }

      const binding = validateTilledIntentBinding(intent, {
        paymentIntentId: payment.intent_creation_state === 'BOUND' ? payment.provider_payment_id : intent.id,
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
      if (!binding.success) {
        logger.error({ provider: 'tilled', paymentId: payment.id, errorCode: binding.error.code }, 'Tilled reconciliation binding mismatch');
        await db.query(`UPDATE quote_payments SET updated_at = NOW() WHERE id = $1 AND status = 'PENDING'`, [payment.id]);
        result.deferred += 1;
        continue;
      }

      const bound = await db.query<{ id: string }>(`
        UPDATE quote_payments SET provider_payment_id = $2,
          provider_status = $3, intent_creation_state = 'BOUND', updated_at = NOW()
        WHERE id = $1 AND provider = 'tilled' AND status = 'PENDING'
          AND (intent_creation_state IN ('CREATING', 'RECONCILE_REQUIRED')
            OR (intent_creation_state = 'BOUND' AND provider_payment_id = $2))
        RETURNING id`, [payment.id, intent.id, intent.status]);
      if (!bound.rows[0]) {
        result.deferred += 1;
        continue;
      }
      if (normalizeTilledStatus(intent.status) !== 'succeeded') {
        result.deferred += 1;
        continue;
      }

      const finalized = await finalizePaidQuote({
        quoteId: payment.quote_id,
        quoteVersionId: payment.quote_version_id,
        posterId: payment.poster_user_id,
        paymentIntentId: intent.id,
        paymentMode: 'tilled',
      });
      if (finalized.success) result.finalized += 1;
      else {
        logger.warn({ provider: 'tilled', paymentId: payment.id, errorCode: finalized.error.code }, 'Tilled quote finalization deferred');
        result.deferred += 1;
      }
    } catch (error) {
      // A transient provider failure must not prevent other payments in this sweep.
      logger.warn({ provider: 'tilled', paymentId: payment.id, errorName: error instanceof Error ? error.name : 'unknown' }, 'Tilled reconciliation deferred');
      await db.query(`UPDATE quote_payments SET updated_at = NOW() WHERE id = $1 AND status = 'PENDING'`, [payment.id]);
      result.deferred += 1;
    }
  }
  return result;
}
