import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  canonicalFinancialProviderRequestSha256,
  InMemoryFinancialProviderCommandJournal,
  type FinancialProviderCommandJournal,
  type FinancialProviderCommandReceipt,
  type ForegroundFinancialProviderCommandContext,
  type ForegroundFinancialProviderCommandCoordinator,
  type ForegroundFinancialProviderCommandResult,
  type RecordFinancialProviderCommandInput,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  InMemoryUniversalV1PreparedFinancialCommandAuthority,
  type PrepareUniversalV1FinancialCommandInput,
  type PreparedUniversalV1FinancialCommandReceipt,
  type UniversalV1PreparedFinancialCommandAuthority,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import {
  authorizeUniversalV1FakeFinancialTransaction,
  canonicalUniversalV1ReconciliationSnapshotSha256,
  InMemoryUniversalV1FinancialLifecycleRepository,
  PostgresUniversalV1FinancialLifecycleRepository,
  UniversalV1FinancialApplicationService,
  UniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
  type UniversalV1ReconciliationSnapshot,
} from '../../src/services/payment/UniversalV1FinancialApplicationService.js';

const ids = {
  draft: '00000000-0000-4000-8000-000000000101',
  task: '00000000-0000-4000-8000-000000000102',
  eligibility: '00000000-0000-4000-8000-000000000103',
  scope: '00000000-0000-4000-8000-000000000104',
  actor: '00000000-0000-4000-8000-000000000105',
  predecessor: '00000000-0000-4000-8000-000000000106',
  prepare: '00000000-0000-4000-8000-000000000111',
  authorize: '00000000-0000-4000-8000-000000000112',
  reconciliation: '00000000-0000-4000-8000-000000000113',
  workOrder: '00000000-0000-4000-8000-000000000114',
  captureEvent: '00000000-0000-4000-8000-000000000115',
  terminalIntent: '00000000-0000-4000-8000-000000000116',
  command: '00000000-0000-4000-8000-000000000121',
  attempt: '00000000-0000-4000-8000-000000000122',
  outcome: '00000000-0000-4000-8000-000000000123',
  fakeEvent: '00000000-0000-4000-8000-000000000124',
};

function preparation(
  overrides: Partial<Extract<ExecuteUniversalV1FinancialEventCommand, { operationKind: 'PREPARE_PAYMENT_METHOD' }>> = {}
): Extract<ExecuteUniversalV1FinancialEventCommand, { operationKind: 'PREPARE_PAYMENT_METHOD' }> {
  return {
    operationKind: 'PREPARE_PAYMENT_METHOD', providerKind: 'FAKE', operationId: ids.prepare,
    idempotencyKey: 'app:prepare:coordinator-hold:0001', providerExpectedVersion: 0,
    lifecycleExpectedVersion: 0, taskDraftId: ids.draft, taskId: ids.task,
    eligibilityDecisionId: ids.eligibility, scopeVersionId: ids.scope,
    recordedBy: ids.actor, occurredAt: '1999-01-01T00:00:00.000Z',
    customerId: 'synthetic-customer-1', ...overrides,
  };
}

function authorization(
  paymentMethodReference = 'fake-payment-method-reference'
): Extract<ExecuteUniversalV1FinancialEventCommand, { operationKind: 'AUTHORIZE' }> {
  return {
    operationKind: 'AUTHORIZE', providerKind: 'FAKE', operationId: ids.authorize,
    idempotencyKey: 'app:authorize:coordinator-hold:0001', providerExpectedVersion: 0,
    lifecycleExpectedVersion: 1, taskDraftId: ids.draft, taskId: ids.task,
    eligibilityDecisionId: ids.eligibility, scopeVersionId: ids.scope,
    predecessorEventId: ids.predecessor, relatedOperationId: ids.prepare,
    amountCents: 12_000, currency: 'usd', recordedBy: ids.actor,
    occurredAt: '1999-01-01T00:00:00.000Z', paymentMethodReference,
  };
}

