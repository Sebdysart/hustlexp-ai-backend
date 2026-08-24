import { randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { newPaymentCreationMode } from './NewPaymentCreationGuard.js';
import {
  StripeQuotePaymentProvider,
} from './payment/StripeQuotePaymentProvider.js';
import type {
  QuotePaymentProvider,
  QuotePaymentRecoveryReason,
  RecoverQuotePaymentResult,
} from './payment/QuotePaymentProvider.js';

export interface RecoverOrphanQuotePaymentInput {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  paymentIntentId: string;
  reasonCode: QuotePaymentRecoveryReason;
}

type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
type RecoveryAction = 'VOIDED' | 'REFUNDED';

interface LockedQuotePayment {
  id: string;
  task_id: string | null;
  provider: string;
  provider_payment_id: string;
  amount_cents: number;
  status: PaymentStatus;
  updated_at: Date;
  poster_email: string;
  lead_email: string;
}

interface RecoveryOperation {
  id: string;
  quote_payment_id: string;
  actor_id: string;
  reason_code: QuotePaymentRecoveryReason;
  expected_status: PaymentStatus;
  expected_payment_updated_at: Date;
  operation_state: 'CLAIMED' | 'COMPLETED' | 'RECONCILIATION_REQUIRED';
  claim_token: string;
  correlation_id: string;
  lease_expired: boolean;
  recovery_action: RecoveryAction | null;
  provider_status: string | null;
  provider_operation_id: string | null;
}

interface RecoveryClaim {
  operationId: string;
  claimToken: string;
  payment: LockedQuotePayment;
}

type ClaimOutcome =
  | { kind: 'claimed'; claim: RecoveryClaim }
  | { kind: 'replayed'; result: QuotePaymentRecoveryResult };

export interface QuotePaymentRecoveryResult {
  quoteId: string;
  quoteVersionId: string;
  paymentIntentId: string;
  status: 'FAILED' | 'REFUNDED';
  recoveryAction: RecoveryAction;
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
            qp.amount_cents, qp.status, qp.updated_at, u.email AS poster_email,
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
  allowMaterialized = false,
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
  if (payment.task_id && !allowMaterialized) {
    return failure(
      'QUOTE_PAYMENT_ALREADY_MATERIALIZED',
      'Materialized payments must use the canonical task and escrow recovery lane.',
    );
  }
  return null;
}

async function readOperation(
  query: QueryFn,
  quotePaymentId: string,
): Promise<RecoveryOperation | undefined> {
  const result = await query<RecoveryOperation>(
    `SELECT id, quote_payment_id, actor_id, reason_code, expected_status,
            expected_payment_updated_at, operation_state, claim_token, correlation_id,
            lease_expires_at <= NOW() AS lease_expired,
            recovery_action, provider_status, provider_operation_id
     FROM quote_payment_recovery_operations
     WHERE quote_payment_id = $1
     FOR UPDATE`,
    [quotePaymentId],
  );
  return result.rows[0];
}

function resultFromTerminal(
  input: RecoverOrphanQuotePaymentInput,
  status: 'FAILED' | 'REFUNDED',
  action: RecoveryAction,
  replayed: boolean,
): QuotePaymentRecoveryResult {
  return {
    quoteId: input.quoteId,
    quoteVersionId: input.quoteVersionId,
    paymentIntentId: input.paymentIntentId,
    status,
    recoveryAction: action,
    replayed,
  };
}

async function auditBackedReplay(
  query: QueryFn,
  input: RecoverOrphanQuotePaymentInput,
  payment: LockedQuotePayment,
  operation: RecoveryOperation,
): Promise<ServiceResult<QuotePaymentRecoveryResult> | null> {
  if (operation.operation_state !== 'COMPLETED') return null;
  const expectedAction = payment.status === 'FAILED'
    ? 'VOIDED'
    : payment.status === 'REFUNDED'
      ? 'REFUNDED'
      : null;
  if (
    !expectedAction
    || operation.recovery_action !== expectedAction
    || !operation.provider_status
    || !operation.provider_operation_id
  ) {
    return failure(
      'QUOTE_PAYMENT_RECOVERY_EVIDENCE_MISMATCH',
      'Terminal quote payment state does not match its recovery operation.',
    );
  }
  const evidence = await query<{ id: string }>(
    `SELECT id
     FROM quote_payment_recovery_events
     WHERE recovery_operation_id = $1
       AND quote_payment_id = $2
       AND event_type = 'COMPLETED'
       AND recovery_action = $3
       AND canonical_status = $4
       AND provider_status = $5
       AND provider_operation_id = $6
     LIMIT 1`,
    [
      operation.id,
      payment.id,
      expectedAction,
      payment.status,
      operation.provider_status,
      operation.provider_operation_id,
    ],
  );
  if (!evidence.rows[0]) {
    return failure(
      'QUOTE_PAYMENT_RECOVERY_EVIDENCE_MISSING',
      'Terminal quote payment replay requires matching immutable recovery evidence.',
    );
  }
  return {
    success: true,
    data: resultFromTerminal(
      input,
      payment.status as 'FAILED' | 'REFUNDED',
      expectedAction,
      true,
    ),
  };
}

async function insertClaimEvent(
  query: QueryFn,
  operationId: string,
  payment: LockedQuotePayment,
  input: RecoverOrphanQuotePaymentInput,
  eventType: 'CLAIMED' | 'CLAIM_RENEWED',
  idempotencyKey: string,
): Promise<void> {
  const event = await query<{ id: string }>(
    `INSERT INTO quote_payment_recovery_events (
       recovery_operation_id, quote_payment_id, actor_id, event_type,
       reason_code, from_status, canonical_status, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      operationId,
      payment.id,
      input.posterId,
      eventType,
      input.reasonCode,
      payment.status,
      idempotencyKey,
    ],
  );
  if (event.rowCount !== 1) throw new Error('QUOTE_PAYMENT_RECOVERY_CLAIM_EVENT_CONFLICT');
}

async function claimRecovery(
  input: RecoverOrphanQuotePaymentInput,
): Promise<ServiceResult<ClaimOutcome>> {
  const claimToken = randomUUID();
  const correlationId = randomUUID();
  return db.transaction(async (query) => {
    const payment = await readPayment(query, input, true);
    const paymentFailure = ineligiblePayment(payment, true);
    if (paymentFailure) return paymentFailure;
    if (!payment) return failure('QUOTE_PAYMENT_NOT_FOUND', 'Quote payment was not found.');

    const existing = await readOperation(query, payment.id);
    if (payment.task_id) {
      return existing
        ? failure(
            'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
            'A durable recovery command conflicts with canonical task materialization.',
          )
        : failure(
            'QUOTE_PAYMENT_ALREADY_MATERIALIZED',
            'Materialized payments must use the canonical task and escrow recovery lane.',
          );
    }
    if (existing?.actor_id !== undefined && existing.actor_id !== input.posterId) {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_ACTOR_CONFLICT',
        'Quote payment recovery is owned by a different actor.',
      );
    }
    if (existing?.reason_code !== undefined && existing.reason_code !== input.reasonCode) {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_REASON_CONFLICT',
        'Quote payment recovery reason does not match the durable command.',
      );
    }
    if (existing?.operation_state === 'COMPLETED') {
      const replay = await auditBackedReplay(query, input, payment, existing);
      return replay
        ? replay.success
          ? { success: true, data: { kind: 'replayed', result: replay.data } }
          : replay
        : failure(
            'QUOTE_PAYMENT_RECOVERY_EVIDENCE_MISMATCH',
            'Completed recovery operation does not match canonical state.',
          );
    }
    if (existing?.operation_state === 'RECONCILIATION_REQUIRED') {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
        'Quote payment recovery requires operator reconciliation.',
      );
    }
    if (existing && !existing.lease_expired) {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_IN_PROGRESS',
        'Quote payment recovery already has an active processor lease.',
      );
    }

    if (existing) {
      const renewed = await query<{ id: string }>(
        `UPDATE quote_payment_recovery_operations
         SET claim_token = $2,
             lease_expires_at = NOW() + INTERVAL '5 minutes',
             attempt_count = attempt_count + 1,
             last_error_code = NULL
         WHERE id = $1
           AND operation_state = 'CLAIMED'
         RETURNING id`,
        [existing.id, claimToken],
      );
      if (renewed.rowCount !== 1) throw new Error('QUOTE_PAYMENT_RECOVERY_CLAIM_CONFLICT');
      await insertClaimEvent(
        query,
        existing.id,
        payment,
        input,
        'CLAIM_RENEWED',
        `quote-payment-recovery:${payment.id}:claim:${claimToken}`,
      );
      return {
        success: true,
        data: {
          kind: 'claimed',
          claim: {
            operationId: existing.id,
            claimToken,
            payment: {
              ...payment,
              status: existing.expected_status,
              updated_at: existing.expected_payment_updated_at,
            },
          },
        },
      };
    }

    const operation = await query<{ id: string }>(
      `INSERT INTO quote_payment_recovery_operations (
         quote_payment_id, actor_id, reason_code, expected_status,
         expected_payment_updated_at, claim_token, correlation_id,
         lease_expires_at, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '5 minutes', $8)
       RETURNING id`,
      [
        payment.id,
        input.posterId,
        input.reasonCode,
        payment.status,
        payment.updated_at,
        claimToken,
        correlationId,
        `quote-payment-recovery:${payment.id}`,
      ],
    );
    const operationId = operation.rows[0]?.id;
    if (!operationId) throw new Error('QUOTE_PAYMENT_RECOVERY_CLAIM_CONFLICT');
    await insertClaimEvent(
      query,
      operationId,
      payment,
      input,
      'CLAIMED',
      `quote-payment-recovery:${payment.id}:claim`,
    );
    return {
      success: true,
      data: {
        kind: 'claimed',
        claim: { operationId, claimToken, payment },
      },
    };
  });
}

async function insertTerminalEvent(
  query: QueryFn,
  claim: RecoveryClaim,
  input: RecoverOrphanQuotePaymentInput,
  recovered: RecoverQuotePaymentResult,
  eventType: 'COMPLETED' | 'RECONCILIATION_REQUIRED',
  canonicalStatus: PaymentStatus,
): Promise<void> {
  const event = await query<{ id: string }>(
    `INSERT INTO quote_payment_recovery_events (
       recovery_operation_id, quote_payment_id, actor_id, event_type,
       reason_code, recovery_action, from_status, canonical_status,
       provider_status, provider_operation_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      claim.operationId,
      claim.payment.id,
      input.posterId,
      eventType,
      input.reasonCode,
      recovered.disposition,
      claim.payment.status,
      canonicalStatus,
      recovered.providerStatus,
      recovered.providerOperationId,
      `quote-payment-recovery:${claim.operationId}:${eventType.toLowerCase()}`,
    ],
  );
  if (event.rowCount !== 1) throw new Error('QUOTE_PAYMENT_RECOVERY_EVENT_CONFLICT');
}

async function markReconciliationRequired(
  query: QueryFn,
  claim: RecoveryClaim,
  input: RecoverOrphanQuotePaymentInput,
  recovered: RecoverQuotePaymentResult,
  canonicalStatus: PaymentStatus,
): Promise<Extract<ServiceResult<QuotePaymentRecoveryResult>, { success: false }>> {
  const updated = await query<{ id: string }>(
    `UPDATE quote_payment_recovery_operations
     SET operation_state = 'RECONCILIATION_REQUIRED',
         recovery_action = $3,
         provider_status = $4,
         provider_operation_id = $5,
         last_error_code = 'QUOTE_PAYMENT_RECOVERY_CONFLICT'
     WHERE id = $1
       AND claim_token = $2
       AND operation_state = 'CLAIMED'
     RETURNING id`,
    [
      claim.operationId,
      claim.claimToken,
      recovered.disposition,
      recovered.providerStatus,
      recovered.providerOperationId,
    ],
  );
  if (updated.rowCount !== 1) throw new Error('QUOTE_PAYMENT_RECOVERY_STALE_CLAIM');
  await insertTerminalEvent(
    query,
    claim,
    input,
    recovered,
    'RECONCILIATION_REQUIRED',
    canonicalStatus,
  );
  return failure(
    'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
    'Processor recovery succeeded but canonical state requires operator reconciliation.',
  );
}

async function finalizeRecovery(
  input: RecoverOrphanQuotePaymentInput,
  claim: RecoveryClaim,
  recovered: RecoverQuotePaymentResult,
): Promise<ServiceResult<QuotePaymentRecoveryResult>> {
  return db.transaction(async (query) => {
    // Match claimRecovery and quote materialization lock order: payment first,
    // recovery operation second. Reversing these locks permits a retry and
    // phase-two finalizer to deadlock after the processor effect has succeeded.
    const payment = await readPayment(query, input, true);
    if (!payment) throw new Error('QUOTE_PAYMENT_NOT_FOUND_AFTER_PROVIDER_RECOVERY');

    const operation = await query<RecoveryOperation>(
      `SELECT id, quote_payment_id, actor_id, reason_code, expected_status,
              expected_payment_updated_at, operation_state, claim_token, correlation_id,
              false AS lease_expired,
              recovery_action, provider_status, provider_operation_id
       FROM quote_payment_recovery_operations
       WHERE id = $1
         AND claim_token = $2
       FOR UPDATE`,
      [claim.operationId, claim.claimToken],
    );
    if (!operation.rows[0] || operation.rows[0].operation_state !== 'CLAIMED') {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_STALE_CLAIM',
        'Quote payment recovery processor lease is no longer authoritative.',
      );
    }
    const paymentFailure = ineligiblePayment(payment);
    if (paymentFailure) {
      return markReconciliationRequired(
        query,
        claim,
        input,
        recovered,
        payment.status,
      );
    }

    const nextStatus: 'FAILED' | 'REFUNDED' = recovered.disposition === 'VOIDED'
      ? 'FAILED'
      : 'REFUNDED';
    const expectedTimestampMatches = payment.updated_at.getTime()
      === claim.payment.updated_at.getTime();
    if (
      (payment.status !== claim.payment.status || !expectedTimestampMatches)
      && payment.status !== nextStatus
    ) {
      return markReconciliationRequired(
        query,
        claim,
        input,
        recovered,
        payment.status,
      );
    }

    if (payment.status !== nextStatus) {
      const updatedPayment = await query<{ id: string }>(
        `UPDATE quote_payments
         SET status = $1, updated_at = NOW()
         WHERE id = $2
           AND task_id IS NULL
           AND status = $3
           AND updated_at = $4
         RETURNING id`,
        [nextStatus, payment.id, claim.payment.status, claim.payment.updated_at],
      );
      if (updatedPayment.rowCount !== 1) {
        return markReconciliationRequired(
          query,
          claim,
          input,
          recovered,
          payment.status,
        );
      }
    }

    const completed = await query<{ id: string }>(
      `UPDATE quote_payment_recovery_operations
       SET operation_state = 'COMPLETED',
           recovery_action = $3,
           provider_status = $4,
           provider_operation_id = $5,
           last_error_code = NULL
       WHERE id = $1
         AND claim_token = $2
         AND operation_state = 'CLAIMED'
       RETURNING id`,
      [
        claim.operationId,
        claim.claimToken,
        recovered.disposition,
        recovered.providerStatus,
        recovered.providerOperationId,
      ],
    );
    if (completed.rowCount !== 1) throw new Error('QUOTE_PAYMENT_RECOVERY_STALE_CLAIM');
    await insertTerminalEvent(query, claim, input, recovered, 'COMPLETED', nextStatus);

    return {
      success: true,
      data: resultFromTerminal(
        input,
        nextStatus,
        recovered.disposition,
        payment.status === nextStatus,
      ),
    };
  });
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

    const claimed = await claimRecovery(input);
    if (!claimed.success) return claimed;
    if (claimed.data.kind === 'replayed') {
      return { success: true, data: claimed.data.result };
    }
    const claim = claimed.data.claim;

    const recovered = await provider.recoverOrphanPayment({
      quoteId: input.quoteId,
      quoteVersionId: input.quoteVersionId,
      posterId: input.posterId,
      paymentIntentId: input.paymentIntentId,
      amountCents: Number(claim.payment.amount_cents),
      recoveryKey: claim.payment.id,
      reasonCode: input.reasonCode,
    });
    if (!recovered.success) {
      const normalizedErrorCode = /^[A-Z0-9_]{3,96}$/.test(recovered.error.code)
        ? recovered.error.code
        : 'PAYMENT_RECOVERY_FAILED';
      await db.query(
        `UPDATE quote_payment_recovery_operations
         SET last_error_code = $3
         WHERE id = $1
           AND claim_token = $2
           AND operation_state = 'CLAIMED'`,
        [claim.operationId, claim.claimToken, normalizedErrorCode],
      );
      return recovered;
    }

    return finalizeRecovery(input, claim, recovered.data);
  } catch {
    return failure(
      'QUOTE_PAYMENT_RECOVERY_FAILED',
      'Quote payment recovery could not be completed.',
    );
  }
}
