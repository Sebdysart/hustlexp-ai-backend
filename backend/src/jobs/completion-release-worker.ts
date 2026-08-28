/**
 * Completion release job boundary. Payload authenticity is established here;
 * provider settlement and canonical state transitions live in the orchestrator.
 */
import type { Job } from 'bullmq';
import { z } from 'zod';
import { workerLogger } from '../logger.js';
import { processCompletionRelease } from './completion-release-orchestrator.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'completion-release' });
const CompletionReleasePayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  reason: z.string().min(1).max(200),
  _sig: z.string().min(1),
});

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
  await processCompletionRelease({ escrowId: parsed.data.escrow_id, taskId: parsed.data.task_id });
}
