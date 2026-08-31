import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  LEGACY_QUOTE_PAYMENT_TOMBSTONED_CODE,
  LEGACY_QUOTE_PAYMENT_TOMBSTONED_MESSAGE,
  newPaymentCreationFailure,
} from './NewPaymentCreationGuard.js';

interface FinalizePaidQuoteInput {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  /** Historical compatibility reference. New pay-first materialization is retired. */
  paymentIntentId: string;
}

interface FinalizePaidQuoteResult {
  taskId: string;
  escrowId: string;
  quoteId: string;
  quoteVersionId: string;
  paymentIntentId: string;
  replayed: true;
}

function tombstone(): Extract<ServiceResult<never>, { success: false }> {
  return (
    newPaymentCreationFailure('quote_materialization') ?? {
      success: false,
      error: {
        code: LEGACY_QUOTE_PAYMENT_TOMBSTONED_CODE,
        message: LEGACY_QUOTE_PAYMENT_TOMBSTONED_MESSAGE,
      },
    }
  );
}

/**
 * Read-only compatibility replay for a quote that was materialized before the
 * Universal V1 lifecycle became authoritative.
 *
 * No nonmaterialized payment may create a Task, fund escrow, or mutate quote
 * state here. Existing orphan value must use the bounded recovery rail.
 */
export async function finalizePaidQuote(
  input: FinalizePaidQuoteInput
): Promise<ServiceResult<FinalizePaidQuoteResult>> {
  try {
    const replay = await db.query<{ task_id: string; escrow_id: string }>(
      `
      SELECT qp.task_id, e.id AS escrow_id
      FROM quote_payments qp
      JOIN tasks t ON t.id = qp.task_id
      JOIN escrows e ON e.task_id = qp.task_id
      WHERE qp.quote_id = $1
        AND qp.quote_version_id = $2
        AND qp.provider_payment_id = $3
        AND qp.status = 'SUCCEEDED'
        AND qp.task_id IS NOT NULL
        AND t.poster_id = $4
        AND NOT EXISTS (
          SELECT 1
          FROM quote_payment_recovery_operations recovery
          WHERE recovery.quote_payment_id = qp.id
        )
      ORDER BY e.created_at DESC
      LIMIT 1
      `,
      [input.quoteId, input.quoteVersionId, input.paymentIntentId, input.posterId]
    );

    if (!replay.rows[0]) return tombstone();

    return {
      success: true,
      data: {
        taskId: replay.rows[0].task_id,
        escrowId: replay.rows[0].escrow_id,
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        paymentIntentId: input.paymentIntentId,
        replayed: true,
      },
    };
  } catch {
    return {
      success: false,
      error: {
        code: 'QUOTE_FINALIZATION_REPLAY_FAILED',
        message: 'Unable to verify the historical quote materialization replay.',
      },
    };
  }
}
