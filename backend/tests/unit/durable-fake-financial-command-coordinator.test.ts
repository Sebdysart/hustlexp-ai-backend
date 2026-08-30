import { describe, expect, it, vi } from 'vitest';

import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  InMemoryFinancialProviderCommandJournal,
  JournaledFinancialProviderInvoker,
  type FinancialProviderCommandJournal,
  type FinancialProviderCommandReceipt,
  type RecordFinancialProviderCommandInput,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  DurableFakeFinancialProviderCommandCoordinator,
  type FinancialProviderCommandDispatchAttempt,
  type FinancialProviderCommandOutcomeFact,
  type FinancialProviderCommandRecoveryCommand,
  type FinancialProviderCommandRecoveryLease,
  type FinancialProviderCommandState,
  type ForegroundFinancialProviderCommandRepository,
  type RecordFinancialProviderCommandOutcomeInput,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';

const ids = {
  operation: '11111111-1111-4111-8111-111111111111',
  prepared: '22222222-2222-4222-8222-222222222222',
  owner: '33333333-3333-4333-8333-333333333333',
  dispatchLease: '44444444-4444-4444-8444-444444444444',
  reconcileLease: '55555555-5555-4555-8555-555555555555',
  attempt: '66666666-6666-4666-8666-666666666666',
  outcome: '77777777-7777-4777-8777-777777777777',
  draft: '88888888-8888-4888-8888-888888888888',
  task: '99999999-9999-4999-8999-999999999999',
  workOrder: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  related: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  capture: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  onboard: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
} as const;

function input(): RecordFinancialProviderCommandInput<Record<string, unknown>> {
  return {
    operationKind: 'PREPARE_PAYMENT_METHOD',
    operationId: ids.operation,
    providerKind: 'FAKE',
    idempotencyKey: 'foreground-fake:prepare:0001',
    providerExpectedVersion: 0,
    exactRequest: {
      operationId: ids.operation,
      idempotencyKey: 'foreground-fake:prepare:0001',
      expectedVersion: 0,
      customerId: 'synthetic-customer',
    },
    evidence: {
      preparedFinancialCommandId: ids.prepared,
      preparedAuthoritySha256: 'a'.repeat(64),
      taskDraftId: ids.draft,
      taskId: ids.task,
    },
  };
}

function captureInput(
  workOrderId: string | null = ids.workOrder
): RecordFinancialProviderCommandInput<Record<string, unknown>> {
  return {
    operationKind: 'CAPTURE',
    operationId: ids.capture,
    providerKind: 'FAKE',
    idempotencyKey: 'foreground-fake:capture:0001',
    providerExpectedVersion: 0,
    exactRequest: {
      operationId: ids.capture,
      idempotencyKey: 'foreground-fake:capture:0001',
      expectedVersion: 0,
      amountCents: 4_200,
      currency: 'usd',
      relatedOperationId: ids.related,
    },
    evidence: {
      preparedFinancialCommandId: ids.prepared,
      preparedAuthoritySha256: 'a'.repeat(64),
      taskDraftId: ids.draft,
      taskId: ids.task,
      ...(workOrderId === null ? {} : { workOrderId }),
      relatedOperationId: ids.related,
      amountCents: 4_200,
      currency: 'usd',
    },
  };
}

function onboardInput(): RecordFinancialProviderCommandInput<Record<string, unknown>> {
  return {
    operationKind: 'ONBOARD_PROVIDER',
    operationId: ids.onboard,
    providerKind: 'FAKE',
    idempotencyKey: 'foreground-fake:onboard:0001',
    providerExpectedVersion: 0,
    exactRequest: {
      operationId: ids.onboard,
      idempotencyKey: 'foreground-fake:onboard:0001',
      expectedVersion: 0,
      providerId: ids.task,
    },
  };
}

class ObservingJournal implements FinancialProviderCommandJournal {
  readonly order: string[] = [];
  readonly inner = new InMemoryFinancialProviderCommandJournal(
    () => new Date('2030-01-01T00:00:00.000Z')
  );
  receipt: FinancialProviderCommandReceipt | null = null;
  input: RecordFinancialProviderCommandInput<unknown> | null = null;

