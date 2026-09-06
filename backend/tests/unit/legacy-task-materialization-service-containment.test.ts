import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    transaction: vi.fn(async (work: (execute: typeof query) => Promise<unknown>) => work(query)),
    insertCanonicalTask: vi.fn(),
    insertTaskDependents: vi.fn(),
    writeToOutbox: vi.fn(),
    canCreateTaskWithRisk: vi.fn(),
    analyzeTaskScope: vi.fn(),
    resolveRegionPolicy: vi.fn(),
    evaluateTaskAgainstRegionPolicy: vi.fn(),
  };
});

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => 'Database error'),
}));
vi.mock('../../src/logger.js', () => ({
  taskLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  escrowLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/lib/outbox-helpers.js', () => ({ writeToOutbox: mocks.writeToOutbox }));
vi.mock('../../src/services/PlanService.js', () => ({
  PlanService: { canCreateTaskWithRisk: mocks.canCreateTaskWithRisk },
}));
vi.mock('../../src/services/ScoperAIService.js', () => ({
  ScoperAIService: { analyzeTaskScope: mocks.analyzeTaskScope },
}));
vi.mock('../../src/services/RegionPolicyService.js', () => ({
  resolveRegionPolicy: mocks.resolveRegionPolicy,
  evaluateTaskAgainstRegionPolicy: mocks.evaluateTaskAgainstRegionPolicy,
}));
vi.mock('../../src/services/TaskLocationService.js', () => ({
  deriveRoughArea: vi.fn(() => 'Bellevue, WA'),
  redactPrivateLocation: vi.fn((value: string | undefined | null) => value ?? null),
}));
vi.mock('../../src/services/TaskLocationCrypto.js', () => ({
  TaskLocationCryptoError: class extends Error {},
}));
vi.mock('../../src/services/TaskCreatePersistence.js', () => ({
  insertCanonicalTask: mocks.insertCanonicalTask,
  insertTaskDependents: mocks.insertTaskDependents,
}));
vi.mock('../../src/services/LegacyTaskMaterializationGuard.js', () => ({
  legacyTaskMaterializationFailure: vi.fn((lane: string) => ({
    success: false,
    error: {
      code: 'LEGACY_TASK_MATERIALIZATION_FROZEN',
      message: 'Legacy direct Task and PENDING escrow materialization is frozen.',
      details: { lane },
    },
  })),
}));

import { createEscrow } from '../../src/services/EscrowReadService.js';
import { TaskCreateService } from '../../src/services/TaskCreateService.js';
import { buildTaskCreateRequestHash, type CreateTaskParams } from '../../src/services/TaskServiceShared.js';

const params = (idempotencyKey?: string): CreateTaskParams => ({
  posterId: '00000000-0000-4000-8000-000000000001',
  title: 'Legacy materialization attempt',
  description: 'A legacy direct task creation attempt that must remain contained.',
  price: 10_000,
  hustlerPayoutCents: 8_000,
  platformMarginCents: 2_000,
  location: '42 Private Lane',
  roughArea: 'Bellevue, WA',
  regionCode: 'US-WA',
  category: 'GENERAL',
  riskLevel: 'LOW',
  mode: 'STANDARD',
  instantMode: false,
  automationClassification: 'PRODUCTION',
  ...(idempotencyKey ? { clientIdempotencyKey: idempotencyKey } : {}),
});

describe('legacy Task/PENDING-escrow service containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset();
    mocks.transaction.mockReset();
    mocks.canCreateTaskWithRisk.mockReset();
    mocks.analyzeTaskScope.mockReset();
    mocks.resolveRegionPolicy.mockReset();
    mocks.evaluateTaskAgainstRegionPolicy.mockReset();
    mocks.canCreateTaskWithRisk.mockResolvedValue({ allowed: true });
    mocks.resolveRegionPolicy.mockResolvedValue({
      id: '10000000-0000-4000-8000-000000000001',
      region_code: 'US-WA',
      version: 'test-v1',
      policy_hash: 'a'.repeat(64),
    });
    mocks.evaluateTaskAgainstRegionPolicy.mockReturnValue({
      allowed: true,
      reasons: [],
      snapshot: {
        policyId: '10000000-0000-4000-8000-000000000001',
        policyVersion: 'test-v1',
        policyHash: 'a'.repeat(64),
        regionCode: 'US-WA',
        locationState: 'WA',
        licenseRequired: false,
        insuranceRequired: false,
        backgroundCheckRequired: false,
        proofRequired: true,
        proofMinPhotos: 1,
        proofMaxPhotos: 5,
        proofGpsRequired: false,
        currency: 'usd',
      },
    });
    mocks.transaction.mockImplementation(
      async (work: (query: typeof mocks.query) => Promise<unknown>) => work(mocks.query),
    );
  });

  it('returns the stable freeze before direct Task, escrow, outbox, or matching writes', async () => {
    const result = await TaskCreateService.create(params());

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'LEGACY_TASK_MATERIALIZATION_FROZEN',
        details: { lane: 'task_create' },
      },
    });
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
    expect(mocks.writeToOutbox).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rolls back the transaction-bound savepoint without a domain write', async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const result = await TaskCreateService.createInTransaction(mocks.query, params());

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'LEGACY_TASK_MATERIALIZATION_FROZEN',
        details: { lane: 'task_create_in_transaction' },
      },
    });
    expect(mocks.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'SAVEPOINT hustlexp_task_create',
      'ROLLBACK TO SAVEPOINT hustlexp_task_create',
      'RELEASE SAVEPOINT hustlexp_task_create',
    ]);
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
  });

  it('preserves an exact read-only idempotent replay ahead of the freeze', async () => {
    const input = params('legacy-replay-0001');
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000001',
        version: '1',
        poster_id: input.posterId,
        title: input.title,
        description: input.description,
        state: 'OPEN',
        request_hash: buildTaskCreateRequestHash(input),
      }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.resolveRegionPolicy.mockRejectedValueOnce(new Error('region policy unavailable'));
    mocks.canCreateTaskWithRisk.mockResolvedValueOnce({ allowed: false, reason: 'plan changed' });

    const result = await TaskCreateService.createInTransaction(mocks.query, input);

    expect(result).toMatchObject({
      success: true,
      data: {
        id: '20000000-0000-4000-8000-000000000001',
        idempotency_replayed: true,
      },
    });
    expect(mocks.resolveRegionPolicy).not.toHaveBeenCalled();
    expect(mocks.canCreateTaskWithRisk).not.toHaveBeenCalled();
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
  });

  it('replays create before mutable policy dependencies can deny or throw', async () => {
    const input = params('legacy-replay-create-0002');
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: '20000000-0000-4000-8000-000000000002',
      version: '1',
      poster_id: input.posterId,
      title: input.title,
      description: input.description,
      state: 'OPEN',
      request_hash: buildTaskCreateRequestHash(input),
    }] });
    mocks.resolveRegionPolicy.mockRejectedValueOnce(new Error('region policy unavailable'));
    mocks.canCreateTaskWithRisk.mockResolvedValueOnce({ allowed: false, reason: 'plan changed' });

    const result = await TaskCreateService.create(input);

    expect(result).toMatchObject({
      success: true,
      data: {
        id: '20000000-0000-4000-8000-000000000002',
        idempotency_replayed: true,
      },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.resolveRegionPolicy).not.toHaveBeenCalled();
    expect(mocks.canCreateTaskWithRisk).not.toHaveBeenCalled();
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
  });

  it('returns a deterministic create conflict before mutable policy dependencies', async () => {
    const input = params('legacy-conflict-create-0003');
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: '20000000-0000-4000-8000-000000000003',
      request_hash: 'different-request-hash',
    }] });
    mocks.resolveRegionPolicy.mockRejectedValueOnce(new Error('region policy unavailable'));
    mocks.canCreateTaskWithRisk.mockResolvedValueOnce({ allowed: false, reason: 'plan changed' });

    const result = await TaskCreateService.create(input);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was already used with different task input.',
        details: { existingTaskId: '20000000-0000-4000-8000-000000000003' },
      },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.resolveRegionPolicy).not.toHaveBeenCalled();
    expect(mocks.canCreateTaskWithRisk).not.toHaveBeenCalled();
  });

  it('returns a deterministic transaction-bound conflict before mutable policy dependencies', async () => {
    const input = params('legacy-conflict-transaction-0004');
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000004',
        request_hash: 'different-request-hash',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.resolveRegionPolicy.mockRejectedValueOnce(new Error('region policy unavailable'));
    mocks.canCreateTaskWithRisk.mockResolvedValueOnce({ allowed: false, reason: 'plan changed' });

    const result = await TaskCreateService.createInTransaction(mocks.query, input);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was already used with different task input.',
        details: { existingTaskId: '20000000-0000-4000-8000-000000000004' },
      },
    });
    expect(mocks.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'SAVEPOINT hustlexp_task_create',
      expect.stringContaining('FROM task_create_requests'),
      'RELEASE SAVEPOINT hustlexp_task_create',
    ]);
    expect(mocks.resolveRegionPolicy).not.toHaveBeenCalled();
    expect(mocks.canCreateTaskWithRisk).not.toHaveBeenCalled();
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
  });

  it('fails closed when the early idempotency lookup is unavailable', async () => {
    const input = params('legacy-lookup-failure-0005');
    mocks.query.mockRejectedValueOnce(new Error('idempotency store unavailable'));

    const result = await TaskCreateService.create(input);

    expect(result).toEqual({
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.resolveRegionPolicy).not.toHaveBeenCalled();
    expect(mocks.canCreateTaskWithRisk).not.toHaveBeenCalled();
  });

  it('rolls back and fails closed when the transaction-bound replay lookup is unavailable', async () => {
    const input = params('legacy-lookup-failure-transaction-0006');
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('idempotency store unavailable'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await TaskCreateService.createInTransaction(mocks.query, input);

    expect(result).toEqual({
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    });
    expect(mocks.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'SAVEPOINT hustlexp_task_create',
      expect.stringContaining('FROM task_create_requests'),
      'ROLLBACK TO SAVEPOINT hustlexp_task_create',
      'RELEASE SAVEPOINT hustlexp_task_create',
    ]);
    expect(mocks.resolveRegionPolicy).not.toHaveBeenCalled();
    expect(mocks.canCreateTaskWithRisk).not.toHaveBeenCalled();
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
  });

  it('keeps the locked recheck immediately before the freeze and writes', async () => {
    const input = params('legacy-race-recheck-0007');
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000007',
        version: '1',
        poster_id: input.posterId,
        title: input.title,
        description: input.description,
        state: 'OPEN',
        request_hash: buildTaskCreateRequestHash(input),
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await TaskCreateService.createInTransaction(mocks.query, input);

    expect(result).toMatchObject({
      success: true,
      data: {
        id: '20000000-0000-4000-8000-000000000007',
        idempotency_replayed: true,
      },
    });
    expect(mocks.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'SAVEPOINT hustlexp_task_create',
      expect.stringContaining('FROM task_create_requests'),
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('FROM task_create_requests'),
      'RELEASE SAVEPOINT hustlexp_task_create',
    ]);
    expect(mocks.insertCanonicalTask).not.toHaveBeenCalled();
    expect(mocks.insertTaskDependents).not.toHaveBeenCalled();
  });

  it('contains the standalone legacy PENDING escrow creator before SQL', async () => {
    const result = await createEscrow({ taskId: 'task-1', amount: 5_000 });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'LEGACY_TASK_MATERIALIZATION_FROZEN',
        details: { lane: 'pending_escrow_create' },
      },
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
