import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { newPaymentCreationMode } from './NewPaymentCreationGuard.js';
import {
  StripeQuotePaymentProvider,
} from './payment/StripeQuotePaymentProvider.js';
import type {
  QuotePaymentProvider,
  QuotePaymentRecoveryReason,
} from './payment/QuotePaymentProvider.js';

export interface RecoverOrphanQuotePaymentInput {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  paymentIntentId: string;
  reasonCode: QuotePaymentRecoveryReason;
}

interface LockedQuotePayment {
  id: string;
  task_id: string | null;
  provider: string;
  provider_payment_id: string;
  amount_cents: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  poster_email: string;
  lead_email: string;
}

export interface QuotePaymentRecoveryResult {
  quoteId: string;
  quoteVersionId: string;
  paymentIntentId: string;
  status: 'FAILED' | 'REFUNDED';
  recoveryAction: 'VOIDED' | 'REFUNDED';
  replayed: boolean;
}

function failure<T>(
  code: string,
  message: string,
): Extract<ServiceResult<T>, { success: false }> {
  return { success: false, error: { code, message } };
}

async function readPayment(
  query: QueryFn,
  input: RecoverOrphanQuotePaymentInput,
  lock: boolean,
): Promise<LockedQuotePayment | undefined> {
  const result = await query<LockedQuotePayment>(
    `SELECT qp.id, qp.task_id, qp.provider, qp.provider_payment_id,
            qp.amount_cents, qp.status, u.email AS poster_email,
            l.email AS lead_email
     FROM quote_payments qp
     JOIN quotes q ON q.id = qp.quote_id
     JOIN task_drafts d ON d.id = q.task_draft_id
     JOIN leads l ON l.id = d.lead_id
     JOIN users u ON u.id = $4
     WHERE qp.quote_id = $1
       AND qp.quote_version_id = $2
       AND qp.provider_payment_id = $3
     ${lock ? 'FOR UPDATE OF qp' : ''}`,
    [input.quoteId, input.quoteVersionId, input.paymentIntentId, input.posterId],
  );
  return result.rows[0];
}

function ineligiblePayment(
  payment: LockedQuotePayment | undefined,
): Extract<ServiceResult<never>, { success: false }> | null {
  if (!payment) {
    return failure('QUOTE_PAYMENT_NOT_FOUND', 'Quote payment was not found.');
  }
  if (
    payment.poster_email.trim().toLowerCase()
    !== payment.lead_email.trim().toLowerCase()
  ) {
    return failure(
      'QUOTE_PAYMENT_POSTER_MISMATCH',
      'This quote payment does not belong to the authenticated poster.',
    );
  }
  if (payment.provider !== 'stripe') {
    return failure(
      'QUOTE_PAYMENT_PROVIDER_MISMATCH',
      'Quote payment recovery provider does not match the recorded provider.',
    );
  }
  if (payment.task_id) {
    return failure(
      'QUOTE_PAYMENT_ALREADY_MATERIALIZED',
      'Materialized payments must use the canonical task and escrow recovery lane.',
    );
  }
  return null;
}

function replayResult(
  input: RecoverOrphanQuotePaymentInput,
  payment: LockedQuotePayment,
): ServiceResult<QuotePaymentRecoveryResult> | null {
  if (payment.status !== 'FAILED' && payment.status !== 'REFUNDED') return null;
  return {
    success: true,
    data: {
      quoteId: input.quoteId,
      quoteVersionId: input.quoteVersionId,
      paymentIntentId: input.paymentIntentId,
      status: payment.status,
      recoveryAction: payment.status === 'FAILED' ? 'VOIDED' : 'REFUNDED',
      replayed: true,
    },
  };
}

export async function recoverOrphanQuotePayment(
  input: RecoverOrphanQuotePaymentInput,
  provider: QuotePaymentProvider = StripeQuotePaymentProvider,
): Promise<ServiceResult<QuotePaymentRecoveryResult>> {
  try {
    if (newPaymentCreationMode() !== 'frozen') {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_NOT_AVAILABLE',
        'Legacy quote payment recovery is available only while new payment creation is frozen.',
      );
    }

    const initial = await readPayment(db.query, input, false);
    const initialFailure = ineligiblePayment(initial);
    if (initialFailure) return initialFailure;
    if (!initial) return failure('QUOTE_PAYMENT_NOT_FOUND', 'Quote payment was not found.');
    const initialReplay = replayResult(input, initial);
    if (initialReplay) return initialReplay;

    const recovered = await provider.recoverOrphanPayment({
      quoteId: input.quoteId,
      quoteVersionId: input.quoteVersionId,
      posterId: input.posterId,
      paymentIntentId: input.paymentIntentId,
      amountCents: Number(initial.amount_cents),
      recoveryKey: initial.id,
      reasonCode: input.reasonCode,
    });
    if (!recovered.success) return recovered;

    return await db.transaction(async (query) => {
      const payment = await readPayment(query, input, true);
      const lockedFailure = ineligiblePayment(payment);
      if (lockedFailure) return lockedFailure;
      if (!payment) return failure('QUOTE_PAYMENT_NOT_FOUND', 'Quote payment was not found.');

      const nextStatus = recovered.data.disposition === 'VOIDED' ? 'FAILED' : 'REFUNDED';
      const lockedReplay = replayResult(input, payment);
      if (lockedReplay) {
        if (payment.status !== nextStatus) {
          return failure(
            'QUOTE_PAYMENT_RECOVERY_CONFLICT',
            'Quote payment reached a conflicting terminal recovery state.',
          );
        }
        return lockedReplay;
      }
      if (payment.id !== initial.id || payment.status !== initial.status) {
        return failure(
          'QUOTE_PAYMENT_RECOVERY_CONFLICT',
          'Quote payment changed before recovery could be recorded.',
        );
      }
      const updated = await query<{ id: string }>(
        `UPDATE quote_payments
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND task_id IS NULL AND status = $3
         RETURNING id`,
        [nextStatus, payment.id, payment.status],
      );
      if (updated.rowCount !== 1) {
        throw new Error('QUOTE_PAYMENT_RECOVERY_CONFLICT');
      }

      const event = await query<{ id: string }>(
        `INSERT INTO quote_payment_recovery_events (
           quote_payment_id, actor_id, reason_code, recovery_action,
           from_status, to_status, provider_status, provider_operation_id,
           idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          payment.id,
          input.posterId,
          input.reasonCode,
          recovered.data.disposition,
          payment.status,
          nextStatus,
          recovered.data.providerStatus,
          recovered.data.providerOperationId,
          `quote-payment-recovery:${payment.id}:${nextStatus}`,
        ],
      );
      if (event.rowCount !== 1) {
        throw new Error('QUOTE_PAYMENT_RECOVERY_EVENT_CONFLICT');
      }

      return {
        success: true,
        data: {
          quoteId: input.quoteId,
          quoteVersionId: input.quoteVersionId,
          paymentIntentId: input.paymentIntentId,
          status: nextStatus,
          recoveryAction: recovered.data.disposition,
          replayed: false,
        },
      };
    });
  } catch {
    return failure(
      'QUOTE_PAYMENT_RECOVERY_FAILED',
      'Quote payment recovery could not be completed.',
    );
  }
}
