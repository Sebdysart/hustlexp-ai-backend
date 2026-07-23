import type { Job } from 'bullmq';
import { z } from 'zod';
import { workerLogger } from '../logger.js';
import { PendingPaymentCancellationService } from '../services/PendingPaymentCancellationService.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'dispatch-expiry-payment-cancel' });

const PayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  reason: z.literal('dispatch_expired_unfilled'),
  financial_action: z.literal('cancel_pending_payment_intent'),
  _sig: z.string().length(64),
}).strict();

type Payload = z.infer<typeof PayloadSchema>;

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
  await PendingPaymentCancellationService.execute({
    escrowId: unsigned.escrow_id,
    taskId: unsigned.task_id,
    reason: unsigned.reason,
  });
}

export default processDispatchExpiryPaymentCancelJob;
