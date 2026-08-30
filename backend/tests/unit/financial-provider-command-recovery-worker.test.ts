import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FINANCIAL_PROVIDER_COMMAND_RECOVERY_INTEGRATION_BLOCKERS,
  NonproductionFakeFinancialCommandRecoveryWorker,
  financialProviderOutcomeProjectionSha256,
  type FakeFinancialCommandRecoveryExecutor,
} from '../../src/jobs/financial-provider-command-recovery-worker.js';
import type { FinancialOperationResult } from '../../src/services/payment/FinancialProviderPorts.js';
import type {
  FinancialProviderCommandDispatchAttempt,
  FinancialProviderCommandOutcomeFact,
  FinancialProviderCommandRecoveryClaim,
  FinancialProviderCommandRecoveryRepository,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';

const ids = {
  command: '10000000-0000-4000-8000-000000000001',
  operation: '10000000-0000-4000-8000-000000000002',
  taskDraft: '10000000-0000-4000-8000-000000000003',
  task: '10000000-0000-4000-8000-000000000004',
  owner: '10000000-0000-4000-8000-000000000005',
  lease: '10000000-0000-4000-8000-000000000006',
  attempt: '10000000-0000-4000-8000-000000000007',
  fact: '10000000-0000-4000-8000-000000000008',
} as const;

const attempt: FinancialProviderCommandDispatchAttempt = {
  dispatchAttemptId: ids.attempt,
  commandId: ids.command,
  recoveryLeaseId: ids.lease,
  attemptNumber: 1,
  requestSha256: 'a'.repeat(64),
  outcomeTimeoutSeconds: 30,
  attemptedAt: '2026-08-28T20:00:00.000Z',
  outcomeDeadlineAt: '2026-08-28T20:00:30.000Z',
  attemptIdentitySha256: 'b'.repeat(64),
  idempotencyReplayed: false,
};

function claim(
  overrides: Partial<FinancialProviderCommandRecoveryClaim> = {}
): FinancialProviderCommandRecoveryClaim {
  return {
    command: {
      commandId: ids.command,
      operationKind: 'AUTHORIZE',
      operationId: ids.operation,
      providerKind: 'FAKE',
      idempotencyKey: 'finance-recovery-command:unit',
      providerExpectedVersion: 0,
      requestSha256: 'a'.repeat(64),
      commandIdentitySha256: 'c'.repeat(64),
      preparedFinancialCommandId: null,
      preparedAuthoritySha256: null,
      taskDraftId: ids.taskDraft,
      taskId: ids.task,
      workOrderId: null,
      relatedOperationId: null,
      amountCents: 4_200,
      currency: 'USD',
      requestedAt: '2026-08-28T19:59:00.000Z',
    },
    lease: {
      recoveryLeaseId: ids.lease,
      commandId: ids.command,
      recoveryAction: 'RECONCILE',
      leaseOwnerId: ids.owner,
      leaseDurationSeconds: 60,
      acquiredAt: '2026-08-28T20:00:00.000Z',
      expiresAt: '2026-08-28T20:01:00.000Z',
      leaseIdentitySha256: 'd'.repeat(64),
    },
    lastDispatchAttempt: attempt,
    ...overrides,
  };
}

function providerResult(
  overrides: Partial<FinancialOperationResult> = {}
): FinancialOperationResult {
  return {
    operationId: ids.operation,
    operationKind: 'AUTHORIZE',
    providerKind: 'FAKE',
    state: 'SUCCEEDED',
    version: 1,
    amountCents: 4_200,
    currency: 'USD',
    externalReference: 'fake_authorize_opaque',
    idempotencyReplayed: false,
    retryable: false,
    ...overrides,
  };
}

function observedOutcome(
  overrides: Partial<FinancialProviderCommandOutcomeFact> = {}
): FinancialProviderCommandOutcomeFact {
  return {
    outcomeFactId: ids.fact,
    commandId: ids.command,
    dispatchAttemptId: ids.attempt,
    recoveryLeaseId: ids.lease,
    outcomeKind: 'OUTCOME_OBSERVED',
    observationIdempotencyKey: `finance-recovery:${ids.lease}`,
    providerResultSha256: 'e'.repeat(64),
    providerState: 'SUCCEEDED',
    providerResultVersion: 1,
    amountCents: 4_200,
    currency: 'USD',
    externalReferenceSha256: '1'.repeat(64),
    effectCertainty: 'CONFIRMED_EFFECT',
    retryable: false,
    failureCode: null,
    recoveryDelaySeconds: null,
    recoveryNotBefore: null,
    recordedAt: '2026-08-28T20:00:01.000Z',
    outcomeIdentitySha256: 'f'.repeat(64),
    idempotencyReplayed: false,
    ...overrides,
  };
}

function dependencies(currentClaim = claim()) {
  const calls: string[] = [];
  const claimQueue: (readonly FinancialProviderCommandRecoveryClaim[])[] = [[currentClaim], []];
  const repository = {
    claimRecoverable: vi.fn(async () => {
      calls.push('CLAIM_ONE');
      return claimQueue.shift() ?? [];
    }),
    acquireLease: vi.fn(),
    recordDispatchAttempted: vi.fn(),
    recordOutcome: vi.fn(async () => {
      calls.push('OUTCOME_COMMITTED');
      return observedOutcome();
    }),
  } satisfies FinancialProviderCommandRecoveryRepository;
  const executor = {
    providerKind: 'FAKE' as const,
    abortContract: 'ABORT_SIGNAL_SETTLES' as const,
    reconcile: vi.fn(async () => {
      calls.push('RECONCILED');
      return {
        kind: 'OUTCOME_OBSERVED' as const,
        providerResult: providerResult(),
      };
    }),
  } satisfies FakeFinancialCommandRecoveryExecutor;
  const authorize = vi.fn(() => {
    calls.push('AUTHORIZED');
  });
  return { authorize, calls, claimQueue, executor, repository };
}

function worker(
  repository: FinancialProviderCommandRecoveryRepository,
  executor: FakeFinancialCommandRecoveryExecutor,
  authorize = vi.fn(),
  batchLimit = 20
): NonproductionFakeFinancialCommandRecoveryWorker {
  return new NonproductionFakeFinancialCommandRecoveryWorker(
    repository,
    executor,
    { environment: 'staging', leaseOwnerId: ids.owner, batchLimit },
    authorize
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('nonproduction fake financial command recovery worker', () => {
  it('reconciles an attempted command and has no background dispatch path', async () => {
    const { authorize, calls, executor, repository } = dependencies();
    await expect(worker(repository, executor, authorize).runOnce()).resolves.toEqual({
      claimed: 1,
      reconciled: 1,
      outcomeObserved: 1,
      outcomeUnknown: 0,
      failed: 0,
      persistenceErrors: 0,
    });

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith({ component: 'worker' });
    expect(calls).toEqual([
      'AUTHORIZED',
      'CLAIM_ONE',
      'AUTHORIZED',
      'RECONCILED',
      'OUTCOME_COMMITTED',
      'CLAIM_ONE',
    ]);
    expect(repository.recordDispatchAttempted).not.toHaveBeenCalled();
    expect(executor.reconcile).toHaveBeenCalledWith(
      claim(),
      attempt,
      expect.any(AbortSignal)
    );
  });

  it('refuses orphan REQUESTED and retry-dispatch claims without entering the executor', async () => {
    for (const invalid of [
      claim({ lastDispatchAttempt: null }),
      claim({ lease: { ...claim().lease, recoveryAction: 'DISPATCH' } }),
    ]) {
      const { executor, repository } = dependencies(invalid);
      await expect(worker(repository, executor, vi.fn(), 1).runOnce()).resolves.toMatchObject({
        claimed: 1,
        reconciled: 0,
        persistenceErrors: 1,
      });
      expect(executor.reconcile).not.toHaveBeenCalled();
      expect(repository.recordDispatchAttempted).not.toHaveBeenCalled();
    }
  });

  it('authorizes through the shared worker gate even under NODE_ENV=production staging', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { authorize, executor, repository } = dependencies();
    expect(() => worker(repository, executor, authorize)).not.toThrow();
    expect(authorize).toHaveBeenCalledWith({ component: 'worker' });
  });

  it('fails closed before executor entry when per-call reauthorization is refused', async () => {
    const { executor, repository } = dependencies();
    const authorize = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error('authorization refused');
      });

    await expect(worker(repository, executor, authorize, 1).runOnce()).resolves.toMatchObject({
      claimed: 1,
      reconciled: 0,
      persistenceErrors: 1,
    });
    expect(executor.reconcile).not.toHaveBeenCalled();
    expect(repository.recordOutcome).not.toHaveBeenCalled();
  });

  it('rejects an invalid environment or executor provider kind', () => {
    const { executor, repository } = dependencies();
    expect(
      () =>
        new NonproductionFakeFinancialCommandRecoveryWorker(
          repository,
          executor,
          { environment: 'production' as 'staging', leaseOwnerId: ids.owner },
          vi.fn()
        )
    ).toThrow('FAKE_FINANCIAL_RECOVERY_NONPRODUCTION_ONLY');
    expect(
      () =>
        new NonproductionFakeFinancialCommandRecoveryWorker(
          repository,
          { ...executor, providerKind: 'APPROVED_PROVIDER' } as never,
          { environment: 'staging', leaseOwnerId: ids.owner },
          vi.fn()
        )
    ).toThrow('FAKE_FINANCIAL_RECOVERY_NONPRODUCTION_ONLY');
    expect(
      () =>
        new NonproductionFakeFinancialCommandRecoveryWorker(
          repository,
          { ...executor, abortContract: 'UNSAFE' } as never,
          { environment: 'staging', leaseOwnerId: ids.owner },
          vi.fn()
        )
    ).toThrow('FAKE_FINANCIAL_RECOVERY_NONPRODUCTION_ONLY');
    expect(
      () =>
        new NonproductionFakeFinancialCommandRecoveryWorker(
          repository,
          executor,
          {
            environment: 'staging',
            leaseOwnerId: ids.owner,
            leaseDurationSeconds: 2,
            reconciliationDeadlineMs: 2_000,
          },
          vi.fn()
        )
    ).toThrow('FAKE_FINANCIAL_RECOVERY_DEADLINE_INVALID');
  });

  it('hashes only an explicit projection and hashes, rather than persists, external reference', async () => {
    const base = providerResult();
    const replayWithExtras = {
      ...base,
      idempotencyReplayed: true,
      untrustedExtra: 'ignored',
    } as FinancialOperationResult;
    expect(financialProviderOutcomeProjectionSha256(replayWithExtras)).toBe(
      financialProviderOutcomeProjectionSha256(base)
    );
    expect(
      financialProviderOutcomeProjectionSha256({
        ...base,
        externalReference: 'fake_authorize_different',
      })
    ).not.toBe(financialProviderOutcomeProjectionSha256(base));

    const { executor, repository } = dependencies();
    executor.reconcile.mockResolvedValue({ kind: 'OUTCOME_OBSERVED', providerResult: base });
    await worker(repository, executor).runOnce();
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        providerResultSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        amountCents: 4_200,
        currency: 'USD',
        externalReferenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })
    );
    expect(JSON.stringify(repository.recordOutcome.mock.calls)).not.toContain(
      base.externalReference
    );
  });

  it.each(['PENDING', 'RETRYABLE_FAILURE'] as const)(
    'stores an observed %s result as durable nonterminal evidence',
    async (state) => {
      const { executor, repository } = dependencies();
      executor.reconcile.mockResolvedValue({
        kind: 'OUTCOME_OBSERVED',
        providerResult: providerResult({ state, retryable: true }),
      });
      repository.recordOutcome.mockResolvedValue(
        observedOutcome({
          providerState: state,
          effectCertainty: 'UNKNOWN',
          retryable: true,
          recoveryDelaySeconds: 45,
          recoveryNotBefore: '2026-08-28T20:00:46.000Z',
        })
      );

      await expect(
        new NonproductionFakeFinancialCommandRecoveryWorker(
          repository,
          executor,
          {
            environment: 'staging',
            leaseOwnerId: ids.owner,
            nonterminalObservationRecoveryDelaySeconds: 45,
          },
          vi.fn()
        ).runOnce()
      ).resolves.toMatchObject({ outcomeObserved: 1, outcomeUnknown: 0 });
      expect(repository.recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'OUTCOME_OBSERVED',
          providerState: state,
          effectCertainty: 'UNKNOWN',
          retryable: true,
          recoveryDelaySeconds: 45,
        })
      );
    }
  );

  it.each([
    ['operation state', { state: 'REFUNDED' as const }],
    ['amount', { amountCents: 4_201 }],
    ['currency', { currency: 'EUR' }],
  ])('fails closed on an invalid exact %s projection', async (_label, invalidResult) => {
    const { executor, repository } = dependencies();
    executor.reconcile.mockResolvedValue({
      kind: 'OUTCOME_OBSERVED',
      providerResult: providerResult(invalidResult),
    });
    repository.recordOutcome.mockResolvedValue(
      observedOutcome({
        outcomeKind: 'OUTCOME_UNKNOWN',
        providerResultSha256: null,
        providerState: null,
        providerResultVersion: null,
        amountCents: null,
        currency: null,
        externalReferenceSha256: null,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        failureCode: 'FAKE_EXECUTOR_RESULT_INVALID',
        recoveryDelaySeconds: 30,
        recoveryNotBefore: '2026-08-28T20:00:31.000Z',
      })
    );

    await expect(worker(repository, executor).runOnce()).resolves.toMatchObject({
      outcomeObserved: 0,
      outcomeUnknown: 1,
    });
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'OUTCOME_UNKNOWN',
        failureCode: 'FAKE_EXECUTOR_RESULT_INVALID',
      })
    );
  });

  it('runtime-checks confirmedNoEffect before recording a FAILED fact', async () => {
    const { executor, repository } = dependencies();
    executor.reconcile.mockResolvedValue({
      kind: 'FAILED',
      failureCode: 'FAKE_DEFINITE_FAILURE',
      retryable: false,
      confirmedNoEffect: false,
    } as never);
    repository.recordOutcome.mockResolvedValue(
      observedOutcome({
        outcomeKind: 'OUTCOME_UNKNOWN',
        providerResultSha256: null,
        providerState: null,
        providerResultVersion: null,
        amountCents: null,
        currency: null,
        externalReferenceSha256: null,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        failureCode: 'FAKE_EXECUTOR_RESULT_INVALID',
        recoveryDelaySeconds: 30,
        recoveryNotBefore: '2026-08-28T20:00:31.000Z',
      })
    );

    await worker(repository, executor).runOnce();
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'OUTCOME_UNKNOWN',
        failureCode: 'FAKE_EXECUTOR_RESULT_INVALID',
      })
    );
  });

  it('claims one row, persists its outcome, and only then leases the next row', async () => {
    const secondClaim = claim({
      command: { ...claim().command, commandId: '20000000-0000-4000-8000-000000000001' },
      lease: {
        ...claim().lease,
        commandId: '20000000-0000-4000-8000-000000000001',
        recoveryLeaseId: '20000000-0000-4000-8000-000000000006',
      },
      lastDispatchAttempt: {
        ...attempt,
        commandId: '20000000-0000-4000-8000-000000000001',
        dispatchAttemptId: '20000000-0000-4000-8000-000000000007',
      },
    });
    const { authorize, calls, claimQueue, executor, repository } = dependencies();
    claimQueue.splice(0, claimQueue.length, [claim()], [secondClaim], []);

    await expect(worker(repository, executor, authorize).runOnce()).resolves.toMatchObject({
      claimed: 2,
      reconciled: 2,
    });
    expect(repository.claimRecoverable).toHaveBeenCalledTimes(3);
    expect(repository.claimRecoverable).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ limit: expect.anything() })
    );
    expect(calls).toEqual([
      'AUTHORIZED',
      'CLAIM_ONE',
      'AUTHORIZED',
      'RECONCILED',
      'OUTCOME_COMMITTED',
      'CLAIM_ONE',
      'AUTHORIZED',
      'RECONCILED',
      'OUTCOME_COMMITTED',
      'CLAIM_ONE',
    ]);
  });

  it('records a thrown reconciliation as unknown without persisting provider detail', async () => {
    const { executor, repository } = dependencies();
    executor.reconcile.mockRejectedValue(new Error('secret provider detail'));
    repository.recordOutcome.mockResolvedValue(
      observedOutcome({
        outcomeKind: 'OUTCOME_UNKNOWN',
        providerResultSha256: null,
        providerState: null,
        providerResultVersion: null,
        amountCents: null,
        currency: null,
        externalReferenceSha256: null,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        failureCode: 'FAKE_EXECUTOR_THROWN',
        recoveryDelaySeconds: 30,
        recoveryNotBefore: '2026-08-28T20:00:31.000Z',
      })
    );

    await expect(worker(repository, executor).runOnce()).resolves.toMatchObject({
      outcomeUnknown: 1,
      failed: 0,
    });
    expect(JSON.stringify(repository.recordOutcome.mock.calls)).not.toContain(
      'secret provider detail'
    );
  });

  it('aborts through the executor contract before the lease deadline without racing', async () => {
    vi.useFakeTimers();
    const { executor, repository } = dependencies();
    executor.reconcile.mockImplementation(
      async (_claim, _attempt, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    repository.recordOutcome.mockResolvedValue(
      observedOutcome({
        outcomeKind: 'OUTCOME_UNKNOWN',
        providerResultSha256: null,
        providerState: null,
        providerResultVersion: null,
        amountCents: null,
        currency: null,
        externalReferenceSha256: null,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        failureCode: 'FAKE_EXECUTOR_THROWN',
        recoveryDelaySeconds: 30,
        recoveryNotBefore: '2026-08-28T20:00:31.000Z',
      })
    );
    const run = new NonproductionFakeFinancialCommandRecoveryWorker(
      repository,
      executor,
      {
        environment: 'staging',
        leaseOwnerId: ids.owner,
        leaseDurationSeconds: 2,
        reconciliationDeadlineMs: 10,
      },
      vi.fn()
    ).runOnce();
    await vi.advanceTimersByTimeAsync(10);
    await expect(run).resolves.toMatchObject({ outcomeUnknown: 1 });
  });

  it('excludes and refuses a command already handled by the same run', async () => {
    const { claimQueue, executor, repository } = dependencies();
    claimQueue.splice(0, claimQueue.length, [claim()], [claim()]);

    await expect(worker(repository, executor).runOnce()).resolves.toMatchObject({
      claimed: 1,
      reconciled: 1,
      persistenceErrors: 1,
    });
    expect(executor.reconcile).toHaveBeenCalledTimes(1);
    expect(repository.claimRecoverable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ excludeCommandIds: [ids.command] })
    );
  });

  it('keeps foreground dispatch and lifecycle materialization explicit blockers', () => {
    expect(FINANCIAL_PROVIDER_COMMAND_RECOVERY_INTEGRATION_BLOCKERS).toEqual({
      foregroundPreparedCommandDispatch: 'NOT_WIRED',
      lifecycleOutcomeMaterialization: 'NOT_WIRED',
      abortableProviderReconciliation: 'EXECUTOR_CONTRACT_REQUIRED',
    });
  });
});
