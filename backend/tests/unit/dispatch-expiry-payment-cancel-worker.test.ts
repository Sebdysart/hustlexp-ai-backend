import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), error: vi.fn() }));

vi.mock('../../src/services/PendingPaymentCancellationService', () => ({
  PendingPaymentCancellationService: { execute: mocks.execute },
}));
vi.mock('../../src/logger', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }) },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }) },
}));
vi.mock('../../src/config', () => ({
  config: { queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' } },
}));

import type { Job } from 'bullmq';
import { signJobPayload } from '../../src/jobs/queues';
import { processDispatchExpiryPaymentCancelJob } from '../../src/jobs/dispatch-expiry-payment-cancel-worker';

const payload = {
  escrow_id: '11111111-1111-4111-8111-111111111111',
  task_id: '22222222-2222-4222-8222-222222222222',
  reason: 'dispatch_expired_unfilled' as const,
  financial_action: 'cancel_pending_payment_intent' as const,
};

function job(body: Record<string, unknown>): Job {
  return { id: 'job-1', data: { payload: body } } as unknown as Job;
}

beforeEach(() => vi.clearAllMocks());

describe('dispatch expiry pending-payment worker', () => {
  it('verifies the signed closed schema and delegates the exact identities', async () => {
    await processDispatchExpiryPaymentCancelJob(job({ ...payload, _sig: signJobPayload(payload) }) as never);
    expect(mocks.execute).toHaveBeenCalledWith({
      escrowId: payload.escrow_id,
      taskId: payload.task_id,
      reason: payload.reason,
    });
  });

  it('rejects malformed or unsigned financial work before the service', async () => {
    await expect(processDispatchExpiryPaymentCancelJob({ id: 'job-empty', data: undefined } as never))
      .rejects.toThrow('JOB_SCHEMA_INVALID');
    await expect(processDispatchExpiryPaymentCancelJob(job({ ...payload, extra: 'injected', _sig: 'a'.repeat(64) }) as never))
      .rejects.toThrow('JOB_SCHEMA_INVALID');
    await expect(processDispatchExpiryPaymentCancelJob(job({ ...payload, _sig: 'b'.repeat(64) }) as never))
      .rejects.toThrow('JOB_SIGNATURE_INVALID');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
