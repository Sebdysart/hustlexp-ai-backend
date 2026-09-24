import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
const mocks = vi.hoisted(() => ({ query: vi.fn(), refund: vi.fn(), partial: vi.fn(), release: vi.fn(), signature: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: (fn: (q: typeof mocks.query) => unknown) => fn(mocks.query) } }));
vi.mock('../../src/logger.js', () => ({ workerLogger: { child: () => ({ info: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../src/jobs/queues.js', () => ({ verifyJobSignature: mocks.signature }));
vi.mock('../../src/jobs/EscrowActionRefund.js', () => ({ handleRefundRequest: mocks.refund }));
vi.mock('../../src/jobs/EscrowActionPartialRefund.js', () => ({ handlePartialRefundRequest: mocks.partial }));
vi.mock('../../src/jobs/EscrowActionRelease.js', () => ({ handleReleaseRequest: mocks.release }));
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
const payload = { escrow_id: '11111111-1111-4111-8111-111111111111', task_id: '22222222-2222-4222-8222-222222222222', reason: 'resolved dispute', _sig: 'a'.repeat(64) };
const job = (name: string) => ({ name, data: { payload } }) as Job;
beforeEach(() => { vi.resetAllMocks(); mocks.signature.mockReturnValue(true); mocks.query.mockResolvedValue({ rows: [{ id: payload.escrow_id, state: 'LOCKED_DISPUTE' }] }); });
describe('signed escrow action dispatch', () => {
  it('routes refund and partial refund to durable manual review handlers', async () => {
    await processEscrowActionJob(job('escrow.refund_requested'));
    await processEscrowActionJob(job('escrow.partial_refund_requested'));
    expect(mocks.refund).toHaveBeenCalledOnce(); expect(mocks.partial).toHaveBeenCalledOnce();
  });
  it('routes release through canonical completion bookkeeping', async () => {
    await processEscrowActionJob(job('escrow.release_requested')); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('rejects bad signatures before touching persistence', async () => {
    mocks.signature.mockReturnValue(false);
    await expect(processEscrowActionJob(job('escrow.refund_requested'))).rejects.toThrow('JOB_SIGNATURE_INVALID');
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('rejects non-disputed escrow state before calling handlers', async () => {
    mocks.query.mockResolvedValue({ rows: [{ state: 'FUNDED' }] });
    await expect(processEscrowActionJob(job('escrow.refund_requested'))).rejects.toThrow('LOCKED_DISPUTE');
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});
