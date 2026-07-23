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
  state: string;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  payment_intent_canceled_at: Date | string | null;
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
    const result = await query<LockedEscrow>(
      `SELECT id, state, stripe_payment_intent_id, stripe_refund_id,
              payment_intent_canceled_at
       FROM escrows WHERE id = $1 FOR UPDATE`,
      [input.escrowId],
    );
    const escrow = result.rows[0];
    if (!escrow) throw new Error(`Escrow ${input.escrowId} not found during cancellation reconciliation`);
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
  paymentIntentId: string,
  providerStatus: string,
  idempotencyReplayed: boolean,
): Promise<void> {
  await db.transaction(async (query) => {
    const updated = await query<{ id: string }>(
      `UPDATE escrows
       SET payment_intent_canceled_at = COALESCE(payment_intent_canceled_at, NOW()),
           version = version + CASE WHEN payment_intent_canceled_at IS NULL THEN 1 ELSE 0 END,
           updated_at = NOW()
       WHERE id = $1 AND state = 'PENDING' AND stripe_payment_intent_id = $2
       RETURNING id`,
      [input.escrowId, paymentIntentId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error(`Escrow ${input.escrowId} changed before PaymentIntent cancellation persisted`);
    }
    await query(
      `UPDATE tasks SET refund_state = 'NOT_REQUIRED', refund_blocker = NULL, updated_at = NOW()
       WHERE id = $1 AND state = 'EXPIRED' AND expiration_reason = 'UNFILLED'`,
      [input.taskId],
    );
    await query(
      `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
       VALUES ($1, 'PAYMENT_INTENT_CANCELED', $2, $3::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.taskId,
        `dispatch-expiry-payment-canceled:${input.taskId}`,
        JSON.stringify({ providerStatus, idempotencyReplayed }),
      ],
    );
  });
}

export const PendingPaymentCancellationService = {
  execute: async (input: PendingPaymentCancellationInput): Promise<void> => {
    const result = await db.query<LockedEscrow>(
      `SELECT id, state, stripe_payment_intent_id, stripe_refund_id,
              payment_intent_canceled_at
       FROM escrows WHERE id = $1`,
      [input.escrowId],
    );
    const escrow = result.rows[0];
    if (!escrow) throw new Error(`Escrow ${input.escrowId} not found`);
    const paymentIntentId = assertPaymentIntent(escrow);
    if (escrow.state !== 'PENDING') return await escalateToRefund(input);
    if (escrow.payment_intent_canceled_at) {
      return await persistCancellation(input, paymentIntentId, 'canceled', true);
    }
    const canceled = await StripePaymentIntentCancellationService.cancel(paymentIntentId);
    if (!canceled.success) {
      log.error({ escrowId: input.escrowId, code: canceled.error.code }, 'PaymentIntent cancellation failed');
      throw new Error(`Failed to cancel PaymentIntent: ${canceled.error.message}`);
    }
    if (!canceled.data.canceled) return await escalateToRefund(input);
    await persistCancellation(
      input,
      paymentIntentId,
      canceled.data.status,
      canceled.data.idempotencyReplayed,
    );
  },
};

export default PendingPaymentCancellationService;
