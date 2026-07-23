import type { Job } from 'bullmq';
import { workerLogger } from '../logger.js';
import { EscrowReleaseReconciliationService } from '../services/EscrowReleaseReconciliationService.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'escrow-release-reconciliation' });

type ReleasePayload = {
  escrowId: string;
  transferId?: string | null;
  fromState?: string;
  version?: number;
  _sig?: string;
};

export async function processEscrowReleaseReconciliationJob(job: Job): Promise<void> {
  const payload = (job.data?.payload ?? {}) as ReleasePayload;
  const { _sig, ...unsignedPayload } = payload;
  if (!_sig || !verifyJobSignature(unsignedPayload, _sig)) {
    throw new Error('JOB_SIGNATURE_INVALID: escrow.released payload signature verification failed');
  }
  if (!payload.escrowId) {
    throw new Error('JOB_SCHEMA_INVALID: escrow.released requires escrowId');
  }

  const result = await EscrowReleaseReconciliationService.reconcile({
    escrowId: payload.escrowId,
    expectedStripeTransferId: payload.transferId,
    fromState: payload.fromState,
  });
  if (!result.success) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }

  log.info(
    { escrowId: payload.escrowId, version: payload.version },
    'Escrow release reconciliation job completed',
  );
}
