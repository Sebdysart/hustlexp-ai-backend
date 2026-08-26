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
  draft_poster_id: string | null;
  lead_user_id: string | null;
  materialized?: LockedMaterializedContext;
}

interface LockedMaterializedContext {
  task_id: string;
  task_poster_id: string;
  task_worker_id: string | null;
  task_business_fulfiller_id: string | null;
  task_provider_organization_id: string | null;
  task_provider_service_profile_id: string | null;
  task_provider_assignment_id: string | null;
  task_payout_recipient_user_id: string | null;
  task_state: string;
  task_progress_state: string;
  task_matched_at: Date | null;
  task_live_broadcast_started_at: Date | null;
  task_live_broadcast_expired_at: Date | null;
  task_accepted_at: Date | null;
  task_proof_submitted_at: Date | null;
  task_completed_at: Date | null;
  task_cancelled_at: Date | null;
  task_expired_at: Date | null;
  escrow_id: string;
  escrow_state: string;
  escrow_amount_cents: number;
  escrow_provider_payment_id: string | null;
  escrow_transfer_id: string | null;
  escrow_refund_id: string | null;
  escrow_funded_at: Date | null;
  escrow_released_at: Date | null;
  escrow_refunded_at: Date | null;
}

interface RecoveryOperation {
  id: string;
  quote_payment_id: string;
  actor_id: string;
  reason_code: QuotePaymentRecoveryReason;
  expected_status: PaymentStatus;
  expected_payment_version_matches: boolean;
  operation_state: 'CLAIMED' | 'COMPLETED' | 'RECONCILIATION_REQUIRED';
  claim_token: string;
  correlation_id: string;
  lease_expired: boolean;
  recovery_action: RecoveryAction | null;
  provider_status: string | null;
  provider_operation_id: string | null;
  idempotency_key: string;
  initial_claim_evidence_matches: boolean;
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
            qp.amount_cents, qp.status,
            d.poster_user_id AS draft_poster_id,
            l.user_id AS lead_user_id
     FROM quote_payments qp
     JOIN quotes q ON q.id = qp.quote_id
     JOIN task_drafts d ON d.id = q.task_draft_id
     JOIN leads l ON l.id = d.lead_id
     WHERE qp.quote_id = $1
       AND qp.quote_version_id = $2
       AND qp.provider_payment_id = $3
     ${lock ? 'FOR UPDATE OF qp, d, l' : ''}`,
    [input.quoteId, input.quoteVersionId, input.paymentIntentId],
  );
  return result.rows[0];
}

async function lockMaterializedContext(
  query: QueryFn,
  payment: LockedQuotePayment,
): Promise<LockedQuotePayment> {
  if (!payment.task_id) return payment;

  const result = await query<LockedMaterializedContext>(
    `SELECT task.id AS task_id,
            task.poster_id AS task_poster_id,
            task.worker_id AS task_worker_id,
            task.business_fulfiller_organization_id AS task_business_fulfiller_id,
            task.provider_organization_id AS task_provider_organization_id,
            task.provider_service_profile_id AS task_provider_service_profile_id,
            task.provider_assignment_id AS task_provider_assignment_id,
            task.payout_recipient_user_id AS task_payout_recipient_user_id,
            task.state AS task_state,
            task.progress_state AS task_progress_state,
            task.matched_at AS task_matched_at,
            task.live_broadcast_started_at AS task_live_broadcast_started_at,
            task.live_broadcast_expired_at AS task_live_broadcast_expired_at,
            task.accepted_at AS task_accepted_at,
            task.proof_submitted_at AS task_proof_submitted_at,
            task.completed_at AS task_completed_at,
            task.cancelled_at AS task_cancelled_at,
            task.expired_at AS task_expired_at,
            escrow.id AS escrow_id,
            escrow.state AS escrow_state,
            escrow.amount AS escrow_amount_cents,
            escrow.stripe_payment_intent_id AS escrow_provider_payment_id,
            escrow.stripe_transfer_id AS escrow_transfer_id,
            escrow.stripe_refund_id AS escrow_refund_id,
            escrow.funded_at AS escrow_funded_at,
            escrow.released_at AS escrow_released_at,
            escrow.refunded_at AS escrow_refunded_at
     FROM tasks task
     JOIN escrows escrow ON escrow.task_id = task.id
     WHERE task.id = $1
     FOR UPDATE OF task, escrow`,
    [payment.task_id],
  );

  if (result.rows.length !== 1) return payment;
  return { ...payment, materialized: result.rows[0] };
}

function ineligiblePayment(
  payment: LockedQuotePayment | undefined,
  actorId: string,
): Extract<ServiceResult<never>, { success: false }> | null {
  if (!payment) {
    return failure('QUOTE_PAYMENT_NOT_FOUND', 'Quote payment was not found.');
  }
  if (
    !payment.draft_poster_id
    || !payment.lead_user_id
    || payment.draft_poster_id !== payment.lead_user_id
    || payment.draft_poster_id !== actorId
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
  return null;
}

function ineligibleMaterializedContext(
  payment: LockedQuotePayment,
  actorId: string,
): Extract<ServiceResult<never>, { success: false }> | null {
  if (!payment.task_id) return null;

  const context = payment.materialized;
  if (!context || context.task_id !== payment.task_id || !context.escrow_id) {
    return failure(
      'QUOTE_PAYMENT_CANONICAL_CONTEXT_MISSING',
      'Materialized quote payment recovery requires one locked canonical task and escrow.',
    );
  }
  if (context.task_poster_id !== actorId) {
    return failure(
      'QUOTE_PAYMENT_TASK_POSTER_MISMATCH',
      'The canonical task does not belong to the authenticated poster.',
    );
  }
  if (
    context.task_worker_id !== null
    || context.task_business_fulfiller_id !== null
    || context.task_provider_organization_id !== null
    || context.task_provider_service_profile_id !== null
    || context.task_provider_assignment_id !== null
    || context.task_payout_recipient_user_id !== null
    || context.task_state !== 'OPEN'
    || context.task_progress_state !== 'POSTED'
    || context.task_matched_at !== null
    || context.task_live_broadcast_started_at !== null
    || context.task_live_broadcast_expired_at !== null
    || context.task_accepted_at !== null
    || context.task_proof_submitted_at !== null
    || context.task_completed_at !== null
    || context.task_cancelled_at !== null
    || context.task_expired_at !== null
  ) {
    return failure(
      'QUOTE_PAYMENT_TASK_NOT_INERT',
      'Canonical task progress or provider assignment forbids automatic payment recovery.',
    );
  }
  if (
    context.escrow_state !== 'PENDING'
    || Number(context.escrow_amount_cents) !== Number(payment.amount_cents)
    || (
      context.escrow_provider_payment_id !== null
      && context.escrow_provider_payment_id !== payment.provider_payment_id
    )
    || context.escrow_transfer_id !== null
    || context.escrow_refund_id !== null
    || context.escrow_funded_at !== null
    || context.escrow_released_at !== null
    || context.escrow_refunded_at !== null
  ) {
    return failure(
      'QUOTE_PAYMENT_ESCROW_BINDING_MISMATCH',
      'Canonical escrow state or processor binding forbids automatic payment recovery.',
    );
  }
  return null;
}

function recoveryWitnessKey(payment: LockedQuotePayment): string {
  if (!payment.task_id || !payment.materialized) {
    return `quote-payment-recovery:${payment.id}`;
  }
  return [
    'quote-payment-recovery',
    payment.id,
    'task',
    payment.task_id,
    'escrow',
    payment.materialized.escrow_id,
  ].join(':');
}

function sameMaterializedWitness(
  claimed: LockedQuotePayment,
  current: LockedQuotePayment,
): boolean {
  if (claimed.task_id !== current.task_id) return false;
  if (!claimed.task_id) return !claimed.materialized && !current.materialized;
  return Boolean(
    claimed.materialized
    && current.materialized
    && claimed.materialized.task_id === current.materialized.task_id
    && claimed.materialized.escrow_id === current.materialized.escrow_id
  );
}

async function readOperation(
  query: QueryFn,
  quotePaymentId: string,
): Promise<RecoveryOperation | undefined> {
  const result = await query<RecoveryOperation>(
    `SELECT operation.id, operation.quote_payment_id, operation.actor_id,
            operation.reason_code, operation.expected_status,
            operation.expected_payment_updated_at = (
              SELECT payment.updated_at
              FROM quote_payments payment
              WHERE payment.id = operation.quote_payment_id
            ) AS expected_payment_version_matches,
            operation.operation_state, operation.claim_token, operation.correlation_id,
            operation.lease_expires_at <= NOW() AS lease_expired,
            operation.recovery_action, operation.provider_status,
            operation.provider_operation_id, operation.idempotency_key,
            EXISTS (
              SELECT 1
              FROM quote_payment_recovery_events claimed
              WHERE claimed.recovery_operation_id = operation.id
                AND claimed.quote_payment_id = operation.quote_payment_id
                AND claimed.actor_id = operation.actor_id
                AND claimed.event_type = 'CLAIMED'
                AND claimed.reason_code = operation.reason_code
                AND claimed.from_status = operation.expected_status
                AND claimed.canonical_status = operation.expected_status
                AND claimed.idempotency_key = operation.idempotency_key || ':claim'
            ) AS initial_claim_evidence_matches
     FROM quote_payment_recovery_operations operation
     WHERE operation.quote_payment_id = $1
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
       AND actor_id = $7
       AND reason_code = $8
       AND from_status = $9
       AND idempotency_key = $11
       AND EXISTS (
         SELECT 1
         FROM quote_payment_recovery_events claimed
         WHERE claimed.recovery_operation_id = $1
           AND claimed.quote_payment_id = $2
           AND claimed.actor_id = $7
           AND claimed.event_type = 'CLAIMED'
           AND claimed.reason_code = $8
           AND claimed.from_status = $9
           AND claimed.canonical_status = $9
           AND claimed.idempotency_key = $10
       )
     LIMIT 1`,
    [
      operation.id,
      payment.id,
      expectedAction,
      payment.status,
      operation.provider_status,
      operation.provider_operation_id,
      input.posterId,
      input.reasonCode,
      operation.expected_status,
      `${recoveryWitnessKey(payment)}:claim`,
      `quote-payment-recovery:${operation.id}:completed`,
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
    const lockedPayment = await readPayment(query, input, true);
    const paymentFailure = ineligiblePayment(lockedPayment, input.posterId);
    if (paymentFailure) return paymentFailure;
    if (!lockedPayment) return failure('QUOTE_PAYMENT_NOT_FOUND', 'Quote payment was not found.');

    const payment = lockedPayment;

    const existing = await readOperation(query, payment.id);
    const witnessKey = recoveryWitnessKey(payment);
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
    if (payment.task_id) {
      // A fresh task-bound command is forbidden. The sole exception is a
      // taskless CLAIMED command whose immutable claim committed first, whose
      // lease has since expired, and whose payment version changed when the
      // task was bound. Resuming that exact operation lets the idempotent
      // provider observation be recorded as reconciliation-required; it does
      // not authorize a new operation or a canonical task/escrow mutation.
      const exactPriorTasklessClaim = Boolean(
        existing
        && existing.quote_payment_id === payment.id
        && existing.operation_state === 'CLAIMED'
        && existing.expected_status === 'PENDING'
        && payment.status === 'PENDING'
        && !existing.expected_payment_version_matches
        && existing.initial_claim_evidence_matches
        && existing.idempotency_key === `quote-payment-recovery:${payment.id}`
      );
      if (!exactPriorTasklessClaim) {
        return failure(
          'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
          'Task-bound recovery may resume only the exact prior taskless recovery command.',
        );
      }
    }
    if (existing && existing.idempotency_key !== witnessKey) {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
        'The durable recovery command does not match the locked task and escrow witness.',
      );
    }
    if (payment.task_id && existing && existing.expected_status !== 'PENDING') {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
        'Materialized recovery must originate from a pending quote payment.',
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
    if (payment.task_id && payment.status !== 'PENDING') {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_RECONCILIATION_REQUIRED',
        'A materialized quote payment without terminal recovery evidence requires reconciliation.',
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
        `${witnessKey}:claim:${claimToken}`,
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
       ) VALUES (
         $1, $2, $3, $4,
         (SELECT updated_at FROM quote_payments WHERE id = $1),
         $5, $6, NOW() + INTERVAL '5 minutes', $7
       )
       RETURNING id`,
      [
        payment.id,
        input.posterId,
        input.reasonCode,
        payment.status,
        claimToken,
        correlationId,
        witnessKey,
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
      `${witnessKey}:claim`,
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
    // Match claimRecovery lock order: quote payment first, then its canonical
    // task/escrow witness, and finally the recovery operation. Reversing these
    // locks permits a retry and phase-two finalizer to deadlock after the
    // processor effect has succeeded.
    const lockedPayment = await readPayment(query, input, true);
    if (!lockedPayment) throw new Error('QUOTE_PAYMENT_NOT_FOUND_AFTER_PROVIDER_RECOVERY');
    const payment = await lockMaterializedContext(query, lockedPayment);

    const operation = await query<RecoveryOperation>(
      `SELECT operation.id, operation.quote_payment_id, operation.actor_id,
              operation.reason_code, operation.expected_status,
              operation.expected_payment_updated_at = (
                SELECT payment.updated_at
                FROM quote_payments payment
                WHERE payment.id = operation.quote_payment_id
              ) AS expected_payment_version_matches,
              operation.operation_state, operation.claim_token,
              operation.correlation_id, false AS lease_expired,
              operation.recovery_action, operation.provider_status,
              operation.provider_operation_id, operation.idempotency_key,
              false AS initial_claim_evidence_matches
       FROM quote_payment_recovery_operations operation
       WHERE operation.id = $1
         AND operation.claim_token = $2
       FOR UPDATE`,
      [claim.operationId, claim.claimToken],
    );
    if (!operation.rows[0] || operation.rows[0].operation_state !== 'CLAIMED') {
      return failure(
        'QUOTE_PAYMENT_RECOVERY_STALE_CLAIM',
        'Quote payment recovery processor lease is no longer authoritative.',
      );
    }
    const paymentFailure = ineligiblePayment(payment, input.posterId);
    const materializedFailure = ineligibleMaterializedContext(payment, input.posterId);
    const currentOperation = operation.rows[0];
    const witnessDrift = !sameMaterializedWitness(claim.payment, payment)
      || currentOperation.quote_payment_id !== payment.id
      || currentOperation.actor_id !== input.posterId
      || currentOperation.reason_code !== input.reasonCode
      || currentOperation.expected_status !== claim.payment.status
      || currentOperation.idempotency_key !== recoveryWitnessKey(claim.payment)
      || currentOperation.idempotency_key !== recoveryWitnessKey(payment);
    if (paymentFailure || materializedFailure || witnessDrift) {
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
    if (
      (
        payment.status !== claim.payment.status
        || !operation.rows[0].expected_payment_version_matches
      )
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
      const materialized = payment.materialized;
      const updatedPayment = payment.task_id && materialized
        ? await query<{ id: string }>(
            `UPDATE quote_payments AS payment
             SET status = $1, updated_at = NOW()
             WHERE payment.id = $2
               AND payment.task_id = $5
               AND payment.status = $3
               AND payment.updated_at = (
                 SELECT expected_payment_updated_at
                 FROM quote_payment_recovery_operations
                 WHERE id = $4
               )
               AND EXISTS (
                 SELECT 1
                 FROM tasks task
                 JOIN escrows escrow ON escrow.task_id = task.id
                 WHERE task.id = $5
                   AND task.poster_id = $6
                   AND task.worker_id IS NULL
                   AND task.business_fulfiller_organization_id IS NULL
                   AND task.provider_organization_id IS NULL
                   AND task.provider_service_profile_id IS NULL
                   AND task.provider_assignment_id IS NULL
                   AND task.payout_recipient_user_id IS NULL
                   AND task.state = 'OPEN'
                   AND task.progress_state = 'POSTED'
                   AND task.matched_at IS NULL
                   AND task.live_broadcast_started_at IS NULL
                   AND task.live_broadcast_expired_at IS NULL
                   AND task.accepted_at IS NULL
                   AND task.proof_submitted_at IS NULL
                   AND task.completed_at IS NULL
                   AND task.cancelled_at IS NULL
                   AND task.expired_at IS NULL
                   AND escrow.id = $7
                   AND escrow.state = 'PENDING'
                   AND escrow.amount = payment.amount_cents
                   AND (
                     escrow.stripe_payment_intent_id IS NULL
                     OR escrow.stripe_payment_intent_id = payment.provider_payment_id
                   )
                   AND escrow.stripe_transfer_id IS NULL
                   AND escrow.stripe_refund_id IS NULL
                   AND escrow.funded_at IS NULL
                   AND escrow.released_at IS NULL
                   AND escrow.refunded_at IS NULL
               )
             RETURNING payment.id`,
            [
              nextStatus,
              payment.id,
              claim.payment.status,
              claim.operationId,
              payment.task_id,
              input.posterId,
              materialized.escrow_id,
            ],
          )
        : await query<{ id: string }>(
            `UPDATE quote_payments
             SET status = $1, updated_at = NOW()
             WHERE id = $2
               AND task_id IS NULL
               AND status = $3
               AND updated_at = (
                 SELECT expected_payment_updated_at
                 FROM quote_payment_recovery_operations
                 WHERE id = $4
               )
             RETURNING id`,
            [nextStatus, payment.id, claim.payment.status, claim.operationId],
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

    return await finalizeRecovery(input, claim, recovered.data);
  } catch {
    return failure(
      'QUOTE_PAYMENT_RECOVERY_FAILED',
      'Quote payment recovery could not be completed.',
    );
  }
}