class ObservingJournal implements FinancialProviderCommandJournal {
  readonly inputs: Array<RecordFinancialProviderCommandInput<unknown>> = [];
  readonly receipts: FinancialProviderCommandReceipt[] = [];
  private readonly inner = new InMemoryFinancialProviderCommandJournal();

  async recordRequested<TRequest>(input: RecordFinancialProviderCommandInput<TRequest>): Promise<FinancialProviderCommandReceipt> {
    this.inputs.push(input as RecordFinancialProviderCommandInput<unknown>);
    const receipt = await this.inner.recordRequested(input);
    this.receipts.push(receipt);
    return receipt;
  }
}

class ObservingPreparedAuthority implements UniversalV1PreparedFinancialCommandAuthority {
  readonly inputs: PrepareUniversalV1FinancialCommandInput[] = [];
  private readonly inner = new InMemoryUniversalV1PreparedFinancialCommandAuthority(
    () => new Date('2030-01-01T00:00:00.000Z')
  );

  async prepare(input: PrepareUniversalV1FinancialCommandInput): Promise<PreparedUniversalV1FinancialCommandReceipt> {
    this.inputs.push(input);
    return this.inner.prepare(input);
  }
}

class ImmediateDurableCoordinator implements ForegroundFinancialProviderCommandCoordinator {
  readonly contexts: Array<ForegroundFinancialProviderCommandContext<unknown>> = [];

  async dispatchOrReplay<TRequest, TResult>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    invokeAdapter: (exactCanonicalRequest: TRequest) => Promise<TResult>
  ): Promise<ForegroundFinancialProviderCommandResult<TResult>> {
    this.contexts.push(context as ForegroundFinancialProviderCommandContext<unknown>);
    return {
      result: await invokeAdapter(context.exactRequest),
      evidence: {
        commandId: ids.command,
        dispatchAttemptId: ids.attempt,
        outcomeFactId: ids.outcome,
        fakeOperationEventId: ids.fakeEvent,
      },
    };
  }
}

function reconciliationSnapshot(
  overrides: Partial<UniversalV1ReconciliationSnapshot> = {}
): UniversalV1ReconciliationSnapshot {
  return {
    workOrderId: ids.workOrder,
    reconciliationVersion: 1,
    captureEventId: ids.captureEvent,
    voidState: 'NOT_APPLICABLE',
    captureState: 'CAPTURED',
    refundState: 'NOT_APPLICABLE',
    reversalState: 'NOT_APPLICABLE',
    settlementState: 'NOT_APPLICABLE',
    fundingState: 'NOT_APPLICABLE',
    providerReleaseState: 'NOT_APPLICABLE',
    payoutState: 'NOT_APPLICABLE',
    bankSettlementState: 'NOT_APPLICABLE',
    ledgerState: 'MATCHED',
    reconciliationState: 'MATCHED',
    mismatchCodes: [],
    customerLedgerAmountCents: 12_000,
    providerLedgerAmountCents: 10_000,
    currency: 'USD',
    expectedVersion: 0,
    recordedBy: ids.actor,
    ...overrides,
  };
}

function coordinatedFixture() {
  const journal = new ObservingJournal();
  const providerRepository = new InMemoryFakeFinancialOperationRepository();
  const provider = new FakeFinancialProvider(providerRepository);
  const lifecycle = new InMemoryUniversalV1FinancialLifecycleRepository();
  const coordinator = new ImmediateDurableCoordinator();
  const service = new UniversalV1FinancialApplicationService(
    provider,
    lifecycle,
    { assertAuthorized: vi.fn() },
    'FAKE',
    journal,
    new ObservingPreparedAuthority(),
    undefined,
    coordinator
  );
  return { coordinator, journal, lifecycle, provider, providerRepository, service };
}

