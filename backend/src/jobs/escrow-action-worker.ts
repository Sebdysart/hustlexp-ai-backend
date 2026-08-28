import type { Job } from 'bullmq';
import { z } from 'zod';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { workerLogger } from '../logger.js';
import { handlePartialRefundRequest } from './EscrowActionPartialRefund.js';
import { handleRefundRequest } from './EscrowActionRefund.js';
import { handleReleaseRequest } from './EscrowActionRelease.js';
import type { EscrowActionInput, EscrowActionJobData, EscrowActionRow } from './EscrowActionTypes.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'escrow-action' });
const FinancialJobPayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  dispute_id: z.string().uuid().optional(),
  reason: z.string().min(1).max(500),
  refund_amount: z.number().int().nonnegative().optional(),
  release_amount: z.number().int().nonnegative().optional(),
  _sig: z.string().length(64),
});

async function loadLockedEscrow(query: QueryFn, escrowId: string): Promise<EscrowActionRow> {
  const result = await query<EscrowActionRow>(
    `SELECT id, state, version, amount, platform_fee_cents, stripe_payment_intent_id,
            stripe_transfer_id, stripe_refund_id
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [escrowId],
  );
  const escrow = result.rows[0];
  if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
  if (escrow.state !== 'LOCKED_DISPUTE') {
    throw new Error(`Escrow must be LOCKED_DISPUTE to process dispute action (current: ${escrow.state})`);
  }
  return escrow;
}

async function dispatch(eventType: string, input: EscrowActionInput): Promise<void> {
  switch (eventType) {
    case 'escrow.release_requested':
      return handleReleaseRequest(input);
    case 'escrow.refund_requested':
      return handleRefundRequest(input);
    case 'escrow.partial_refund_requested':
      return handlePartialRefundRequest(input);
    default:
      throw new Error(`Unknown escrow action event type: ${eventType}`);
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

export async function processEscrowActionJob(job: Job<EscrowActionJobData>): Promise<void> {
  const eventType = job.name;
  const payload = verifyPayload(job.data.payload, job.id, eventType);
  try {
    const escrow = await db.transaction((query) => loadLockedEscrow(query, payload.escrow_id));
    await dispatch(eventType, {
      escrow,
      taskId: payload.task_id,
      disputeId: payload.dispute_id,
      reason: payload.reason,
      refundAmount: payload.refund_amount,
      releaseAmount: payload.release_amount,
    });
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
