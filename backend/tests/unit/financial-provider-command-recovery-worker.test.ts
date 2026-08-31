import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ExactFakeFinancialCommandRecoveryExecutor,
  FINANCIAL_PROVIDER_COMMAND_RECOVERY_INTEGRATION_BLOCKERS,
  NonproductionFakeFinancialCommandRecoveryWorker,
  financialProviderOutcomeProjectionSha256,
  startNonproductionFakeFinancialCommandRecoveryPoller,
  type FakeFinancialCommandRecoveryExecutor,
  type FinancialProviderCommandRecoveryRunResult,
} from '../../src/jobs/financial-provider-command-recovery-worker.js';
import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import { canonicalFinancialProviderRequestSha256 } from '../../src/services/payment/FinancialProviderCommandJournal.js';
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
  reconciliationLease: '10000000-0000-4000-8000-000000000009',
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactAuthorizeClaim(
  requestSha256: string,
  eventRecordedAt: string
): FinancialProviderCommandRecoveryClaim {
  const eventTime = Date.parse(eventRecordedAt);
  const requestedAt = new Date(eventTime - 3_000).toISOString();
  const attemptedAt = new Date(eventTime - 2_000).toISOString();
  const outcomeDeadlineAt = new Date(eventTime - 1_000).toISOString();
  const acquiredAt = new Date(eventTime + 1_000).toISOString();
  const expiresAt = new Date(eventTime + 61_000).toISOString();
  const commandIdentitySha256 = digest(
    JSON.stringify({
      schemaVersion: 1,
      operationKind: 'AUTHORIZE',
      operationId: ids.operation,
      providerKind: 'FAKE',
      idempotencyKey: 'finance-recovery-command:unit',
      providerExpectedVersion: 0,
      requestSha256,
      evidence: {
        preparedFinancialCommandId: null,
        preparedAuthoritySha256: null,
        taskDraftId: ids.taskDraft,
        taskId: ids.task,
        workOrderId: null,
        relatedOperationId: null,
        amountCents: 4_200,
        currency: 'USD',
      },
      actor: null,
      release: null,
    })
  );
  const exactAttempt: FinancialProviderCommandDispatchAttempt = {
    dispatchAttemptId: ids.attempt,
    commandId: ids.command,
    recoveryLeaseId: ids.lease,
    attemptNumber: 1,
    requestSha256,
    outcomeTimeoutSeconds: 1,
    attemptedAt,
    outcomeDeadlineAt,
    attemptIdentitySha256: digest(
      [ids.command, ids.attempt, ids.lease, '1', requestSha256, '1'].join(':')
    ),
    idempotencyReplayed: false,
  };
  return {
    command: {
      commandId: ids.command,
      operationKind: 'AUTHORIZE',
      operationId: ids.operation,
      providerKind: 'FAKE',
      idempotencyKey: 'finance-recovery-command:unit',
      providerExpectedVersion: 0,
      requestSha256,
      commandIdentitySha256,
      preparedFinancialCommandId: null,
      preparedAuthoritySha256: null,
      taskDraftId: ids.taskDraft,
      taskId: ids.task,
      workOrderId: null,
      relatedOperationId: null,
      amountCents: 4_200,
      currency: 'USD',
      recordedActorId: null,
      recordedActorKind: null,
      releaseManifestDigest: null,
      releaseId: null,
      releaseRevision: null,
      releaseEnvironment: null,
      releaseAuthenticationStatus: null,
      requestedAt,
    },
    lease: {
      recoveryLeaseId: ids.reconciliationLease,
      commandId: ids.command,
      recoveryAction: 'RECONCILE',
      leaseOwnerId: ids.owner,
      leaseDurationSeconds: 60,
      acquiredAt,
      expiresAt,
      leaseIdentitySha256: digest(
        [ids.command, ids.reconciliationLease, 'RECONCILE', ids.owner, '60'].join(':')
      ),
    },
    lastDispatchAttempt: exactAttempt,
  };
}

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
      recordedActorId: null,
      recordedActorKind: null,
      releaseManifestDigest: null,
      releaseId: null,
      releaseRevision: null,
      releaseEnvironment: null,
      releaseAuthenticationStatus: null,
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