  async recordRequested<TRequest>(
    command: RecordFinancialProviderCommandInput<TRequest>
  ): Promise<FinancialProviderCommandReceipt> {
    this.order.push('REQUESTED_COMMITTED');
    this.input = command;
    this.receipt = await this.inner.recordRequested(command);
    return this.receipt;
  }
}

class CoordinatorRepository implements ForegroundFinancialProviderCommandRepository {
  readonly order: string[];
  attempt: FinancialProviderCommandDispatchAttempt | null = null;
  outcome: FinancialProviderCommandOutcomeFact | null = null;
  failObservedOnce = false;
  workOrderId: string | null | undefined;
  private leaseSequence = 0;

  constructor(readonly journal: ObservingJournal) {
    this.order = journal.order;
  }

  private command(): FinancialProviderCommandRecoveryCommand {
    const receipt = this.journal.receipt!;
    const evidence = this.journal.input?.evidence;
    return {
      commandId: receipt.commandId,
      operationKind: receipt.operationKind,
      operationId: receipt.operationId,
      providerKind: 'FAKE',
      idempotencyKey: receipt.idempotencyKey,
      providerExpectedVersion: receipt.providerExpectedVersion,
      requestSha256: receipt.requestSha256,
      commandIdentitySha256: receipt.commandIdentitySha256,
      preparedFinancialCommandId: receipt.preparedFinancialCommandId,
      preparedAuthoritySha256: receipt.preparedAuthoritySha256,
      taskDraftId: evidence?.taskDraftId ?? null,
      taskId: evidence?.taskId ?? null,
      workOrderId:
        this.workOrderId === undefined
          ? (evidence?.workOrderId ?? null)
          : this.workOrderId,
      relatedOperationId: evidence?.relatedOperationId ?? null,
      amountCents: evidence?.amountCents ?? null,
      currency: evidence?.currency?.toUpperCase() ?? null,
      requestedAt: receipt.recordedAt,
    };
  }

  async findCommandState(): Promise<FinancialProviderCommandState> {
    this.order.push('REQUESTED_READ_EXACT');
    return {
      command: this.command(),
      lastDispatchAttempt: this.attempt,
      latestOutcome: this.outcome,
    };
  }

  async acquireLease(input: {
    commandId: string;
    recoveryAction: 'DISPATCH' | 'RECONCILE';
    leaseOwnerId: string;
    leaseDurationSeconds?: number;
  }): Promise<FinancialProviderCommandRecoveryLease> {
    this.order.push(`${input.recoveryAction}_LEASE_COMMITTED`);
    this.leaseSequence += 1;
    const recoveryLeaseId = this.leaseSequence === 1 ? ids.dispatchLease : ids.reconcileLease;
    return {
      recoveryLeaseId,
      commandId: input.commandId,
      recoveryAction: input.recoveryAction,
      leaseOwnerId: input.leaseOwnerId,
      leaseDurationSeconds: input.leaseDurationSeconds ?? 90,
      acquiredAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:01:30.000Z',
      leaseIdentitySha256: 'b'.repeat(64),
    };
  }

  async recordDispatchAttempted(input: {
    commandId: string;
    recoveryLeaseId: string;
    outcomeTimeoutSeconds?: number;
  }): Promise<FinancialProviderCommandDispatchAttempt> {
    this.order.push('DISPATCH_ATTEMPTED_COMMITTED');
    this.attempt = {
      dispatchAttemptId: ids.attempt,
      commandId: input.commandId,
      recoveryLeaseId: input.recoveryLeaseId,
      attemptNumber: 1,
      requestSha256: this.command().requestSha256,
      outcomeTimeoutSeconds: input.outcomeTimeoutSeconds ?? 45,
      attemptedAt: '2030-01-01T00:00:00.000Z',
      outcomeDeadlineAt: '2030-01-01T00:00:45.000Z',
      attemptIdentitySha256: 'c'.repeat(64),
      idempotencyReplayed: false,
    };
    return this.attempt;
  }

