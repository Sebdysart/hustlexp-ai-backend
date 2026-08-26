import type { Job } from 'bullmq';
import { z } from 'zod';
import { db } from '../db.js';
import { workerLogger } from '../logger.js';
import { PendingPaymentCancellationService } from '../services/PendingPaymentCancellationService.js';
import { requireOutboxDurableKey } from './OutboxIdentity.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'dispatch-expiry-payment-cancel' });

const PayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  reason: z.literal('dispatch_expired_unfilled'),
  financial_action: z.literal('cancel_pending_payment_intent'),
  _outbox_key: z.string().min(1).max(500),
  _sig: z.string().length(64),
}).strict();

type Payload = z.infer<typeof PayloadSchema>;

async function hasExactCancellationTerminalEvidence(
  escrowId: string,
  taskId: string,
): Promise<boolean> {
  const result = await db.query<{ exact: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM escrows escrow
         JOIN tasks task ON task.id=escrow.task_id
        WHERE escrow.id=$1
          AND escrow.task_id=$2
          AND task.id=$2
          AND task.state IN ('EXPIRED','CANCELLED')
          AND (
            (
              escrow.state='PENDING'
              AND escrow.stripe_payment_intent_id IS NOT NULL
              AND escrow.payment_intent_canceled_at IS NOT NULL
              AND task.refund_state='NOT_REQUIRED'
              AND EXISTS (
                SELECT 1
                  FROM engine_automation_events event
                 WHERE event.task_id=$2
                   AND event.event_type='PAYMENT_INTENT_CANCELED'
                   AND event.idempotency_key=
                     'pending-payment-intent-canceled-v1:' || $1::text || ':'
                       || escrow.stripe_payment_intent_id
                   AND jsonb_object_length(event.payload)=11
                   AND event.payload->>'event_type'='pending_payment_intent_canceled_v1'
                   AND event.payload->>'reason'='dispatch_expired_unfilled'
                   AND event.payload->>'escrow_id'=$1::text
                   AND event.payload->>'task_id'=$2::text
                   AND event.payload->>'payment_intent_id'=escrow.stripe_payment_intent_id
                   AND event.payload->>'provider_status'='canceled'
                   AND (event.payload->>'idempotency_replayed')::boolean IN (TRUE,FALSE)
                   AND (event.payload->>'escrow_version_before')::integer >= 0
                   AND (event.payload->>'escrow_version_after')::integer = escrow.version
                   AND (event.payload->>'escrow_version_after')::integer =
                     (event.payload->>'escrow_version_before')::integer + 1
                   AND (event.payload->>'task_version_before')::integer >= 0
                   AND (event.payload->>'task_version_after')::integer =
                     (event.payload->>'task_version_before')::integer
              )
            )
            OR (
              escrow.state='REFUNDED'
              AND escrow.stripe_payment_intent_id IS NOT NULL
              AND escrow.stripe_refund_id IS NOT NULL
              AND escrow.refunded_at IS NOT NULL
              AND task.refund_state='REFUNDED'
              AND EXISTS (
                SELECT 1
                  FROM escrow_events witness
                 WHERE witness.escrow_id=$1
                   AND witness.actor_id IS NULL
                   AND witness.actor_type='system'
                   AND witness.idempotency_key=
                     'exact-succeeded-refund-v1:' || $1::text || ':' || escrow.stripe_refund_id
                   AND jsonb_object_length(witness.metadata)=10
                   AND witness.metadata->>'event_type'='exact_succeeded_refund_witness_v1'
                   AND witness.metadata->>'escrow_id'=$1::text
                   AND witness.metadata->>'task_id'=$2::text
                   AND witness.metadata->>'payment_intent_id'=escrow.stripe_payment_intent_id
                   AND witness.metadata->>'refund_id'=escrow.stripe_refund_id
                   AND witness.metadata->>'amount_cents'=escrow.amount::text
                   AND witness.metadata->>'currency'='usd'
                   AND witness.metadata->>'status'='succeeded'
                   AND NULLIF(witness.metadata->>'charge_id','') IS NOT NULL
              )
              AND EXISTS (
                SELECT 1
                  FROM escrow_events transition
                 WHERE transition.escrow_id=$1
                   AND transition.to_state='REFUNDED'
                   AND transition.actor_id IS NULL
                   AND transition.actor_type='system'
                   AND transition.idempotency_key=
                     'escrow-refunded-transition-v1:' || $1::text || ':' || escrow.version::text
                   AND jsonb_object_length(transition.metadata)=11
                   AND transition.metadata->>'event_type'='escrow_refunded_transition_v1'
                   AND transition.metadata->>'escrow_id'=$1::text
                   AND transition.metadata->>'task_id'=$2::text
                   AND transition.metadata->>'payment_intent_id'=escrow.stripe_payment_intent_id
                   AND transition.metadata->>'refund_id'=escrow.stripe_refund_id
                   AND transition.metadata->>'amount_cents'=escrow.amount::text
                   AND transition.metadata->>'canonical_version_after'=escrow.version::text
                   AND transition.metadata->>'canonical_version_before'=(escrow.version - 1)::text
              )
            )
            OR (
              escrow.state='LOCKED_DISPUTE'
              AND task.refund_state='PENDING'
              AND EXISTS (
                SELECT 1
                  FROM engine_automation_events ownership
                 WHERE ownership.task_id=$2
                   AND ownership.event_type='PAYMENT_INTENT_SUCCEEDED_DURING_EXPIRY'
                   AND ownership.idempotency_key='dispatch-expiry-funded-race:' || $2::text
                   AND ownership.payload=jsonb_build_object(
                     'reason','dispatch_expired_unfilled'
                   )
              )
              AND EXISTS (
                SELECT 1
                  FROM outbox_events refund
                 WHERE refund.event_type='escrow.refund_requested'
                   AND refund.aggregate_type='escrow'
                   AND refund.aggregate_id=$1
                   AND refund.idempotency_key='dispatch-expiry-refund:' || $2::text
                   AND refund.queue_name='critical_payments'
                   AND refund.status IN ('pending','enqueued','processing','processed')
                   AND refund.payload=jsonb_build_object(
                     'escrow_id',$1::uuid,
                     'task_id',$2::uuid,
                     'reason','dispatch_expired_unfilled'
                   )
              )
            )
          )
     ) AS exact`,
    [escrowId, taskId],
  );
  return result.rows.length === 1 && result.rows[0]?.exact === true;
}

export async function processDispatchExpiryPaymentCancelJob(
  job: Job<{ payload: Payload }>,
): Promise<void> {
  const parsed = PayloadSchema.safeParse(job.data?.payload);
  if (!parsed.success) {
    log.error({ jobId: job.id, issues: parsed.error.issues }, 'Invalid pending PaymentIntent cancellation job');
    throw new Error('JOB_SCHEMA_INVALID: pending PaymentIntent cancellation');
  }
  const { _sig, ...unsigned } = parsed.data;
  if (!verifyJobSignature(unsigned, _sig)) {
    log.error({ jobId: job.id }, 'Pending PaymentIntent cancellation signature failed');
    throw new Error('JOB_SIGNATURE_INVALID: pending PaymentIntent cancellation');
  }
  const outboxKey = requireOutboxDurableKey(job.id, unsigned._outbox_key);
  if (outboxKey !== `dispatch-expiry-cancel:${unsigned.task_id}`) {
    throw new Error('JOB_IDENTITY_INVALID: pending PaymentIntent cancellation outbox identity');
  }
  await PendingPaymentCancellationService.execute({
    escrowId: unsigned.escrow_id,
    taskId: unsigned.task_id,
    reason: unsigned.reason,
  });
  if (!await hasExactCancellationTerminalEvidence(unsigned.escrow_id, unsigned.task_id)) {
    throw new Error(
      `OUTBOX_TERMINAL_EVIDENCE_MISSING: pending PaymentIntent cancellation ${outboxKey}`,
    );
  }
  const { markOutboxEventProcessed } = await import('./outbox-worker.js');
  await markOutboxEventProcessed(outboxKey);
}

export default processDispatchExpiryPaymentCancelJob;
