import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  rowCount: 0,
  failCommit: false,
  changeAtCommit: false,
  digest: 'a'.repeat(64),
  query: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock('../../src/db.js', () => ({
  db: {
    transaction: async (callback: (query: QueryFn) => Promise<unknown>) => {
      const value = await callback(async <T>(sql: string, params?: unknown[]) => {
        state.query(sql, params);
        return { rows: state.rows as T[], rowCount: state.rowCount };
      });
      if (state.failCommit) throw Error('COMMIT_UNCONFIRMED');
      if (state.changeAtCommit) state.digest = 'b'.repeat(64);
      return value;
    },
  },
}));
vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', () => ({
  assertNonproductionFakeFinanceAuthorized: state.authorize,
}));
vi.mock('../../src/jobs/runtime-database-startup-config.js', () => ({
  configuredRuntimeDatabaseStartup: () => ({
    expectedTarget: { environment: 'local', databaseName: 'hx_ci_system_test' },
    targetDigest: 'target',
  }),
}));
vi.mock('../../src/releaseManifest.js', async (original) => ({
  ...(await original<typeof import('../../src/releaseManifest.js')>()),
  releaseManifestDigest: () => state.digest,
}));
import {
  FakeFinancialDurableRecovery,
  PostgresFakeFinancialDurableRecoveryRepository,
} from '../../src/jobs/fake-financial-durable-recovery.js';
import { PostgresFakeFinancialOutboxRepository } from '../../src/jobs/fake-financial-outbox-publisher.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function candidate(n = 1) {
  return {
    outbox_request_id: id(n),
    command_id: id(n + 100),
    bullmq_job_id: 'hx-fake-fin-' + id(n + 100).replaceAll('-', '') + '-' + 'a'.repeat(64),
    job_authority_sha256: 'a'.repeat(64),
    admission_present: false,
    publication_confirmed: true,
    publication_held: false,
  };
}
function restoration() {
  const c = candidate();
  return {
    outbox_request_id: c.outbox_request_id,
    command_id: c.command_id,
    bullmq_job_id: c.bullmq_job_id,
    job_authority_sha256: c.job_authority_sha256,
    queue_name: 'synthetic_finance' as const,
    job_name: 'synthetic_finance.command.v13' as const,
    job_payload: {
      version: 1 as const,
      kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND' as const,
      outboxRequestId: c.outbox_request_id,
      commandId: c.command_id,
      jobAuthoritySha256: c.job_authority_sha256,
    },
    historical_publish_outcome_id: id(900),
  };
}
function stored() {
  const r = restoration();
  return {
    id: r.bullmq_job_id,
    queueName: r.queue_name,
    name: r.job_name,
    data: r.job_payload,
    opts: {
      jobId: r.bullmq_job_id,
      attempts: 64,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
    state: 'waiting',
    attemptsMade: 0,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.rowCount = 0;
  state.failCommit = false;
  state.changeAtCommit = false;
  state.digest = 'a'.repeat(64);
  state.authorize.mockReturnValue({ environment: 'local' });
});
function response(rows: unknown[]) {
  state.rows = rows;
  state.rowCount = rows.length;
}
describe('sealed durable recovery repository', () => {
  const repository = new PostgresFakeFinancialDurableRecoveryRepository();
  it('returns frozen ID-only ordered rows after committed fixed-port read', async () => {
    response([candidate(1), candidate(2)]);
    const rows = await repository.scan({ afterOutboxRequestId: null, limit: 2 });
    expect(state.query).toHaveBeenCalledWith(
      'SELECT * FROM public.hxos_scan_fake_financial_recovery_v13($1,$2)',
      [null, 2]
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(state.authorize).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['extra field', [{ ...candidate(), actor: id(9) }]],
    ['wrong ID', [{ ...candidate(), bullmq_job_id: 'forged' }]],
    ['not boolean', [{ ...candidate(), admission_present: 'true' }]],
    ['duplicate', [candidate(), candidate()]],
    ['backwards', [candidate(2), candidate(1)]],
  ])('rejects %s', async (_label, rows) => {
    response(rows);
    await expect(repository.scan({ afterOutboxRequestId: null, limit: 2 })).rejects.toThrow();
  });
  it('rejects rows at the cursor and excess cardinality', async () => {
    response([candidate()]);
    await expect(repository.scan({ afterOutboxRequestId: id(1), limit: 2 })).rejects.toThrow(
      'SCAN_ORDER'
    );
    response([candidate(1), candidate(2)]);
    await expect(repository.scan({ afterOutboxRequestId: null, limit: 1 })).rejects.toThrow(
      'CARDINALITY'
    );
  });
  it.each(['scan', 'readRestoration'] as const)(
    'refuses an uncertain commit or changed release for %s',
    async (method) => {
      const invoke = () =>
        method === 'scan'
          ? repository.scan({ afterOutboxRequestId: null, limit: 2 })
          : repository.readRestoration(candidate());
      response(method === 'scan' ? [candidate()] : [restoration()]);
      state.failCommit = true;
      await expect(invoke()).rejects.toThrow('COMMIT_UNCONFIRMED');
      state.failCommit = false;
      state.changeAtCommit = true;
      await expect(invoke()).rejects.toThrow('AUTHORITY_CHANGED');
    }
  );
  it('keeps restoration separate from an issued publication claim', async () => {
    response([restoration()]);
    const receipt = await repository.readRestoration(candidate());
    expect(Object.isFrozen(receipt.job_payload)).toBe(true);
    const transaction = vi.fn();
    const publisher = new PostgresFakeFinancialOutboxRepository({ transaction });
    await expect(
      publisher.recordOutcome(receipt as unknown as Parameters<typeof publisher.recordOutcome>[0], {
        kind: 'BULLMQ_CONFIRMED',
      })
    ).rejects.toThrow('CLAIM_NOT_ISSUED');
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    { ...restoration(), command_id: id(999) },
    { ...restoration(), job_payload: { ...restoration().job_payload, outboxRequestId: id(999) } },
    { ...restoration(), publish_claim_id: id(999) },
  ])('rejects mismatched or claim-shaped restoration evidence', async (row) => {
    response([row]);
    await expect(repository.readRestoration(candidate())).rejects.toThrow();
  });
});
function sweeper(limit = 2) {
  const d = {
    repository: {
      scan: vi.fn(async () => [candidate()]),
      readRestoration: vi.fn(async () => restoration()),
    },
    transport: { publish: vi.fn(async () => stored()) },
    recover: vi.fn(async () => ({})),
    assertAuthorized: vi.fn(),
  };
  return { d, worker: new FakeFinancialDurableRecovery(d, limit) };
}
describe('durable recovery sweeps', () => {
  it('restores a fenced admitted request through a fresh database restoration read', async () => {
    const f = sweeper();
    f.d.repository.scan.mockResolvedValue([{ ...candidate(), admission_present: true }]);
    f.d.recover.mockResolvedValue({
      commandId: candidate().command_id,
      state: 'REDISPATCH_REQUIRED',
      outcomeFactId: id(900),
    });
    expect(await f.worker.runOnce()).toMatchObject({
      recovered: 0,
      transportConfirmed: 1,
      errors: 0,
    });
    expect(f.d.repository.readRestoration).toHaveBeenCalledOnce();
    expect(f.d.transport.publish).toHaveBeenCalledOnce();
  });
  it.each([
    { commandId: id(999), state: 'REDISPATCH_REQUIRED', outcomeFactId: id(900) },
    {
      commandId: candidate().command_id,
      state: 'REDISPATCH_REQUIRED',
      outcomeFactId: id(900),
      attemptsMade: 0,
    },
  ])('refuses mismatched or widened fence receipts before restoration', async (receipt) => {
    const f = sweeper();
    f.d.repository.scan.mockResolvedValue([{ ...candidate(), admission_present: true }]);
    f.d.recover.mockResolvedValue(receipt);
    expect(await f.worker.runOnce()).toMatchObject({
      recovered: 0,
      transportConfirmed: 0,
      errors: 1,
    });
    expect(f.d.repository.readRestoration).not.toHaveBeenCalled();
  });
  it.each(['failed', 'exhausted', 'publication_held', 'not_due'])(
    'preserves %s after fenced recovery without resetting transport attempts',
    async (condition) => {
      const f = sweeper();
      f.d.repository.scan.mockResolvedValue([
        {
          ...candidate(),
          admission_present: true,
          publication_held: condition === 'publication_held',
        },
      ]);
      f.d.recover.mockResolvedValue({
        commandId: candidate().command_id,
        state: 'REDISPATCH_REQUIRED',
        outcomeFactId: id(900),
      });
      if (condition === 'failed')
        f.d.transport.publish.mockResolvedValue({ ...stored(), state: 'failed' });
      if (condition === 'exhausted')
        f.d.transport.publish.mockResolvedValue({ ...stored(), attemptsMade: 64 });
      if (condition === 'not_due')
        f.d.repository.readRestoration.mockRejectedValue(
          Object.assign(new Error('HXUV1-FINRESTORE-13-FENCE_NOT_DUE'), { code: 'P0001' })
        );
      expect(await f.worker.runOnce()).toMatchObject({
        recovered: 0,
        transportConfirmed: 0,
        errors: 0,
        held: condition === 'not_due' ? 0 : 1,
        deferred: condition === 'not_due' ? 1 : 0,
      });
      if (condition === 'publication_held' || condition === 'not_due')
        expect(f.d.transport.publish).not.toHaveBeenCalled();
    }
  );
  it('restores the same identity and never invokes admitted recovery for an unadmitted request', async () => {
    const f = sweeper();
    expect(await f.worker.runOnce()).toMatchObject({
      scanned: 1,
      transportConfirmed: 1,
      errors: 0,
      sweepCompleted: true,
    });
    expect(f.d.transport.publish).toHaveBeenCalledWith(restoration(), undefined);
    expect(f.d.recover).not.toHaveBeenCalled();
  });
  it('recovers admitted historical holds without consulting Redis', async () => {
    const f = sweeper();
    f.d.repository.scan.mockResolvedValue([
      { ...candidate(), admission_present: true, publication_held: true },
    ]);
    expect(await f.worker.runOnce()).toMatchObject({ recovered: 1, held: 0 });
    expect(f.d.recover).toHaveBeenCalledOnce();
    expect(f.d.transport.publish).not.toHaveBeenCalled();
    expect(f.d.repository.readRestoration).not.toHaveBeenCalled();
  });
  it('leaves unpublished and held requests with their respective authorities', async () => {
    const f = sweeper();
    f.d.repository.scan.mockResolvedValue([
      { ...candidate(), publication_held: true },
      { ...candidate(2), publication_confirmed: false },
    ]);
    expect(await f.worker.runOnce()).toMatchObject({ held: 1, awaitingPublisher: 1 });
    expect(f.d.transport.publish).not.toHaveBeenCalled();
    expect(f.d.recover).not.toHaveBeenCalled();
  });
  it.each(['failed', 'completed', 'unknown', 'waiting-children', 'prioritized'])(
    'retains an existing %s job as a hold',
    async (state) => {
      const f = sweeper();
      f.d.transport.publish.mockResolvedValue({ ...stored(), state });
      expect(await f.worker.runOnce()).toMatchObject({ held: 1, transportConfirmed: 0 });
    }
  );
  it('holds an exhausted or mismatched job', async () => {
    const f = sweeper();
    f.d.transport.publish
      .mockResolvedValueOnce({ ...stored(), attemptsMade: 64 })
      .mockResolvedValueOnce({ ...stored(), id: 'wrong' });
    expect(await f.worker.runOnce()).toMatchObject({ held: 1 });
    expect(await f.worker.runOnce()).toMatchObject({ held: 1 });
  });
  it.each([
    new Error('FAKE_FINANCIAL_WORKER_JOB_ALREADY_RUNNING'),
    Object.assign(new Error('HXFPCREC1-V13: dispatch outcome deadline has not elapsed'), {
      code: 'P0001',
    }),
    Object.assign(new Error('HXFPCREC1-V13: command already has an active recovery lease'), {
      code: 'P0001',
    }),
  ])('defers ordinary in-flight recovery without claiming success', async (error) => {
    const f = sweeper();
    f.d.repository.scan.mockResolvedValue([{ ...candidate(), admission_present: true }]);
    f.d.recover.mockRejectedValue(error);
    expect(await f.worker.runOnce()).toMatchObject({ deferred: 1, errors: 0, recovered: 0 });
  });
  it('does not hide an untyped or uncertain lease error as a deferral', async () => {
    const f = sweeper();
    f.d.repository.scan.mockResolvedValue([{ ...candidate(), admission_present: true }]);
    f.d.recover.mockRejectedValue(
      new Error('HXFPCREC1-V13: dispatch outcome deadline has not elapsed')
    );
    expect(await f.worker.runOnce()).toMatchObject({ deferred: 0, errors: 1 });
  });
  it('advances past failures and resets only at the end of the sweep', async () => {
    const f = sweeper();
    f.d.repository.scan
      .mockResolvedValueOnce([candidate(1), candidate(2)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate(1)]);
    f.d.repository.readRestoration.mockRejectedValue(new Error('UNCERTAIN'));
    expect(await f.worker.runOnce()).toMatchObject({ errors: 2, sweepCompleted: false });
    expect(await f.worker.runOnce()).toMatchObject({ sweepCompleted: true });
    await f.worker.runOnce();
    expect(f.d.repository.scan.mock.calls).toEqual([
      [{ afterOutboxRequestId: null, limit: 2 }],
      [{ afterOutboxRequestId: id(2), limit: 2 }],
      [{ afterOutboxRequestId: null, limit: 2 }],
    ]);
  });
  it('serializes sweeps and honors abort before any transport mutation', async () => {
    const f = sweeper();
    let release!: () => void;
    f.d.repository.readRestoration.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return restoration();
    });
    const controller = new AbortController(),
      active = f.worker.runOnce(controller.signal);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.worker.runOnce()).rejects.toThrow('ALREADY_RUNNING');
    controller.abort();
    release();
    expect(await active).toMatchObject({ scanned: 0, sweepCompleted: false });
    expect(f.d.transport.publish).not.toHaveBeenCalled();
  });
});
