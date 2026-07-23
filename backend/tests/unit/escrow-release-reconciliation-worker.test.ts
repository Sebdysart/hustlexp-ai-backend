import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), reconcile: vi.fn() }));

vi.mock('../../src/jobs/queues.js', () => ({ verifyJobSignature: mocks.verify }));
vi.mock('../../src/services/EscrowReleaseReconciliationService.js', () => ({
  EscrowReleaseReconciliationService: { reconcile: mocks.reconcile },
}));
vi.mock('../../src/logger.js', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

import { processEscrowReleaseReconciliationJob } from '../../src/jobs/escrow-release-reconciliation-worker.js';
import type { Job } from 'bullmq';

function job(payload: Record<string, unknown>): Job {
  return { data: { payload } } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.reconcile.mockResolvedValue({ success: true, data: { escrowId: 'escrow-1' } });
});

describe('processEscrowReleaseReconciliationJob', () => {
  it('verifies the financial signature and reconciles the provider-bound release', async () => {
    await processEscrowReleaseReconciliationJob(job({
      escrowId: 'escrow-1', transferId: 'tr-1', fromState: 'FUNDED', version: 4, _sig: 'signed',
    }));
    expect(mocks.verify).toHaveBeenCalledWith({
      escrowId: 'escrow-1', transferId: 'tr-1', fromState: 'FUNDED', version: 4,
    }, 'signed');
    expect(mocks.reconcile).toHaveBeenCalledWith({
      escrowId: 'escrow-1', expectedStripeTransferId: 'tr-1', fromState: 'FUNDED',
    });
  });

  it('rejects an unsigned financial job', async () => {
    await expect(processEscrowReleaseReconciliationJob(job({ escrowId: 'escrow-1' })))
      .rejects.toThrow('JOB_SIGNATURE_INVALID');
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('throws when reconciliation reports an incomplete witness', async () => {
    mocks.reconcile.mockResolvedValueOnce({
      success: false, error: { code: 'RECORD_EARNINGS_FAILED', message: 'missing ledger' },
    });
    await expect(processEscrowReleaseReconciliationJob(job({ escrowId: 'escrow-1', _sig: 'signed' })))
      .rejects.toThrow('RECORD_EARNINGS_FAILED: missing ledger');
  });
});