  async recordOutcome(
    input: RecordFinancialProviderCommandOutcomeInput
  ): Promise<FinancialProviderCommandOutcomeFact> {
    this.order.push(`${input.kind}_COMMITTED`);
    if (this.failObservedOnce && input.kind === 'OUTCOME_OBSERVED') {
      this.failObservedOnce = false;
      throw new Error('SIMULATED_OUTCOME_COMMIT_FAILURE');
    }
    const observed = input.kind === 'OUTCOME_OBSERVED';
    const unknown = input.kind === 'OUTCOME_UNKNOWN';
    this.outcome = {
      outcomeFactId: ids.outcome,
      commandId: input.commandId,
      dispatchAttemptId: input.dispatchAttemptId,
      recoveryLeaseId: input.recoveryLeaseId,
      outcomeKind: input.kind,
      observationIdempotencyKey: input.observationIdempotencyKey,
      providerResultSha256: observed ? input.providerResultSha256 : null,
      providerState: observed ? input.providerState : null,
      providerResultVersion: observed ? input.providerResultVersion : null,
      amountCents: observed ? input.amountCents : null,
      currency: observed ? input.currency : null,
      externalReferenceSha256: observed ? input.externalReferenceSha256 : null,
      effectCertainty: observed ? input.effectCertainty : unknown ? 'UNKNOWN' : 'CONFIRMED_NO_EFFECT',
      retryable: observed ? input.retryable : unknown ? true : input.retryable,
      failureCode: observed ? null : input.failureCode,
      recoveryDelaySeconds:
        observed || unknown || input.retryable ? input.recoveryDelaySeconds : null,
      recoveryNotBefore: null,
      recordedAt: '2030-01-01T00:00:01.000Z',
      outcomeIdentitySha256: 'd'.repeat(64),
      idempotencyReplayed: false,
    };
    return this.outcome;
  }
}

function fixture() {
  const journal = new ObservingJournal();
  const repository = new CoordinatorRepository(journal);
  const fakeEvents = new InMemoryFakeFinancialOperationRepository();
  const provider = new FakeFinancialProvider(fakeEvents);
  const coordinator = new DurableFakeFinancialProviderCommandCoordinator(
    repository,
    fakeEvents,
    { leaseOwnerId: ids.owner }
  );
  const invoker = new JournaledFinancialProviderInvoker(journal, coordinator);
  return { journal, repository, fakeEvents, provider, invoker };
}

