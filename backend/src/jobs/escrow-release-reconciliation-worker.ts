import type { Job } from 'bullmq';
import { workerLogger } from '../logger.js';
import { EscrowReleaseReconciliationService } from '../services/EscrowReleaseReconciliationService.js';
import { requireOutboxDurableKey } from './OutboxIdentity.js';
import { markOutboxEventFailed, markOutboxEventProcessed } from './outbox-worker.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'escrow-release-reconciliation' });

type ReleasePayload = {
  escrowId: string;
  transferId?: string | null;
  fromState?: string;
  version?: number;
  _outbox_key?: string;
  _sig?: string;
};

const RELEASE_OUTBOX_KEY = /^escrow\.released:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function authoritativeOutboxKey(job: Job, signedKey: unknown): string | null {
  if (typeof signedKey !== 'string' || !RELEASE_OUTBOX_KEY.test(signedKey)) return null;
  try {
    return requireOutboxDurableKey(job.id, signedKey);
  } catch {
    return null;
  }
}

function isFinalBullMqAttempt(job: Job): boolean {
  const configuredAttempts = Number(job.opts?.attempts ?? 1);
  const currentAttempt = Number(job.attemptsMade ?? 0) + 1;
  return !Number.isInteger(configuredAttempts)
    || configuredAttempts <= 1
    || currentAttempt >= configuredAttempts;
}

export async function processEscrowReleaseReconciliationJob(job: Job): Promise<void> {
  const payload = (job.data?.payload ?? {}) as ReleasePayload;
  const { _sig, ...unsignedPayload } = payload;
  let outboxKey: string | null = null;
  let permanentPayloadFailure = false;
  try {
    if (!_sig || !verifyJobSignature(unsignedPayload, _sig)) {
      permanentPayloadFailure = true;
      throw new Error('JOB_SIGNATURE_INVALID: escrow.released payload signature verification failed');
    }
    outboxKey = authoritativeOutboxKey(job, payload._outbox_key);
    if (!outboxKey) {
      permanentPayloadFailure = true;
      throw new Error('JOB_IDENTITY_INVALID: escrow.released transport ID does not match its signed outbox identity');
    }
    const payloadKey = payload.escrowId ? `escrow.released:${payload.escrowId}` : '';
    if (
      !RELEASE_OUTBOX_KEY.test(payloadKey)
      || (payload.transferId !== undefined
        && payload.transferId !== null
        && typeof payload.transferId !== 'string')
      || (payload.fromState !== undefined && typeof payload.fromState !== 'string')
      || (payload.version !== undefined && !Number.isInteger(payload.version))
    ) {
      permanentPayloadFailure = true;
      throw new Error('JOB_SCHEMA_INVALID: escrow.released payload is malformed');
    }

    if (outboxKey !== payloadKey) {
      permanentPayloadFailure = true;
      throw new Error('JOB_IDENTITY_INVALID: escrow.released signed outbox identity does not match its payload');
    }

    const result = await EscrowReleaseReconciliationService.reconcile({
      escrowId: payload.escrowId,
      expectedStripeTransferId: payload.transferId,
      fromState: payload.fromState,
    });
    if (!result.success) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }

    const acknowledgement = await markOutboxEventProcessed(outboxKey);
    log.info(
      {
        escrowId: payload.escrowId,
        version: payload.version,
        outboxKey,
        outboxStatus: acknowledgement.status,
        outboxAttempts: acknowledgement.attempts,
      },
      'Escrow release reconciliation job completed',
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!outboxKey) {
      log.error(
        { jobId: job.id, err: errorMessage },
        'Escrow release reconciliation failed without an authoritative outbox identity',
      );
      throw error;
    }
    if (!permanentPayloadFailure && !isFinalBullMqAttempt(job)) {
      log.warn(
        {
          escrowId: payload.escrowId,
          version: payload.version,
          outboxKey,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts?.attempts,
          err: errorMessage,
        },
        'Escrow release reconciliation left outbox enqueued for BullMQ retry',
      );
      throw error;
    }

    const acknowledgement = await markOutboxEventFailed(outboxKey, errorMessage, {
      terminal: true,
      requireClaimed: true,
    });
    const details = {
      escrowId: payload.escrowId,
      version: payload.version,
      outboxKey,
      outboxStatus: acknowledgement.status,
      outboxAttempts: acknowledgement.attempts,
      err: errorMessage,
    };
    if (acknowledgement.status === 'processed') {
      log.warn(details, 'Late reconciliation failure preserved authoritative processed outbox state');
    } else if (acknowledgement.status === 'failed') {
      log.error(details, 'Escrow release reconciliation exhausted authoritative outbox attempts');
    } else {
      log.warn(details, 'Escrow release reconciliation will retry from authoritative outbox');
    }
    throw error;
  }
}
