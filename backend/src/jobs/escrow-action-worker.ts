import type { Job } from 'bullmq';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { workerLogger } from '../logger.js';
import { reconcilePartialRefundPostTerminal } from '../services/EscrowPartialRefundReconciliationService.js';
import { handlePartialRefundRequest } from './EscrowActionPartialRefund.js';
import { handleRefundRequest, reconcileTerminalRefundRequest } from './EscrowActionRefund.js';
import { handleReleaseRequest } from './EscrowActionRelease.js';
import type {
  EscrowActionInput,
  EscrowActionJobData,
  EscrowActionRow,
  EscrowActionTerminalProof,
} from './EscrowActionTypes.js';
import { FinancialJobPayloadSchema } from './EscrowActionTypes.js';
import { requireOutboxDurableKey } from './OutboxIdentity.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'escrow-action' });
async function loadEscrowForAction(query: QueryFn, escrowId: string): Promise<EscrowActionRow> {
  const result = await query<EscrowActionRow>(
    `SELECT id, task_id, state, version, amount, platform_fee_cents, stripe_payment_intent_id,
            stripe_transfer_id, stripe_refund_id, refund_amount, release_amount,
            payout_provider,provider_transfer_id,provider_transfer_status,
            provider_transfer_paid_at
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [escrowId],
  );
  const escrow = result.rows[0];
  if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
  return escrow;
}

async function dispatch(
  eventType: string,
  input: EscrowActionInput,
): Promise<EscrowActionTerminalProof> {
  switch (eventType) {
    case 'escrow.release_requested':
      return handleReleaseRequest(input);
    case 'escrow.refund_requested':
      return handleRefundRequest(input);
    case 'escrow.partial_refund_requested':
      if (!input.disputeId) {
        throw new Error('PARTIAL_REFUND_RECONCILIATION_REQUIRED: dispute_id is required');
      }
      await handlePartialRefundRequest(input);
      return {
        escrowId: input.escrow.id,
        taskId: input.taskId,
        terminalState: 'REFUND_PARTIAL',
        providerOperationId: input.disputeId,
        evidence: 'EXACT_PARTIAL_REFUND_RECONCILED_V1',
      };
    default:
      throw new Error(`Unknown escrow action event type: ${eventType}`);
  }
}

function requireExactTerminalProof(
  eventType: string,
  input: EscrowActionInput,
  proof: EscrowActionTerminalProof,
): void {
  const expectedState = eventType === 'escrow.release_requested'
    ? 'RELEASED'
    : eventType === 'escrow.refund_requested'
      ? 'REFUNDED'
      : eventType === 'escrow.partial_refund_requested'
        ? 'REFUND_PARTIAL'
        : null;
  if (
    !expectedState
    || proof.escrowId !== input.escrow.id
    || proof.taskId !== input.taskId
    || proof.terminalState !== expectedState
    || !proof.providerOperationId
  ) {
    throw new Error(
      `ESCROW_ACTION_TERMINAL_EVIDENCE_REQUIRED: ${eventType} lacks exact terminal proof`,
    );
  }
}

function verifyPayload(payload: unknown, jobId: string | undefined, eventType: string) {
  const parsed = FinancialJobPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { jobId, eventType, errors: parsed.error.issues },
      'Invalid financial job payload schema — rejecting',
    );
    throw new Error(`JOB_SCHEMA_INVALID: ${parsed.error.message}`);
  }
  const { _sig, ...unsigned } = parsed.data;
  if (!verifyJobSignature(unsigned as Record<string, unknown>, _sig)) {
    log.error({ jobId, eventType }, 'Job signature verification failed — possible Redis injection attack');
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }
  return parsed.data;
}

async function acknowledgeFinancialOutbox(
  job: Job<EscrowActionJobData>,
  signedOutboxKey: string,
): Promise<void> {
  requireOutboxDurableKey(job.id, signedOutboxKey);
  const { markOutboxEventProcessed } = await import('./outbox-worker.js');
  await markOutboxEventProcessed(signedOutboxKey);
}

export async function processEscrowActionJob(job: Job<EscrowActionJobData>): Promise<void> {
  const eventType = job.name;
  const payload = verifyPayload(job.data.payload, job.id, eventType);
  requireOutboxDurableKey(job.id, payload._outbox_key);
  try {
    const escrow = await db.transaction((query) => loadEscrowForAction(query, payload.escrow_id));
    if (escrow.task_id !== payload.task_id) {
      throw new Error(
        `Escrow ${escrow.id} task ${escrow.task_id} does not match payload task ${payload.task_id}`,
      );
    }
    if (eventType === 'escrow.partial_refund_requested' && escrow.state === 'REFUND_PARTIAL') {
      if (!payload.dispute_id) {
        throw new Error('PARTIAL_REFUND_RECONCILIATION_REQUIRED: dispute_id is required');
      }
      const replay = await reconcilePartialRefundPostTerminal({
        escrowId: payload.escrow_id,
        taskId: payload.task_id,
        disputeId: payload.dispute_id,
        refundAmountCents: payload.refund_amount,
        releaseAmountCents: payload.release_amount,
      });
      if (!replay) {
        throw new Error(
          `PARTIAL_REFUND_RECONCILIATION_REQUIRED: escrow ${escrow.id} lost terminal evidence`,
        );
      }
      const proof: EscrowActionTerminalProof = {
        escrowId: escrow.id,
        taskId: payload.task_id,
        terminalState: 'REFUND_PARTIAL',
        providerOperationId: escrow.stripe_refund_id ?? payload.dispute_id,
        evidence: 'EXACT_PARTIAL_REFUND_RECONCILED_V1',
      };
      requireExactTerminalProof(eventType, {
        escrow,
        taskId: payload.task_id,
        disputeId: payload.dispute_id,
        reason: payload.reason,
        refundAmount: payload.refund_amount,
        releaseAmount: payload.release_amount,
      }, proof);
      await acknowledgeFinancialOutbox(job, payload._outbox_key);
      log.info({ eventType, escrowId: payload.escrow_id }, 'Escrow partial-refund effects reconciled');
      return;
    }
    if (eventType === 'escrow.release_requested' && escrow.state === 'RELEASED') {
      const input = {
        escrow,
        taskId: payload.task_id,
        disputeId: payload.dispute_id,
        reason: payload.reason,
        refundAmount: payload.refund_amount,
        releaseAmount: payload.release_amount,
      };
      const proof = await dispatch(eventType, input);
      requireExactTerminalProof(eventType, input, proof);
      await acknowledgeFinancialOutbox(job, payload._outbox_key);
      log.info({ eventType, escrowId: payload.escrow_id }, 'Escrow release effects reconciled');
      return;
    }
    if (eventType === 'escrow.refund_requested' && escrow.state === 'REFUNDED') {
      const input = {
        escrow,
        taskId: payload.task_id,
        disputeId: payload.dispute_id,
        reason: payload.reason,
        refundAmount: payload.refund_amount,
        releaseAmount: payload.release_amount,
      };
      const proof = await reconcileTerminalRefundRequest(input);
      requireExactTerminalProof(eventType, input, proof);
      await acknowledgeFinancialOutbox(job, payload._outbox_key);
      log.info({ eventType, escrowId: payload.escrow_id }, 'Escrow refund terminal evidence reconciled');
      return;
    }
    if (escrow.state !== 'LOCKED_DISPUTE') {
      throw new Error(
        `Escrow must be LOCKED_DISPUTE to process dispute action (current: ${escrow.state})`,
      );
    }
    const input = {
      escrow,
      taskId: payload.task_id,
      disputeId: payload.dispute_id,
      reason: payload.reason,
      refundAmount: payload.refund_amount,
      releaseAmount: payload.release_amount,
    };
    const proof = await dispatch(eventType, input);
    requireExactTerminalProof(eventType, input, proof);
    await acknowledgeFinancialOutbox(job, payload._outbox_key);
    log.info({ eventType, escrowId: payload.escrow_id }, 'Escrow action processed');
  } catch (error) {
    log.error({
      eventType,
      escrowId: payload.escrow_id,
      err: error instanceof Error ? error.message : 'Unknown error',
    }, 'Escrow action processing failed');
    throw error;
  }
}
