import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), reconcile: vi.fn(), processed: vi.fn(), failed: vi.fn(),
}));

vi.mock('../../src/jobs/queues.js', () => ({ verifyJobSignature: mocks.verify }));
vi.mock('../../src/services/EscrowReleaseReconciliationService.js', () => ({
  EscrowReleaseReconciliationService: { reconcile: mocks.reconcile },
}));
vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: mocks.processed,
  markOutboxEventFailed: mocks.failed,
}));
vi.mock('../../src/logger.js', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

import { processEscrowReleaseReconciliationJob } from '../../src/jobs/escrow-release-reconciliation-worker.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';
import type { Job } from 'bullmq';

const ESCROW_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ESCROW_ID = '00000000-0000-4000-8000-000000000002';
const OUTBOX_KEY = `escrow.released:${ESCROW_ID}`;

function job(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): Job {
  return {
    id: outboxTransportJobId(OUTBOX_KEY),
    data: { payload },
    attemptsMade: 0,
    opts: { attempts: 5 },
    ...overrides,
  } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.reconcile.mockResolvedValue({ success: true, data: { escrowId: ESCROW_ID } });
  mocks.processed.mockResolvedValue({
    idempotency_key: OUTBOX_KEY, status: 'processed', attempts: 1,
  });
  mocks.failed.mockResolvedValue({
    idempotency_key: OUTBOX_KEY, status: 'failed', attempts: 1,
  });
});

describe('processEscrowReleaseReconciliationJob', () => {
  it('verifies the financial signature and reconciles the provider-bound release', async () => {
    await processEscrowReleaseReconciliationJob(job({
      escrowId: ESCROW_ID, transferId: 'tr-1', fromState: 'FUNDED', version: 4,
      _outbox_key: OUTBOX_KEY, _sig: 'signed',
    }));
    expect(mocks.verify).toHaveBeenCalledWith({
      escrowId: ESCROW_ID, transferId: 'tr-1', fromState: 'FUNDED', version: 4,
      _outbox_key: OUTBOX_KEY,
    }, 'signed');
    expect(mocks.reconcile).toHaveBeenCalledWith({
      escrowId: ESCROW_ID, expectedStripeTransferId: 'tr-1', fromState: 'FUNDED',
    });
    expect(mocks.processed).toHaveBeenCalledWith(OUTBOX_KEY);
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('rejects an unsigned financial job without mutating a durable outbox row', async () => {
    await expect(processEscrowReleaseReconciliationJob(job({
      escrowId: ESCROW_ID, _outbox_key: OUTBOX_KEY,
    })))
      .rejects.toThrow('JOB_SIGNATURE_INVALID');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('keeps the authoritative row enqueued while BullMQ owns a transient retry', async () => {
    mocks.reconcile.mockResolvedValueOnce({
      success: false, error: { code: 'RECORD_EARNINGS_FAILED', message: 'missing ledger' },
    });
    await expect(processEscrowReleaseReconciliationJob(job({
      escrowId: ESCROW_ID, _outbox_key: OUTBOX_KEY, _sig: 'signed',
    })))
      .rejects.toThrow('RECORD_EARNINGS_FAILED: missing ledger');
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
  });

  it('records an exhausted BullMQ reconciliation as an authoritative failed outbox row', async () => {
    mocks.reconcile.mockResolvedValueOnce({
      success: false, error: { code: 'CONFLICT', message: 'immutable witness mismatch' },
    });
    mocks.failed.mockResolvedValueOnce({
      idempotency_key: OUTBOX_KEY, status: 'failed', attempts: 1,
    });

    await expect(processEscrowReleaseReconciliationJob(job({
      escrowId: ESCROW_ID, version: 8, _outbox_key: OUTBOX_KEY, _sig: 'signed',
    }, { attemptsMade: 4 }))).rejects.toThrow('CONFLICT: immutable witness mismatch');
    expect(mocks.failed).toHaveBeenCalledWith(
      OUTBOX_KEY,
      'CONFLICT: immutable witness mismatch',
      { terminal: true, requireClaimed: true },
    );
  });

  it('terminally fails a claimed corrupt job whose signed payload has no escrow identity', async () => {
    await expect(processEscrowReleaseReconciliationJob(job({
      _outbox_key: OUTBOX_KEY, _sig: 'signed',
    })))
      .rejects.toThrow('JOB_SCHEMA_INVALID');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      OUTBOX_KEY,
      'JOB_SCHEMA_INVALID: escrow.released payload is malformed',
      { terminal: true, requireClaimed: true },
    );
  });

  it('terminally fails a claimed signed job with a malformed escrow identity', async () => {
    await expect(processEscrowReleaseReconciliationJob(job({
      escrowId: 'not-a-uuid', _outbox_key: OUTBOX_KEY, _sig: 'signed',
    }))).rejects.toThrow('JOB_SCHEMA_INVALID');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      OUTBOX_KEY,
      'JOB_SCHEMA_INVALID: escrow.released payload is malformed',
      { terminal: true, requireClaimed: true },
    );
  });

  it('uses the signed durable identity when the escrow payload conflicts', async () => {
    await expect(processEscrowReleaseReconciliationJob(job({
      escrowId: OTHER_ESCROW_ID, _outbox_key: OUTBOX_KEY, _sig: 'signed',
    }))).rejects.toThrow('JOB_IDENTITY_INVALID');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      OUTBOX_KEY,
      'JOB_IDENTITY_INVALID: escrow.released signed outbox identity does not match its payload',
      { terminal: true, requireClaimed: true },
    );
  });

  it('rejects a raw durable key as a BullMQ ID without acknowledging provider work', async () => {
    await expect(processEscrowReleaseReconciliationJob(job({
      escrowId: ESCROW_ID, _outbox_key: OUTBOX_KEY, _sig: 'signed',
    }, { id: OUTBOX_KEY }))).rejects.toThrow(
      'JOB_IDENTITY_INVALID: escrow.released transport ID does not match its signed outbox identity',
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });
});
