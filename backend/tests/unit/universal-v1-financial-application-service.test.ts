import { describe, expect, it, vi } from 'vitest';

import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  canonicalFinancialProviderRequestSha256,
  InMemoryFinancialProviderCommandJournal,
  type FinancialProviderCommandJournal,
  type FinancialProviderCommandReceipt,
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
  InMemoryUniversalV1FinancialLifecycleRepository,
  UniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
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
  private readonly inner = new InMemoryFinancialProviderCommandJournal();

  async recordRequested<TRequest>(input: RecordFinancialProviderCommandInput<TRequest>): Promise<FinancialProviderCommandReceipt> {
    this.inputs.push(input as RecordFinancialProviderCommandInput<unknown>);
    return this.inner.recordRequested(input);
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