function fixture(
  journal: FinancialProviderCommandJournal = new ObservingJournal(),
  prepared: UniversalV1PreparedFinancialCommandAuthority = new ObservingPreparedAuthority()
) {
  const providerRepository = new InMemoryFakeFinancialOperationRepository();
  const provider = new FakeFinancialProvider(providerRepository);
  const lifecycle = new InMemoryUniversalV1FinancialLifecycleRepository();
  const service = new UniversalV1FakeFinancialApplicationService(
    provider, lifecycle, { assertAuthorized: vi.fn() }, journal, prepared
  );
  return { provider, providerRepository, lifecycle, service };
}

describe('UniversalV1FakeFinancialApplicationService foreground dispatch hold', () => {
  it('commits PREPARED and REQUESTED but performs zero adapter or lifecycle I/O without DISPATCH_ATTEMPTED', async () => {
    const journal = new ObservingJournal();
    const prepared = new ObservingPreparedAuthority();
    const { provider, providerRepository, lifecycle, service } = fixture(journal, prepared);
    const adapter = vi.spyOn(provider, 'preparePaymentMethod');
    const materialize = vi.spyOn(lifecycle, 'recordFinancialEvent');

    await expect(service.executeFinancialEvent(preparation())).rejects.toThrow(
      'FINANCIAL_PROVIDER_COMMAND_JOURNAL_FOREGROUND_DISPATCH_COORDINATOR_REQUIRED'
    );
    expect(prepared.inputs).toHaveLength(1);
    expect(journal.inputs).toHaveLength(1);
    expect(adapter).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(providerRepository.events()).toHaveLength(0);
  });

  it('binds every semantic adapter field through the exact canonical request digest', async () => {
    const firstPrepared = new ObservingPreparedAuthority();
    const firstJournal = new ObservingJournal();
    await expect(fixture(firstJournal, firstPrepared).service.executeFinancialEvent(authorization()))
      .rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');

    const exactRequest = {
      operationId: ids.authorize, idempotencyKey: 'app:authorize:coordinator-hold:0001',
      expectedVersion: 0, amountCents: 12_000, currency: 'usd',
      relatedOperationId: ids.prepare, paymentMethodReference: 'fake-payment-method-reference',
    };
    expect(firstPrepared.inputs[0]?.providerRequestSha256).toBe(
      canonicalFinancialProviderRequestSha256(exactRequest)
    );
    expect(firstJournal.inputs[0]?.exactRequest).toEqual(exactRequest);
    expect(firstJournal.inputs[0]?.actor).toEqual({ actorId: ids.actor, actorKind: 'PARTICIPANT' });

    const changedPrepared = new ObservingPreparedAuthority();
    await expect(fixture(new ObservingJournal(), changedPrepared).service.executeFinancialEvent(
      authorization('different-payment-method-reference')
    )).rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');
    expect(changedPrepared.inputs[0]?.providerRequestSha256)
      .not.toBe(firstPrepared.inputs[0]?.providerRequestSha256);
  });

  it('changes PREPARED digest for each previously unbound adapter semantic', async () => {
    const digestFor = async (command: ExecuteUniversalV1FinancialEventCommand) => {
      const prepared = new ObservingPreparedAuthority();
      await expect(fixture(new ObservingJournal(), prepared).service.executeFinancialEvent(command))
        .rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');
      return prepared.inputs[0]?.providerRequestSha256;
    };
    const pairs: Array<[ExecuteUniversalV1FinancialEventCommand, ExecuteUniversalV1FinancialEventCommand]> = [
      [preparation(), preparation({ customerId: 'different-customer' })],
      [authorization(), authorization('different-payment-method')],
      [
        { ...authorization(), operationKind: 'SECURE', authorizationOperationId: ids.prepare },
        { ...authorization(), operationKind: 'SECURE', authorizationOperationId: ids.authorize },
      ],
      [
        { ...authorization(), operationKind: 'REFUND', originalAmountCents: 12_000 },
        { ...authorization(), operationKind: 'REFUND', originalAmountCents: 13_000 },
      ],
      [
        { ...authorization(), operationKind: 'PAYOUT', providerAccountReference: 'account-a' },
        { ...authorization(), operationKind: 'PAYOUT', providerAccountReference: 'account-b' },
      ],
    ];
    for (const [left, right] of pairs) {
      expect(await digestFor(left)).not.toBe(await digestFor(right));
    }
  });

  it('refuses exact PREPARED replay before a second REQUESTED or adapter attempt', async () => {
    const prepared = new ObservingPreparedAuthority();
    const journal = new ObservingJournal();
    const { provider, service } = fixture(journal, prepared);
    const adapter = vi.spyOn(provider, 'preparePaymentMethod');

    await expect(service.executeFinancialEvent(preparation())).rejects.toThrow(
      'FOREGROUND_DISPATCH_COORDINATOR_REQUIRED'
    );
    await expect(service.executeFinancialEvent(preparation())).rejects.toThrow(
      'UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_REPLAY_FOREGROUND_COORDINATOR_REQUIRED'
    );
    expect(prepared.inputs).toHaveLength(2);
    expect(journal.inputs).toHaveLength(1);
    expect(adapter).not.toHaveBeenCalled();
  });

  it('holds PREPARE non-success scenarios before adapter and genesis lifecycle persistence', async () => {
    const { provider, lifecycle, service } = fixture();
    const adapter = vi.spyOn(provider, 'preparePaymentMethod');
    const materialize = vi.spyOn(lifecycle, 'recordFinancialEvent');
    await expect(service.executeFinancialEvent(preparation({ scenario: 'DECLINE' })))
      .rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');
    expect(adapter).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('persists neither participant wall-clock time nor a false operator classification', async () => {
    const prepared = new ObservingPreparedAuthority();
    const journal = new ObservingJournal();
    await expect(fixture(journal, prepared).service.executeFinancialEvent(preparation()))
      .rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');
    expect(prepared.inputs[0]).not.toHaveProperty('occurredAt');
    expect(journal.inputs[0]?.actor).toEqual({ actorId: ids.actor, actorKind: 'PARTICIPANT' });
  });

  it('performs zero provider I/O when PREPARED or REQUESTED persistence refuses', async () => {
    const refusingPrepared: UniversalV1PreparedFinancialCommandAuthority = {
      prepare: vi.fn().mockRejectedValue(new Error('PREPARED_REFUSED')),
    };
    const preparedFixture = fixture(new ObservingJournal(), refusingPrepared);
    const preparedAdapter = vi.spyOn(preparedFixture.provider, 'preparePaymentMethod');
    await expect(preparedFixture.service.executeFinancialEvent(preparation())).rejects.toThrow('PREPARED_REFUSED');
    expect(preparedAdapter).not.toHaveBeenCalled();

    const refusingJournal: FinancialProviderCommandJournal = {
      recordRequested: vi.fn().mockRejectedValue(new Error('REQUESTED_REFUSED')),
    };
    const journalFixture = fixture(refusingJournal);
    const journalAdapter = vi.spyOn(journalFixture.provider, 'preparePaymentMethod');
    await expect(journalFixture.service.executeFinancialEvent(preparation())).rejects.toThrow('REQUESTED_REFUSED');
    expect(journalAdapter).not.toHaveBeenCalled();
  });

  it('keeps production, real-provider, and caller-owned transaction paths sealed', async () => {
    const denied = fixture();
    await expect(denied.service.executeFinancialEvent({ ...preparation(), providerKind: 'APPROVED_PROVIDER' }))
      .rejects.toThrow('UNIVERSAL_FINANCE_REAL_PROVIDER_REFUSED');
    expect(() => authorizeUniversalV1FakeFinancialTransaction()).toThrow(
      'UNIVERSAL_FINANCE_CALLER_OWNED_TRANSACTION_PREPARED_AUTHORITY_REFUSED'
    );
    expect(denied.providerRepository.events()).toHaveLength(0);
  });
});

describe('Universal V1 durable non-lifecycle command evidence', () => {
  it('binds the exact reconciliation snapshot through provider request, fake metadata, and repository evidence', async () => {
    const { journal, lifecycle, providerRepository, service } = coordinatedFixture();
    const recordReconciliation = vi.spyOn(lifecycle, 'recordReconciliation');
    const snapshot = reconciliationSnapshot();
    const reconciliationSnapshotSha256 =
      canonicalUniversalV1ReconciliationSnapshotSha256(snapshot);
    expect(
      canonicalUniversalV1ReconciliationSnapshotSha256(
        reconciliationSnapshot({ customerLedgerAmountCents: 12_001 })
      )
    ).not.toBe(reconciliationSnapshotSha256);

    const result = await service.reconcile({
      providerKind: 'FAKE',
      operationId: ids.reconciliation,
      idempotencyKey: 'app:reconcile:snapshot-binding:0001',
      providerExpectedVersion: 0,
      relatedOperationId: ids.authorize,
      terminalIntentId: ids.terminalIntent,
      snapshot,
    });

    expect(result).toMatchObject({ providerState: 'MATCHED', reconciliationVersion: 1 });
    expect(journal.inputs[0]?.exactRequest).toEqual({
      operationId: ids.reconciliation,
      idempotencyKey: 'app:reconcile:snapshot-binding:0001',
      expectedVersion: 0,
      relatedOperationId: ids.authorize,
      reconciliationSnapshotSha256,
    });
    expect(journal.inputs[0]).toMatchObject({
      operationKind: 'RECONCILE',
      exactRequest: { reconciliationSnapshotSha256 },
    });
    expect(providerRepository.events()[0]?.metadata).toEqual({
      reconciliationSnapshotSha256,
    });
    expect(recordReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: 'FAKE',
        reconciliationSnapshotSha256,
        terminalIntentId: ids.terminalIntent,
        durableFakeEvidence: {
          commandId: ids.command,
          dispatchAttemptId: ids.attempt,
          outcomeFactId: ids.outcome,
          fakeOperationEventId: ids.fakeEvent,
        },
      })
    );
    expect(journal.receipts[0]?.requestSha256).toBe(
      canonicalFinancialProviderRequestSha256({
        operationId: ids.reconciliation,
        idempotencyKey: 'app:reconcile:snapshot-binding:0001',
        expectedVersion: 0,
        relatedOperationId: ids.authorize,
        reconciliationSnapshotSha256,
      })
    );
  });

  it('returns fake provider-account results with the durable dispatch chain and all provider fields', async () => {
    const { service } = coordinatedFixture();
    const onboarding = await service.onboardProvider({
      providerKind: 'FAKE',
      operationId: ids.reconciliation,
      idempotencyKey: 'app:provider-account:onboard:0001',
      providerExpectedVersion: 0,
      providerId: 'provider-1',
      recordedBy: ids.actor,
    });

    expect(onboarding).toMatchObject({
      operationKind: 'ONBOARD_PROVIDER',
      providerKind: 'FAKE',
      state: 'SUCCEEDED',
      externalReference: expect.stringMatching(/^fake_onboard_provider_/u),
      durableFakeEvidence: {
        commandId: ids.command,
        dispatchAttemptId: ids.attempt,
        outcomeFactId: ids.outcome,
        fakeOperationEventId: ids.fakeEvent,
      },
    });

    const refresh = await service.refreshProviderAccountState({
      providerKind: 'FAKE',
      operationId: ids.authorize,
      idempotencyKey: 'app:provider-account:refresh:0001',
      providerExpectedVersion: 0,
      providerId: 'provider-1',
      providerAccountReference: onboarding.externalReference,
      recordedBy: ids.actor,
    });
    expect(refresh).toMatchObject({
      operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
      providerKind: 'FAKE',
      providerId: 'provider-1',
      accountState: 'ENABLED',
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsDue: [],
      durableFakeEvidence: {
        commandId: ids.command,
        dispatchAttemptId: ids.attempt,
        outcomeFactId: ids.outcome,
        fakeOperationEventId: ids.fakeEvent,
      },
    });
  });

  it('inserts the terminal reconciliation bridge in the canonical fact transaction', async () => {
    const snapshot = reconciliationSnapshot({ reconciliationState: 'CLOSED' });
    const durableFakeEvidence = {
      commandId: ids.command,
      dispatchAttemptId: ids.attempt,
      outcomeFactId: ids.outcome,
      fakeOperationEventId: ids.fakeEvent,
    } as const;
    const reconciliationFactId = '00000000-0000-4000-8000-000000000131';
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const query = (async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO task_reconciliation_facts')) {
        return {
          rows: [{
            id: reconciliationFactId,
            work_order_id: ids.workOrder,
            reconciliation_version: 1,
            reconciliation_state: 'CLOSED',
            mismatch_codes: [],
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO public.universal_v1_fake_reconciliation_bridges')) {
        return {
          rows: [{
            reconciliation_bridge_id: '00000000-0000-4000-8000-000000000132',
            terminal_intent_id: ids.terminalIntent,
            reconciliation_fact_id: reconciliationFactId,
            command_id: ids.command,
            dispatch_attempt_id: ids.attempt,
            outcome_fact_id: ids.outcome,
            fake_operation_event_id: ids.fakeEvent,
            authority_chain_sha256: 'd'.repeat(64),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as QueryFn;
    const database = {
      serializableTransaction: vi.fn(async <T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
        callback(query)),
    } as unknown as Database;
    const repository = new PostgresUniversalV1FinancialLifecycleRepository(database);

    await expect(repository.recordReconciliation({
      operationId: ids.reconciliation,
      idempotencyKey: 'app:reconcile:postgres-bridge:0001',
      providerKind: 'FAKE',
      providerState: 'MATCHED',
      providerOperationVersion: 1,
      providerIdempotencyReplayed: false,
      externalReference: 'fake_reconcile_exact',
      reconciliationSnapshotSha256:
        canonicalUniversalV1ReconciliationSnapshotSha256(snapshot),
      terminalIntentId: ids.terminalIntent,
      durableFakeEvidence,
      snapshot,
    })).resolves.toMatchObject({ id: reconciliationFactId, reconciliationState: 'CLOSED' });

    expect(database.serializableTransaction).toHaveBeenCalledTimes(1);
    const bridgeInsert = queries.find(({ sql }) =>
      sql.includes('INSERT INTO public.universal_v1_fake_reconciliation_bridges')
    );
    expect(bridgeInsert?.params).toEqual([
      ids.terminalIntent,
      reconciliationFactId,
      ids.command,
      ids.attempt,
      ids.outcome,
      ids.fakeEvent,
    ]);
  });

  it('fails closed before fake reconciliation or account adapter I/O without a durable coordinator', async () => {
    const { provider, providerRepository, service } = fixture();
    const reconcileAdapter = vi.spyOn(provider, 'reconcile');
    const onboardAdapter = vi.spyOn(provider, 'onboardProvider');

    await expect(
      service.reconcile({
        providerKind: 'FAKE',
        operationId: ids.reconciliation,
        idempotencyKey: 'app:reconcile:missing-coordinator:0001',
        providerExpectedVersion: 0,
        relatedOperationId: ids.authorize,
        snapshot: reconciliationSnapshot(),
      })
    ).rejects.toThrow('UNIVERSAL_FINANCE_RECONCILIATION_DURABLE_COORDINATOR_REQUIRED');
    await expect(
      service.onboardProvider({
        providerKind: 'FAKE',
        operationId: ids.reconciliation,
        idempotencyKey: 'app:provider-account:missing-coordinator:0001',
        providerExpectedVersion: 0,
        providerId: 'provider-1',
        recordedBy: ids.actor,
      })
    ).rejects.toThrow('UNIVERSAL_FINANCE_ACCOUNT_COMMAND_DURABLE_COORDINATOR_REQUIRED');
    expect(reconcileAdapter).not.toHaveBeenCalled();
    expect(onboardAdapter).not.toHaveBeenCalled();
    expect(providerRepository.events()).toHaveLength(0);
  });
});
