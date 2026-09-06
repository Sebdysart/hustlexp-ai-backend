import { describe, expect, it, vi } from 'vitest';
import { SyntheticFinancialCommandProcessor } from '../../src/jobs/synthetic-financial-worker.js';
import {
  FAKE_FINANCIAL_OUTBOX_JOB,
  FAKE_FINANCIAL_OUTBOX_QUEUE,
} from '../../src/jobs/fake-financial-outbox-publisher.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const payload = {
  version: 1 as const,
  kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND' as const,
  outboxRequestId: id(1),
  commandId: id(2),
  jobAuthoritySha256: 'b'.repeat(64),
};
const job = () => ({
  name: FAKE_FINANCIAL_OUTBOX_JOB,
  queueName: FAKE_FINANCIAL_OUTBOX_QUEUE,
  id: 'hx-fake-fin-' + id(2).replaceAll('-', '') + '-' + 'b'.repeat(64),
  data: payload,
  attemptsMade: 0,
});
const admission = { job_validation_id: id(3), recovery_lease_id: id(4) };
function recorded(unknown = false) {
  return {
    admission: { evidence: admission },
    lease: { recovery_lease_id: id(4) },
    outcome: {
      outcome_kind: unknown ? 'OUTCOME_UNKNOWN' : 'OUTCOME_OBSERVED',
      retryable: unknown,
      outcome_fact_id: id(5),
    },
  };
}
function progress(
  existingAdmission = false,
  existingOutcome: ReturnType<typeof recorded> | null = null
) {
  return {
    kind: existingAdmission ? 'NO_COMMITTED_EVENT' : 'NO_COMMITTED_ADMISSION',
    admission: existingAdmission ? { evidence: admission } : null,
    recordedOutcome: existingOutcome,
  };
}
function fixture() {
  // Isolate orchestration here; sealed receipt decoding and role restrictions
  // have separate unit and real PostgreSQL coverage.
  const calls: string[] = [];
  const d = {
    assertAuthorized: vi.fn(() => {
      calls.push('authorize');
    }),
    readProgress: vi.fn(async () => {
      calls.push('read');
      return progress();
    }),
    admit: vi.fn(async () => {
      calls.push('admit');
      return admission;
    }),
    issueExecutionCapability: vi.fn(async () => {
      calls.push('issue');
      return { opaque: true };
    }),
    execute: vi.fn(async () => {
      calls.push('execute');
    }),
    acquireReconcileLease: vi.fn(async () => {
      calls.push('lease');
      return { lease: { expires_at: new Date(Date.now() + 60_000).toISOString() } };
    }),
    recordOutcome: vi.fn(async () => {
      calls.push('outcome');
      return recorded();
    }),
    materialize: vi.fn(async () => {
      calls.push('materialize');
      return { financialEvent: { id: id(6) }, idempotencyReplayed: false };
    }),
  };
  const processor = new SyntheticFinancialCommandProcessor(
    d as unknown as NonNullable<
      ConstructorParameters<typeof SyntheticFinancialCommandProcessor>[0]
    >,
    id(7)
  );
  return { d, processor, calls };
}
describe('v13 financial ID-only worker orchestration', () => {
  it('fails the current queue attempt when reconciliation first commits a fence so BullMQ can retry', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.recordOutcome.mockResolvedValue({
      ...recorded(true),
      outcome: {
        ...recorded(true).outcome,
        outcome_kind: 'FAILED',
        failure_code: 'FAKE_ADMISSION_FENCED_NO_EFFECT',
      },
    } as ReturnType<typeof recorded>);
    await expect(f.processor.process(job())).rejects.toThrow('REDISPATCH_REQUIRED');
    expect(f.d.admit).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
    expect(f.d.materialize).not.toHaveBeenCalled();
  });
  it('re-admits only a committed fenced no-effect outcome using the actual queue attempt', async () => {
    const f = fixture();
    const fence = {
      ...recorded(true),
      outcome: {
        ...recorded(true).outcome,
        outcome_kind: 'FAILED',
        effect_certainty: 'CONFIRMED_NO_EFFECT',
        failure_code: 'FAKE_ADMISSION_FENCED_NO_EFFECT',
      },
    };
    f.d.readProgress.mockResolvedValue(progress(true, fence));
    const result = await f.processor.process({ ...job(), attemptsMade: 7 });
    expect(result.state).toBe('MATERIALIZED');
    expect(f.d.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ bullmqAttemptNumber: 7 })
    );
    expect(f.d.acquireReconcileLease).not.toHaveBeenCalled();
    expect(f.d.execute).toHaveBeenCalledOnce();
  });
  it('returns fenced retry identity from durable recovery without inventing a queue attempt', async () => {
    const f = fixture();
    const fence = {
      ...recorded(true),
      outcome: {
        ...recorded(true).outcome,
        outcome_kind: 'FAILED',
        effect_certainty: 'CONFIRMED_NO_EFFECT',
        failure_code: 'FAKE_ADMISSION_FENCED_NO_EFFECT',
      },
    };
    f.d.readProgress.mockResolvedValue(progress(true, fence));
    expect(await f.processor.recover({ jobId: job().id, payload })).toEqual({
      commandId: payload.commandId,
      state: 'REDISPATCH_REQUIRED',
      outcomeFactId: id(5),
    });
    expect(f.d.admit).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
    expect(f.d.acquireReconcileLease).not.toHaveBeenCalled();
    expect(f.d.materialize).not.toHaveBeenCalled();
  });
  it('recovers from database identity without Redis or a BullMQ attempt', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    await f.processor.recover({ jobId: job().id, payload });
    expect(f.d.acquireReconcileLease).toHaveBeenCalledOnce();
    expect(f.d.materialize).toHaveBeenCalledOnce();
    expect(f.d.admit).not.toHaveBeenCalled();
    expect(f.d.issueExecutionCapability).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it('does not turn absent admission discovered in the database into dispatch authority', async () => {
    const f = fixture();
    await expect(f.processor.recover({ jobId: job().id, payload })).rejects.toThrow(
      'COMMITTED_ADMISSION_REQUIRED'
    );
    expect(f.d.admit).not.toHaveBeenCalled();
    expect(f.d.issueExecutionCapability).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it.each([
    { jobId: 'forged', payload },
    { jobId: job().id, payload: { ...payload, actorId: id(7) } },
    { jobId: job().id, payload, attemptsMade: 0 },
  ])('rejects an invalid recovery binding before database access', async (invalid) => {
    const f = fixture();
    await expect(f.processor.recover(invalid)).rejects.toThrow();
    expect(f.d.readProgress).not.toHaveBeenCalled();
  });
  it('reads progress then commits admission, execution, outcome and materialization in sequence', async () => {
    const f = fixture(),
      result = await f.processor.process(job());
    expect(f.calls.filter((x) => x !== 'authorize')).toEqual([
      'read',
      'admit',
      'issue',
      'execute',
      'outcome',
      'materialize',
    ]);
    expect(f.d.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        workerInstanceId: id(7),
        bullmqAttemptNumber: 0,
        leaseSeconds: 60,
        outcomeTimeoutSeconds: 45,
      })
    );
    expect(result).toEqual({
      commandId: id(2),
      state: 'MATERIALIZED',
      outcomeFactId: id(5),
      financialEventId: id(6),
      idempotencyReplayed: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    [
      'legacy signed envelope',
      {
        ...job(),
        name: 'synthetic_finance.event',
        data: { payload: { actorId: id(7) }, _sig: 'signed' },
      },
    ],
    ['wrong queue', { ...job(), queueName: 'escrow' }],
    ['extra actor', { ...job(), data: { ...payload, actorId: id(7) } }],
    ['extra command', { ...job(), data: { ...payload, command: { amountCents: 100 } } }],
    ['wrong job ID', { ...job(), id: 'forged' }],
    ['missing job ID', { ...job(), id: undefined }],
    ['attempt overflow', { ...job(), attemptsMade: 64 }],
    [
      'terminal envelope',
      {
        ...job(),
        data: { version: 1, kind: 'FINANCIAL_EVENT', command: { operationKind: 'CAPTURE' } },
      },
    ],
    ['reconciliation envelope', { ...job(), data: { version: 1, kind: 'RECONCILIATION' } }],
  ])('rejects %s before database authority or execution', async (_label, invalid) => {
    const f = fixture();
    await expect(f.processor.process(invalid)).rejects.toThrow();
    expect(f.d.readProgress).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it('replays a terminal committed outcome without new admission or execution', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true, recorded()));
    await f.processor.process(job());
    expect(f.d.admit).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
    expect(f.d.materialize).toHaveBeenCalledOnce();
  });
  it('recovers an existing admission through a reconcile lease without executing it again', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    await f.processor.process(job());
    expect(f.d.acquireReconcileLease).toHaveBeenCalledOnce();
    expect(f.d.admit).not.toHaveBeenCalled();
    expect(f.d.issueExecutionCapability).not.toHaveBeenCalled();
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it('keeps missing-event UNKNOWN unresolved without redispatch or materialization', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.recordOutcome.mockResolvedValue(recorded(true));
    await expect(f.processor.process(job())).rejects.toThrow('RECOVERY_REQUIRED');
    expect(f.d.execute).not.toHaveBeenCalled();
    expect(f.d.materialize).not.toHaveBeenCalled();
  });
  it('records a fresh observation after a prior UNKNOWN instead of replaying its outcome', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true, recorded(true)));
    await f.processor.process(job());
    expect(f.d.acquireReconcileLease).toHaveBeenCalledOnce();
    expect(f.d.recordOutcome).toHaveBeenCalledOnce();
    expect(f.d.materialize).toHaveBeenCalledOnce();
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it.each([
    'admit',
    'issueExecutionCapability',
    'execute',
    'recordOutcome',
    'materialize',
  ] as const)(
    'propagates uncertain %s and reads committed progress before retrying',
    async (stage) => {
      const f = fixture();
      f.d[stage].mockRejectedValueOnce(new Error('ACK_LOST'));
      await expect(f.processor.process(job())).rejects.toThrow('ACK_LOST');
      const executions = f.d.execute.mock.calls.length;
      f.d.readProgress.mockResolvedValue(progress(true, recorded()));
      await f.processor.process({ ...job(), attemptsMade: 1 });
      expect(f.d.readProgress).toHaveBeenCalledTimes(2);
      expect(f.d.execute).toHaveBeenCalledTimes(executions);
    }
  );
  it('retains a reconcile lease identity after an uncertain acquisition acknowledgement', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.acquireReconcileLease.mockRejectedValueOnce(new Error('LEASE_ACK_LOST'));
    await expect(f.processor.process(job())).rejects.toThrow('LEASE_ACK_LOST');
    await f.processor.process({ ...job(), attemptsMade: 1 });
    const calls = f.d.acquireReconcileLease.mock.calls as unknown as Array<
      [{ recoveryLeaseId: string }]
    >;
    expect(calls[1][0].recoveryLeaseId).toBe(calls[0][0].recoveryLeaseId);
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it.each([
    'HXFPCREC1-V13: command already has an active recovery lease',
    'HXFPCREC1-V13: dispatch outcome deadline has not elapsed',
    'HXFPCREC1-V13: reconciliation requires a due explicit nonterminal outcome',
  ])('releases a definitively refused lease cache slot: %s', async (message) => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.acquireReconcileLease.mockRejectedValueOnce(
      Object.assign(new Error(message), { code: 'P0001' })
    );
    await expect(f.processor.recover({ jobId: job().id, payload })).rejects.toThrow(message);
    await f.processor.recover({ jobId: job().id, payload });
    const calls = f.d.acquireReconcileLease.mock.calls as unknown as Array<
      [{ recoveryLeaseId: string }]
    >;
    expect(calls[1][0].recoveryLeaseId).not.toBe(calls[0][0].recoveryLeaseId);
    expect(f.d.execute).not.toHaveBeenCalled();
  });
  it('uses database expiry authority even when the local clock sees an old lease', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.acquireReconcileLease.mockResolvedValueOnce({
      lease: { expires_at: '2000-01-01T00:00:00.000Z' },
    });
    await f.processor.process(job());
    expect(f.d.recordOutcome).toHaveBeenCalledOnce();
    expect(f.d.materialize).toHaveBeenCalledOnce();
  });
  it('retires a lease only after the precise database expiry rejection', async () => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.recordOutcome.mockRejectedValueOnce(
      Object.assign(new Error('HXFPCREC1: recovery lease expired before outcome commitment'), {
        code: 'P0001',
      })
    );
    await expect(f.processor.process(job())).rejects.toThrow('recovery lease expired');
    await f.processor.process({ ...job(), attemptsMade: 1 });
    const calls = f.d.acquireReconcileLease.mock.calls as unknown as Array<
      [{ recoveryLeaseId: string }]
    >;
    expect(calls[1][0].recoveryLeaseId).not.toBe(calls[0][0].recoveryLeaseId);
  });
  it.each([
    new Error('OUTCOME_ACK_LOST'),
    new Error('HXFPCREC1: recovery lease expired before outcome commitment'),
    Object.assign(new Error('HXFPCREC1: recovery lease expired before outcome commitment'), {
      code: '08006',
    }),
    Object.assign(new Error('HXFPCREC1: another rejection'), { code: 'P0001' }),
  ])('retains lease identity for an uncertain or different outcome failure %s', async (error) => {
    const f = fixture();
    f.d.readProgress.mockResolvedValue(progress(true));
    f.d.recordOutcome.mockRejectedValueOnce(error);
    await expect(f.processor.process(job())).rejects.toThrow(error.message);
    await f.processor.process({ ...job(), attemptsMade: 1 });
    const calls = f.d.acquireReconcileLease.mock.calls as unknown as Array<
      [{ recoveryLeaseId: string }]
    >;
    expect(calls[1][0].recoveryLeaseId).toBe(calls[0][0].recoveryLeaseId);
  });
  it('releases bounded recovery capacity when other workers commit terminal outcomes', async () => {
    const f = fixture();
    for (let index = 0; index < 1024; index++) {
      const commandId = id(index + 100),
        data = { ...payload, commandId };
      const current = {
        ...job(),
        data,
        id: 'hx-fake-fin-' + commandId.replaceAll('-', '') + '-' + payload.jobAuthoritySha256,
      };
      f.d.readProgress
        .mockResolvedValueOnce(progress(true))
        .mockResolvedValueOnce(progress(true, recorded()));
      f.d.acquireReconcileLease.mockRejectedValueOnce(new Error('LEASE_ACK_LOST'));
      await expect(f.processor.process(current)).rejects.toThrow('LEASE_ACK_LOST');
      await f.processor.process({ ...current, attemptsMade: 1 });
    }
    f.d.readProgress.mockResolvedValue(progress(true));
    await f.processor.process(job());
    expect(f.d.execute).not.toHaveBeenCalled();
    expect(f.d.acquireReconcileLease).toHaveBeenCalledTimes(1025);
  });
  it('refuses concurrent processing of the same job within one processor', async () => {
    const f = fixture();
    let release!: () => void;
    f.d.readProgress.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return progress();
    });
    const first = f.processor.process(job());
    await expect(f.processor.process(job())).rejects.toThrow('JOB_ALREADY_RUNNING');
    release();
    await first;
    expect(f.d.admit).toHaveBeenCalledOnce();
  });
});
