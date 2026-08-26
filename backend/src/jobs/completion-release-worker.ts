/**
 * Completion release job boundary. Payload authenticity is established here;
 * provider settlement and canonical state transitions live in the orchestrator.
 */
import type { Job } from 'bullmq';
import { z } from 'zod';
import { db } from '../db.js';
import { workerLogger } from '../logger.js';
import { processCompletionRelease } from './completion-release-orchestrator.js';
import { requireOutboxDurableKey } from './OutboxIdentity.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'completion-release' });
const CompletionReleasePayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  reason: z.string().min(1).max(200),
  _outbox_key: z.string().min(1).max(500),
  _sig: z.string().min(1),
}).strict();

async function hasExactCompletionTerminalEvidence(
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
          AND (
            (
              escrow.state='RELEASED'
              AND escrow.released_at IS NOT NULL
              AND task.worker_id IS NOT NULL
              AND (
                (
                  escrow.payout_provider='STRIPE'
                  AND escrow.stripe_transfer_id IS NOT NULL
                  AND escrow.provider_transfer_id=escrow.stripe_transfer_id
                  AND escrow.provider_transfer_status IN ('submitted','processing','paid')
                )
                OR (
                  escrow.payout_provider='LOCAL_CERTIFICATION_TEST'
                  AND escrow.stripe_transfer_id IS NULL
                  AND escrow.provider_transfer_id IS NOT NULL
                  AND escrow.provider_transfer_status='paid'
                  AND escrow.provider_transfer_paid_at IS NOT NULL
                )
              )
              AND EXISTS (
                SELECT 1
                  FROM escrow_events event
                 WHERE event.escrow_id=$1
                   AND event.from_state IN ('FUNDED','LOCKED_DISPUTE')
                   AND event.to_state='RELEASED'
                   AND event.actor_id IS NULL
                   AND event.actor_type='system'
                   AND event.idempotency_key='escrow.released:' || $1::text
                   AND event.metadata=jsonb_build_object(
                     'payout_provider',escrow.payout_provider,
                     'payout_recipient_user_id',
                       COALESCE(task.payout_recipient_user_id,task.worker_id)::text,
                     'provider_transfer_id',escrow.provider_transfer_id,
                     'provider_transfer_status',CASE
                       WHEN escrow.payout_provider='LOCAL_CERTIFICATION_TEST' THEN 'paid'
                       ELSE 'submitted'
                     END
                   )
              )
            )
            OR (
              escrow.state='REFUNDED'
              AND escrow.stripe_payment_intent_id IS NOT NULL
              AND escrow.stripe_refund_id IS NOT NULL
              AND escrow.refunded_at IS NOT NULL
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
            )
            OR (
              escrow.state='REFUND_PARTIAL'
              AND escrow.refund_amount > 0
              AND escrow.release_amount > 0
              AND escrow.refund_amount + escrow.release_amount=escrow.amount
              AND escrow.stripe_payment_intent_id IS NOT NULL
              AND escrow.stripe_refund_id IS NOT NULL
              AND escrow.stripe_transfer_id IS NOT NULL
              AND escrow.refunded_at IS NOT NULL
              AND escrow.released_at IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM escrow_events transition
                 WHERE transition.escrow_id=$1
                   AND transition.from_state='LOCKED_DISPUTE'
                   AND transition.to_state='REFUND_PARTIAL'
                   AND transition.actor_id IS NULL
                   AND transition.actor_type='system'
                   AND transition.idempotency_key=
                     'partial-refund-terminal-transition:' || $1::text || ':' || escrow.version::text
                   AND transition.metadata->>'event_type'='partial_refund_terminal_transition_v1'
                   AND transition.metadata->>'provider'='stripe'
                   AND transition.metadata->>'escrow_id'=$1::text
                   AND transition.metadata->>'task_id'=$2::text
                   AND transition.metadata->>'terminal_state'='REFUND_PARTIAL'
                   AND transition.metadata->>'terminal_escrow_version'=escrow.version::text
                   AND transition.metadata->>'escrow_amount_cents'=escrow.amount::text
                   AND transition.metadata->>'poster_refund_amount_cents'=escrow.refund_amount::text
                   AND transition.metadata->>'worker_settlement_gross_cents'=escrow.release_amount::text
                   AND transition.metadata->>'stripe_payment_intent_id'=escrow.stripe_payment_intent_id
                   AND transition.metadata->>'stripe_refund_id'=escrow.stripe_refund_id
                   AND transition.metadata->>'stripe_refund_status'='succeeded'
                   AND transition.metadata->>'stripe_refund_currency'='usd'
                   AND transition.metadata->>'stripe_transfer_id'=escrow.stripe_transfer_id
                   AND transition.metadata->>'stripe_transfer_escrow_id'=$1::text
                   AND transition.metadata->>'stripe_transfer_task_id'=$2::text
                   AND transition.metadata->>'stripe_transfer_reversed'='false'
                   AND transition.metadata->>'stripe_transfer_amount_reversed_cents'='0'
              )
            )
          )
     ) AS exact`,
    [escrowId, taskId],
  );
  return result.rows.length === 1 && result.rows[0]?.exact === true;
}

export async function processCompletionReleaseJob(job: Job<{ payload: object }>): Promise<void> {
  const parsed = CompletionReleasePayloadSchema.safeParse(job.data.payload);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.issues }, 'Invalid completion-release payload schema');
    throw new Error(`JOB_SCHEMA_INVALID: ${parsed.error.message}`);
  }
  const { _sig, ...unsigned } = parsed.data;
  if (!verifyJobSignature(unsigned as Record<string, unknown>, _sig)) {
    log.error({ jobId: job.id }, 'Completion-release job signature verification failed');
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }
  const outboxKey = requireOutboxDurableKey(job.id, unsigned._outbox_key);
  if (outboxKey !== `completion-release:${unsigned.task_id}`) {
    throw new Error('JOB_IDENTITY_INVALID: completion-release outbox identity');
  }
  await processCompletionRelease({ escrowId: parsed.data.escrow_id, taskId: parsed.data.task_id });
  if (!await hasExactCompletionTerminalEvidence(parsed.data.escrow_id, parsed.data.task_id)) {
    throw new Error(`OUTBOX_TERMINAL_EVIDENCE_MISSING: completion release ${outboxKey}`);
  }
  const { markOutboxEventProcessed } = await import('./outbox-worker.js');
  await markOutboxEventProcessed(outboxKey);
}