describe('exact fake financial command recovery executor', () => {
  it('observes only the exact immutable event bound to the journal and dispatch attempt', async () => {
    const fakeEvents = new InMemoryFakeFinancialOperationRepository();
    const provider = new FakeFinancialProvider(fakeEvents);
    const exactRequest = {
      operationId: ids.operation,
      idempotencyKey: 'finance-recovery-command:unit',
      expectedVersion: 0,
      amountCents: 4_200,
      currency: 'usd',
      paymentMethodReference: 'fake-payment-method:unit',
    } as const;
    const expected = await provider.authorize(exactRequest);
    const event = fakeEvents.events()[0]!;
    const exactClaim = exactAuthorizeClaim(
      canonicalFinancialProviderRequestSha256(exactRequest),
      event.recordedAt
    );
    const lookup = vi.fn((idempotencyKey) => fakeEvents.findByIdempotencyKey(idempotencyKey));
    const unreachableDispatch = vi.fn();
    const authorize = vi.fn();
    const executor = new ExactFakeFinancialCommandRecoveryExecutor(
      { findByIdempotencyKey: lookup, execute: unreachableDispatch } as never,
      17,
      authorize
    );

    await expect(
      executor.reconcile(exactClaim, exactClaim.lastDispatchAttempt!, new AbortController().signal)
    ).resolves.toEqual({
      kind: 'OUTCOME_OBSERVED',
      providerResult: { ...expected, idempotencyReplayed: true },
    });
    expect(lookup).toHaveBeenCalledWith(exactRequest.idempotencyKey);
    expect(unreachableDispatch).not.toHaveBeenCalled();
    expect(fakeEvents.events()).toHaveLength(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith({ component: 'worker' });
  });

  it('never dispatches when the exact event is missing or identity evidence is invalid', async () => {
    const eventRecordedAt = new Date().toISOString();
    const requestSha256 = canonicalFinancialProviderRequestSha256({
      operationId: ids.operation,
      idempotencyKey: 'finance-recovery-command:unit',
      expectedVersion: 0,
      amountCents: 4_200,
      currency: 'usd',
      paymentMethodReference: 'fake-payment-method:unit',
    });
    const exactClaim = exactAuthorizeClaim(requestSha256, eventRecordedAt);
    const findByIdempotencyKey = vi.fn(async () => null);
    const unreachableDispatch = vi.fn();
    const executor = new ExactFakeFinancialCommandRecoveryExecutor(
      { findByIdempotencyKey, execute: unreachableDispatch } as never,
      19,
      vi.fn()
    );

    await expect(
      executor.reconcile(exactClaim, exactClaim.lastDispatchAttempt!, new AbortController().signal)
    ).resolves.toEqual({
      kind: 'OUTCOME_UNKNOWN',
      failureCode: 'FAKE_EVENT_NOT_FOUND',
      recoveryDelaySeconds: 19,
    });
    const invalidClaim = {
      ...exactClaim,
      command: { ...exactClaim.command, commandIdentitySha256: 'd'.repeat(64) },
    };
    await expect(
      executor.reconcile(
        invalidClaim,
        invalidClaim.lastDispatchAttempt!,
        new AbortController().signal
      )
    ).resolves.toEqual({
      kind: 'OUTCOME_UNKNOWN',
      failureCode: 'FAKE_IDENTITY_MISMATCH',
      recoveryDelaySeconds: 19,
    });
    expect(findByIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(unreachableDispatch).not.toHaveBeenCalled();
  });

  it('settles on abort while a read-only event lookup is unresolved', async () => {
    const requestSha256 = canonicalFinancialProviderRequestSha256({
      operationId: ids.operation,
      idempotencyKey: 'finance-recovery-command:unit',
      expectedVersion: 0,
      amountCents: 4_200,
      currency: 'usd',
      paymentMethodReference: 'fake-payment-method:unit',
    });
    const exactClaim = exactAuthorizeClaim(requestSha256, new Date().toISOString());
    const executor = new ExactFakeFinancialCommandRecoveryExecutor(
      { findByIdempotencyKey: () => new Promise(() => undefined) },
      30,
      vi.fn()
    );
    const abort = new AbortController();
    const reconciliation = executor.reconcile(
      exactClaim,
      exactClaim.lastDispatchAttempt!,
      abort.signal
    );
    const reason = new Error('unit abort');
    abort.abort(reason);

    await expect(reconciliation).rejects.toBe(reason);
  });
});

describe('fake financial command recovery poller', () => {
  it('clears its timer and drains an in-flight batch before stop settles', async () => {
    vi.useFakeTimers();
    let finishBatch!: (result: {
      claimed: number;
      reconciled: number;
      outcomeObserved: number;
      outcomeUnknown: number;
      failed: number;
      persistenceErrors: number;
    }) => void;
    const runOnce = vi.fn(
      () =>
        new Promise<FinancialProviderCommandRecoveryRunResult>((resolve) => {
          finishBatch = resolve;
        })
    );
    const assertAuthorized = vi.fn();
    const handle = startNonproductionFakeFinancialCommandRecoveryPoller(
      500,
      { worker: { runOnce }, assertAuthorized },
      { workerId: 'fake-financial-recovery:unit' }
    );
    await Promise.resolve();
    expect(handle.health()).toMatchObject({ status: 'healthy', inFlight: true });

    let stopped = false;
    const stop = handle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishBatch({
      claimed: 1,
      reconciled: 1,
      outcomeObserved: 1,
      outcomeUnknown: 0,
      failed: 0,
      persistenceErrors: 0,
    });
    await stop;

    expect(handle.health()).toEqual({
      status: 'stopped',
      inFlight: false,
      consecutiveFailures: 0,
      lastFailureCode: null,
    });
    expect(assertAuthorized).toHaveBeenCalledTimes(2);
  });

  it('reports persistence failures as degraded and gates capability before timer creation', async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn(async () => ({
      claimed: 1,
      reconciled: 0,
      outcomeObserved: 0,
      outcomeUnknown: 0,
      failed: 0,
      persistenceErrors: 1,
    }));
    const handle = startNonproductionFakeFinancialCommandRecoveryPoller(500, {
      worker: { runOnce },
      assertAuthorized: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.health()).toEqual({
      status: 'degraded',
      inFlight: false,
      consecutiveFailures: 1,
      lastFailureCode: 'PERSISTENCE_ERRORS',
    });
    await handle.stop();

    expect(() =>
      startNonproductionFakeFinancialCommandRecoveryPoller(500, {
        worker: { runOnce },
        assertAuthorized: () => {
          throw new Error('denied');
        },
      })
    ).toThrow('denied');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
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
    expect(executor.reconcile).toHaveBeenCalledWith(claim(), attempt, expect.any(AbortSignal));
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

  it('reports the wired fake-only seams and the remaining lifecycle blocker', () => {
    expect(FINANCIAL_PROVIDER_COMMAND_RECOVERY_INTEGRATION_BLOCKERS).toEqual({
      foregroundPreparedCommandDispatch: 'WIRED_FAKE_NONPRODUCTION',
      lifecycleOutcomeMaterialization: 'BLOCKED_ACTOR_AUTHORITY_REQUIRED',
      abortableProviderReconciliation: 'WIRED_FAKE_EVENT_READ_ONLY',
    });
  });
});
