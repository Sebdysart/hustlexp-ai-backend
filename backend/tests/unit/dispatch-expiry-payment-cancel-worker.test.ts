import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  query: vi.fn(),
  acknowledge: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/services/PendingPaymentCancellationService', () => ({
  PendingPaymentCancellationService: { execute: mocks.execute },
}));
vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/jobs/outbox-worker', () => ({
  markOutboxEventProcessed: mocks.acknowledge,
}));
vi.mock('../../src/logger', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }) },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }) },
}));
vi.mock('../../src/config', () => ({
  config: { queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' } },
}));

import type { Job } from 'bullmq';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity';
import { signJobPayload } from '../../src/jobs/queues';
import { processDispatchExpiryPaymentCancelJob } from '../../src/jobs/dispatch-expiry-payment-cancel-worker';

const OUTBOX_KEY = 'dispatch-expiry-cancel:22222222-2222-4222-8222-222222222222';
const payload = {
  escrow_id: '11111111-1111-4111-8111-111111111111',
  task_id: '22222222-2222-4222-8222-222222222222',
  reason: 'dispatch_expired_unfilled' as const,
  financial_action: 'cancel_pending_payment_intent' as const,
  _outbox_key: OUTBOX_KEY,
};

function job(
  body: Record<string, unknown>,
  id: string = outboxTransportJobId(OUTBOX_KEY),
): Job {
  return { id, data: { payload: body } } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [{ exact: true }] });
  mocks.acknowledge.mockResolvedValue({
    idempotency_key: OUTBOX_KEY,
    status: 'processed',
    attempts: 1,
  });
});

describe('dispatch expiry pending-payment worker', () => {
  it('verifies the signed closed schema and delegates the exact identities', async () => {
    await processDispatchExpiryPaymentCancelJob(job({ ...payload, _sig: signJobPayload(payload) }) as never);
    expect(mocks.execute).toHaveBeenCalledWith({
      escrowId: payload.escrow_id,
      taskId: payload.task_id,
      reason: payload.reason,
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("event_type='PAYMENT_INTENT_CANCELED'"), [
      payload.escrow_id,
      payload.task_id,
    ]);
    expect(mocks.acknowledge).toHaveBeenCalledWith(OUTBOX_KEY);
  });

  it('rejects malformed or unsigned financial work before the service', async () => {
    await expect(processDispatchExpiryPaymentCancelJob({ id: 'job-empty', data: undefined } as never))
      .rejects.toThrow('JOB_SCHEMA_INVALID');
    await expect(processDispatchExpiryPaymentCancelJob(job({ ...payload, extra: 'injected', _sig: 'a'.repeat(64) }) as never))
      .rejects.toThrow('JOB_SCHEMA_INVALID');
    await expect(processDispatchExpiryPaymentCancelJob(job({ ...payload, _sig: 'b'.repeat(64) }) as never))
      .rejects.toThrow('JOB_SIGNATURE_INVALID');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it('rejects forged transport, durable-key, and HMAC bindings before financial effects', async () => {
    const signed = { ...payload, _sig: signJobPayload(payload) };
    await expect(processDispatchExpiryPaymentCancelJob(job(
      signed,
      outboxTransportJobId('dispatch-expiry-cancel:forged'),
    ) as never)).rejects.toThrow('OUTBOX_IDENTITY_MISMATCH');

    const forgedKeyPayload = {
      ...payload,
      _outbox_key: 'dispatch-expiry-cancel:33333333-3333-4333-8333-333333333333',
    };
    await expect(processDispatchExpiryPaymentCancelJob(job(
      { ...forgedKeyPayload, _sig: signJobPayload(forgedKeyPayload) },
      outboxTransportJobId(forgedKeyPayload._outbox_key),
    ) as never)).rejects.toThrow('JOB_IDENTITY_INVALID');

    const signatureExcludesKey = signJobPayload({
      escrow_id: payload.escrow_id,
      task_id: payload.task_id,
      reason: payload.reason,
      financial_action: payload.financial_action,
    });
    await expect(processDispatchExpiryPaymentCancelJob(job({
      ...payload,
      _sig: signatureExcludesKey,
    }) as never)).rejects.toThrow('JOB_SIGNATURE_INVALID');

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it('does not ACK a void service return without exact terminal business evidence', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ exact: false }] });

    await expect(processDispatchExpiryPaymentCancelJob(job({
      ...payload,
      _sig: signJobPayload(payload),
    }) as never)).rejects.toThrow('OUTBOX_TERMINAL_EVIDENCE_MISSING');

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it('throws on ACK failure and safely retries the same durable terminal action', async () => {
    mocks.acknowledge
      .mockRejectedValueOnce(new Error('ack transaction crashed'))
      .mockResolvedValueOnce({ idempotency_key: OUTBOX_KEY, status: 'processed', attempts: 2 });
    const signed = { ...payload, _sig: signJobPayload(payload) };

    await expect(processDispatchExpiryPaymentCancelJob(job(signed) as never))
      .rejects.toThrow('ack transaction crashed');
    await expect(processDispatchExpiryPaymentCancelJob(job(signed) as never))
      .resolves.toBeUndefined();

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.acknowledge).toHaveBeenNthCalledWith(1, OUTBOX_KEY);
    expect(mocks.acknowledge).toHaveBeenNthCalledWith(2, OUTBOX_KEY);
  });

  it('ACKs duplicate terminal deliveries by the same durable key without synthesizing identity', async () => {
    const signed = { ...payload, _sig: signJobPayload(payload) };

    await processDispatchExpiryPaymentCancelJob(job(signed) as never);
    await processDispatchExpiryPaymentCancelJob(job(signed) as never);

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.acknowledge).toHaveBeenCalledTimes(2);
    expect(mocks.acknowledge).toHaveBeenCalledWith(OUTBOX_KEY);
  });
});
