import { db, type QueryFn } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { logger } from '../logger.js';
import { StripePaymentIntentCancellationService } from './StripePaymentIntentCancellationService.js';

const log = logger.child({ module: 'automation', service: 'PendingPaymentCancellationService' });

export interface PendingPaymentCancellationInput {
  escrowId: string;
  taskId: string;
  reason: string;
}

interface LockedEscrow {
  id: string;
  task_id: string;
  version: number;
  state: string;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  payment_intent_canceled_at: Date | string | null;
  task_version: number;
  task_state: string;
  task_worker_id: string | null;
}

interface CancellationEvidencePayload {
  event_type: 'pending_payment_intent_canceled_v1';
  reason: string;
  escrow_id: string;
  task_id: string;
  payment_intent_id: string;
  provider_status: 'canceled';
  idempotency_replayed: boolean;
  escrow_version_before: number;
  escrow_version_after: number;
  task_version_before: number;
  task_version_after: number;
}

async function loadCancellationBinding(
  query: QueryFn,
  escrowId: string,
  lock: boolean,
): Promise<LockedEscrow | null> {
  const result = await query<LockedEscrow>(
    `SELECT e.id,e.task_id,e.version,e.state,e.stripe_payment_intent_id,
            e.stripe_refund_id,e.payment_intent_canceled_at,
            t.version AS task_version,t.state AS task_state,t.worker_id AS task_worker_id
       FROM escrows e
       JOIN tasks t ON t.id=e.task_id
      WHERE e.id=$1
      ${lock ? 'FOR UPDATE OF e,t' : ''}`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

function assertPaymentIntent(escrow: LockedEscrow): string {
  if (!escrow.stripe_payment_intent_id) {
    throw new Error(`Escrow ${escrow.id} has no stripe_payment_intent_id to cancel`);
  }
  return escrow.stripe_payment_intent_id;
}

async function markAlreadyRefunded(query: QueryFn, taskId: string): Promise<void> {
  await query(
    `UPDATE tasks SET refund_state = 'REFUNDED', refund_blocker = NULL, updated_at = NOW()
     WHERE id = $1`,
    [taskId],
  );
}

async function lockForRefund(query: QueryFn, escrow: LockedEscrow): Promise<void> {
  if (escrow.state === 'LOCKED_DISPUTE') return;
  const transitioned = await query<{ id: string }>(
    `UPDATE escrows SET state = 'LOCKED_DISPUTE', version = version + 1, updated_at = NOW()
     WHERE id = $1 AND state = $2 RETURNING id`,
    [escrow.id, escrow.state],
  );
  if ((transitioned.rowCount ?? 0) !== 1) {
    throw new Error(`Escrow ${escrow.id} changed during cancellation-to-refund transition`);
  }
}

async function queueRefund(
  query: QueryFn,
  escrow: LockedEscrow,
  taskId: string,
  reason: string,
): Promise<void> {
  await writeToOutbox({
    eventType: 'escrow.refund_requested',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    payload: { escrow_id: escrow.id, task_id: taskId, reason },
    queueName: 'critical_payments',
    idempotencyKey: `dispatch-expiry-refund:${taskId}`,
  }, query);
  await query(
    `UPDATE tasks SET refund_state = 'PENDING', refund_blocker = NULL,
            refund_requested_at = COALESCE(refund_requested_at, NOW()), updated_at = NOW()
     WHERE id = $1`,
    [taskId],
  );
  await query(
    `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
     VALUES ($1, 'PAYMENT_INTENT_SUCCEEDED_DURING_EXPIRY', $2, $3::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [taskId, `dispatch-expiry-funded-race:${taskId}`, JSON.stringify({ reason })],
  );
}

async function escalateToRefund(input: PendingPaymentCancellationInput): Promise<void> {
  await db.transaction(async (query) => {
    const escrow = await loadCancellationBinding(query, input.escrowId, true);
    if (!escrow) throw new Error(`Escrow ${input.escrowId} not found during cancellation reconciliation`);
    if (escrow.task_id !== input.taskId) {
      throw new Error(`Escrow ${input.escrowId} does not belong to task ${input.taskId}`);
    }
    if (escrow.state === 'REFUNDED' || escrow.stripe_refund_id) {
      await markAlreadyRefunded(query, input.taskId);
      return;
    }
    if (!['PENDING', 'FUNDED', 'LOCKED_DISPUTE'].includes(escrow.state)) {
      throw new Error(`Cannot move escrow ${escrow.id} from ${escrow.state} onto the refund rail`);
    }
    await lockForRefund(query, escrow);
    await queueRefund(query, escrow, input.taskId, input.reason);
  });
}

async function persistCancellation(
  input: PendingPaymentCancellationInput,
  binding: LockedEscrow,
  providerStatus: string,
  idempotencyReplayed: boolean,
): Promise<void> {
  const paymentIntentId = assertPaymentIntent(binding);
  await db.transaction(async (query) => {
    const updated = await query<{ id: string; version: number }>(
      `UPDATE escrows
       SET payment_intent_canceled_at = COALESCE(payment_intent_canceled_at, NOW()),
           version = version + CASE WHEN payment_intent_canceled_at IS NULL THEN 1 ELSE 0 END,
           updated_at = NOW()
       WHERE id = $1 AND task_id = $2 AND state = 'PENDING'
         AND stripe_payment_intent_id = $3 AND version = $4
       RETURNING id,version`,
      [input.escrowId, input.taskId, paymentIntentId, binding.version],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error(`Escrow ${input.escrowId} changed before PaymentIntent cancellation persisted`);
    }
    const task = await query<{ version: number }>(
      `UPDATE tasks SET refund_state = 'NOT_REQUIRED', refund_blocker = NULL, updated_at = NOW()
       WHERE id = $1 AND version = $2 AND state = $3
         AND worker_id IS NOT DISTINCT FROM $4
         AND (state = 'CANCELLED' OR (state = 'EXPIRED' AND expiration_reason = 'UNFILLED'))
       RETURNING version`,
      [input.taskId, binding.task_version, binding.task_state, binding.task_worker_id],
    );
    if ((task.rowCount ?? 0) !== 1) {
      throw new Error(`Task ${input.taskId} changed before PaymentIntent cancellation persisted`);
    }

    const eventKey = `pending-payment-intent-canceled-v1:${input.escrowId}:${paymentIntentId}`;
    const eventPayload = {
      event_type: 'pending_payment_intent_canceled_v1',
      reason: input.reason,
      escrow_id: input.escrowId,
      task_id: input.taskId,
      payment_intent_id: paymentIntentId,
      provider_status: providerStatus,
      idempotency_replayed: idempotencyReplayed,
      escrow_version_before: binding.version,
      escrow_version_after: updated.rows[0].version,
      task_version_before: binding.task_version,
      task_version_after: task.rows[0].version,
    };
    const evidence = await query<{ exact: boolean }>(
      `WITH desired(payload) AS (VALUES ($3::jsonb)), attempted AS (
         INSERT INTO engine_automation_events (task_id,event_type,idempotency_key,payload)
         VALUES ($1,'PAYMENT_INTENT_CANCELED',$2,$3::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id
       )
       SELECT COUNT(*)=1 AS exact
         FROM engine_automation_events event,desired
        WHERE event.task_id=$1 AND event.event_type='PAYMENT_INTENT_CANCELED'
          AND event.idempotency_key=$2 AND event.payload=desired.payload`,
      [
        input.taskId,
        eventKey,
        JSON.stringify(eventPayload),
      ],
    );
    if (evidence.rows.length !== 1 || evidence.rows[0].exact !== true) {
      throw new Error(`PaymentIntent cancellation evidence conflicts for escrow ${input.escrowId}`);
    }
  });
}

function exactPersistedCancellationEvidence(
  value: unknown,
  input: PendingPaymentCancellationInput,
  binding: LockedEscrow,
  paymentIntentId: string,
): value is CancellationEvidencePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<CancellationEvidencePayload>;
  const exactKeys = [
    'escrow_id',
    'escrow_version_after',
    'escrow_version_before',
    'event_type',
    'idempotency_replayed',
    'payment_intent_id',
    'provider_status',
    'reason',
    'task_id',
    'task_version_after',
    'task_version_before',
  ];
  return JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(exactKeys)
    && payload.event_type === 'pending_payment_intent_canceled_v1'
    && payload.reason === input.reason
    && payload.escrow_id === input.escrowId
    && payload.task_id === input.taskId
    && payload.payment_intent_id === paymentIntentId
    && payload.provider_status === 'canceled'
    && typeof payload.idempotency_replayed === 'boolean'
    && payload.escrow_version_before === binding.version - 1
    && payload.escrow_version_after === binding.version
    && payload.task_version_before === binding.task_version
    && payload.task_version_after === binding.task_version;
}

async function requirePersistedCancellation(
  input: PendingPaymentCancellationInput,
): Promise<void> {
  await db.transaction(async (query) => {
    const binding = await loadCancellationBinding(query, input.escrowId, true);
    if (!binding || binding.task_id !== input.taskId || binding.state !== 'PENDING'
      || !binding.payment_intent_canceled_at) {
      throw new Error(`PaymentIntent cancellation binding changed for escrow ${input.escrowId}`);
    }
    const paymentIntentId = assertPaymentIntent(binding);
    const eventKey = `pending-payment-intent-canceled-v1:${input.escrowId}:${paymentIntentId}`;
    const evidence = await query<{ payload: unknown }>(
      `SELECT payload
         FROM engine_automation_events
        WHERE task_id=$1 AND event_type='PAYMENT_INTENT_CANCELED'
          AND idempotency_key=$2`,
      [input.taskId, eventKey],
    );
    if (
      evidence.rows.length !== 1
      || !exactPersistedCancellationEvidence(
        evidence.rows[0]?.payload,
        input,
        binding,
        paymentIntentId,
      )
    ) {
      throw new Error(`PaymentIntent cancellation evidence conflicts for escrow ${input.escrowId}`);
    }
  });
}

export const PendingPaymentCancellationService = {
  execute: async (input: PendingPaymentCancellationInput): Promise<void> => {
    const escrow = await db.transaction((query) => (
      loadCancellationBinding(query, input.escrowId, true)
    ));
    if (!escrow) throw new Error(`Escrow ${input.escrowId} not found`);
    if (escrow.task_id !== input.taskId) {
      throw new Error(`Escrow ${input.escrowId} does not belong to task ${input.taskId}`);
    }
    const paymentIntentId = assertPaymentIntent(escrow);
    if (escrow.state !== 'PENDING') return await escalateToRefund(input);
    if (escrow.payment_intent_canceled_at) {
      return await requirePersistedCancellation(input);
    }
    const canceled = await StripePaymentIntentCancellationService.cancel(paymentIntentId);
    if (!canceled.success) {
      log.error({ escrowId: input.escrowId, code: canceled.error.code }, 'PaymentIntent cancellation failed');
      throw new Error(`Failed to cancel PaymentIntent: ${canceled.error.message}`);
    }
    if (!canceled.data.canceled) return await escalateToRefund(input);
    if (
      canceled.data.paymentIntentId !== paymentIntentId
      || canceled.data.status !== 'canceled'
    ) {
      throw new Error(`PaymentIntent cancellation witness does not match escrow ${input.escrowId}`);
    }
    await persistCancellation(
      input,
      escrow,
      canceled.data.status,
      canceled.data.idempotencyReplayed,
    );
  },
};

export default PendingPaymentCancellationService;