describe('durable fake financial foreground coordinator', () => {
  it('commits REQUESTED, DISPATCH lease, and DISPATCH_ATTEMPTED before adapter entry and outcome before return', async () => {
    const { journal, provider, invoker } = fixture();
    const result = await invoker.invokeAfterCommit(input(), async (request) => {
      journal.order.push('FAKE_ADAPTER_ENTERED');
      return provider.preparePaymentMethod(request as never);
    });

    expect(journal.order).toEqual([
      'REQUESTED_COMMITTED',
      'REQUESTED_READ_EXACT',
      'DISPATCH_LEASE_COMMITTED',
      'DISPATCH_ATTEMPTED_COMMITTED',
      'FAKE_ADAPTER_ENTERED',
      'OUTCOME_OBSERVED_COMMITTED',
    ]);
    expect(result.result).toMatchObject({ state: 'SUCCEEDED', idempotencyReplayed: false });
    expect(result.evidence).toEqual({
      preparedCommandId: ids.prepared,
      commandId: result.command.commandId,
      dispatchAttemptId: ids.attempt,
      outcomeFactId: ids.outcome,
      fakeOperationEventId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
  });

  it('replays from the exact raw event and durable outcome without a second adapter entry', async () => {
    const { provider, invoker } = fixture();
    const adapter = vi.fn((request: Record<string, unknown>) =>
      provider.preparePaymentMethod(request as never)
    );
    await invoker.invokeAfterCommit(input(), adapter);
    const replay = await invoker.invokeAfterCommit(input(), adapter);

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(replay.result).toMatchObject({ state: 'SUCCEEDED', idempotencyReplayed: true });
    expect(replay.evidence?.outcomeFactId).toBe(ids.outcome);
  });

  it('reconciles an attempt whose adapter event committed before outcome persistence failed', async () => {
    const { repository, provider, invoker } = fixture();
    repository.failObservedOnce = true;
    const adapter = vi.fn((request: Record<string, unknown>) =>
      provider.preparePaymentMethod(request as never)
    );
    await expect(invoker.invokeAfterCommit(input(), adapter)).rejects.toThrow(
      'SIMULATED_OUTCOME_COMMIT_FAILURE'
    );
    const replay = await invoker.invokeAfterCommit(input(), adapter);

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(replay.result).toMatchObject({ state: 'SUCCEEDED', idempotencyReplayed: true });
    expect(repository.order).toContain('RECONCILE_LEASE_COMMITTED');
  });

  it('records UNKNOWN and never blindly redispatches when an attempted command has no raw event', async () => {
    const { repository, invoker } = fixture();
    await repository.journal.recordRequested(input());
    await repository.recordDispatchAttempted({
      commandId: repository.journal.receipt!.commandId,
      recoveryLeaseId: ids.dispatchLease,
    });
    const adapter = vi.fn();

    await expect(invoker.invokeAfterCommit(input(), adapter)).rejects.toThrow(
      'FAKE_FINANCIAL_FOREGROUND_OUTCOME_UNKNOWN'
    );
    expect(adapter).not.toHaveBeenCalled();
    expect(repository.outcome).toMatchObject({
      outcomeKind: 'OUTCOME_UNKNOWN',
      failureCode: 'FAKE_EVENT_NOT_FOUND',
      effectCertainty: 'UNKNOWN',
    });
  });

  it('refuses a Work Order binding before the security sequence has completed', async () => {
    const { repository, provider, invoker } = fixture();
    repository.workOrderId = ids.workOrder;
    const adapter = vi.fn((request: Record<string, unknown>) =>
      provider.preparePaymentMethod(request as never)
    );

    await expect(invoker.invokeAfterCommit(input(), adapter)).rejects.toThrow(
      'FAKE_FINANCIAL_FOREGROUND_PRE_WORK_ORDER_BINDING_REQUIRED'
    );
    expect(adapter).not.toHaveBeenCalled();
    expect(repository.order).toEqual(['REQUESTED_COMMITTED', 'REQUESTED_READ_EXACT']);
  });

  it('durably dispatches an exact WorkOrder-bound post-security lifecycle command', async () => {
    const { provider, invoker } = fixture();
    const result = await invoker.invokeAfterCommit(captureInput(), (request) =>
      provider.capture(request as never)
    );

    expect(result.result).toMatchObject({
      operationKind: 'CAPTURE',
      state: 'SUCCEEDED',
      amountCents: 4_200,
      currency: 'USD',
    });
    expect(result.evidence).toMatchObject({
      preparedCommandId: ids.prepared,
      commandId: result.command.commandId,
      dispatchAttemptId: ids.attempt,
      outcomeFactId: ids.outcome,
    });
  });

  it('refuses a post-security lifecycle command without an exact WorkOrder binding', async () => {
    const { provider, invoker } = fixture();
    const adapter = vi.fn((request: Record<string, unknown>) =>
      provider.capture(request as never)
    );

    await expect(invoker.invokeAfterCommit(captureInput(null), adapter)).rejects.toThrow(
      'FAKE_FINANCIAL_FOREGROUND_WORK_ORDER_BINDING_REQUIRED'
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it('durably coordinates provider onboarding without claiming lifecycle authority', async () => {
    const { provider, invoker } = fixture();
    const result = await invoker.invokeAfterCommit(onboardInput(), (request) =>
      provider.onboardProvider(request as never)
    );

    expect(result.result).toMatchObject({
      operationKind: 'ONBOARD_PROVIDER',
      state: 'SUCCEEDED',
    });
    expect(result.evidence).toMatchObject({
      commandId: result.command.commandId,
      dispatchAttemptId: ids.attempt,
      outcomeFactId: ids.outcome,
    });
    expect(result.evidence).not.toHaveProperty('preparedCommandId');
  });
});
