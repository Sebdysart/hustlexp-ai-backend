import { describe, expect, it, vi } from 'vitest';

import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
  type FakeFinancialScenario,
} from '../../src/services/payment/FakeFinancialProvider.js';
import type { FinancialProviderPorts } from '../../src/services/payment/FinancialProviderPorts.js';
import {
  InMemoryUniversalV1FinancialLifecycleRepository,
  UniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
  type FakeFinancialExecutionGate,
  type UniversalV1ReconciliationSnapshot,
} from '../../src/services/payment/UniversalV1FinancialApplicationService.js';

const ids = {
  taskDraft: '00000000-0000-4000-8000-000000000101',
  task: '00000000-0000-4000-8000-000000000102',
  eligibility: '00000000-0000-4000-8000-000000000103',
  scope: '00000000-0000-4000-8000-000000000104',
  actor: '00000000-0000-4000-8000-000000000105',
  completion: '00000000-0000-4000-8000-000000000106',
  workOrder: '00000000-0000-4000-8000-000000000107',
  prepare: '00000000-0000-4000-8000-000000000111',
  authorize: '00000000-0000-4000-8000-000000000112',
  secure: '00000000-0000-4000-8000-000000000113',
  capture: '00000000-0000-4000-8000-000000000114',
  refund: '00000000-0000-4000-8000-000000000115',
  reverse: '00000000-0000-4000-8000-000000000116',
  settle: '00000000-0000-4000-8000-000000000117',
  reconcile: '00000000-0000-4000-8000-000000000118',
  account: '00000000-0000-4000-8000-000000000119',
  webhook: '00000000-0000-4000-8000-000000000120',
  accountState: '00000000-0000-4000-8000-000000000121',
  fund: '00000000-0000-4000-8000-000000000122',
  providerRelease: '00000000-0000-4000-8000-000000000123',
  payout: '00000000-0000-4000-8000-000000000124',
  bankSettlement: '00000000-0000-4000-8000-000000000125',
  voidEvent: '00000000-0000-4000-8000-000000000131',
  captureEvent: '00000000-0000-4000-8000-000000000132',
  refundEvent: '00000000-0000-4000-8000-000000000133',
  reversalEvent: '00000000-0000-4000-8000-000000000134',
  settlementEvent: '00000000-0000-4000-8000-000000000135',
  fundingEvent: '00000000-0000-4000-8000-000000000136',
  providerReleaseEvent: '00000000-0000-4000-8000-000000000137',
  payoutEvent: '00000000-0000-4000-8000-000000000138',
  bankSettlementEvent: '00000000-0000-4000-8000-000000000139',
} as const;

const occurredAt = '2026-08-26T12:00:00.000Z';

function fixture(gate: FakeFinancialExecutionGate = { assertAuthorized: vi.fn() }) {
  const providerRepository = new InMemoryFakeFinancialOperationRepository();
  const lifecycleRepository = new InMemoryUniversalV1FinancialLifecycleRepository();
  const provider = new FakeFinancialProvider(providerRepository);
  const service = new UniversalV1FakeFinancialApplicationService(
    provider,
    lifecycleRepository,
    gate
  );
  return { service, gate, providerRepository, lifecycleRepository };
}

function preparation(
  idempotencyKey = 'app:prepare:0001',
  scenario?: FakeFinancialScenario
): ExecuteUniversalV1FinancialEventCommand {
  return {
    providerKind: 'FAKE',
    operationKind: 'PREPARE_PAYMENT_METHOD',
    operationId: ids.prepare,
    idempotencyKey,
    providerExpectedVersion: 0,
    lifecycleExpectedVersion: 0,
    taskDraftId: ids.taskDraft,
    customerId: 'synthetic-customer-1',
    scenario,
    recordedBy: ids.actor,
    occurredAt,
  };
}

function effect(
  operationKind: Exclude<
    ExecuteUniversalV1FinancialEventCommand['operationKind'],
    'PREPARE_PAYMENT_METHOD'
  >,
  operationId: string,
  idempotencyKey: string,
  predecessorEventId: string,
  relatedOperationId: string,
  lifecycleExpectedVersion: number,
  overrides: Partial<
    Extract<
      ExecuteUniversalV1FinancialEventCommand,
      {
        operationKind: Exclude<
          ExecuteUniversalV1FinancialEventCommand['operationKind'],
          'PREPARE_PAYMENT_METHOD'
        >;
      }
    >
  > = {}
): ExecuteUniversalV1FinancialEventCommand {
  return {
    providerKind: 'FAKE',
    operationKind,
    operationId,
    idempotencyKey,
    providerExpectedVersion: 0,
    lifecycleExpectedVersion,
    taskDraftId: ids.taskDraft,
    taskId: ids.task,
    eligibilityDecisionId: ids.eligibility,
    scopeVersionId: ids.scope,
    predecessorEventId,
    relatedOperationId,
    amountCents: 12_500,
    currency: 'usd',
    recordedBy: ids.actor,
    occurredAt,
    ...(operationKind === 'AUTHORIZE' ? { paymentMethodReference: 'fake-payment-method' } : {}),
    ...(operationKind === 'SECURE' ? { authorizationOperationId: ids.authorize } : {}),
    ...(operationKind === 'CAPTURE' ? { completionFactId: ids.completion } : {}),
    ...(operationKind === 'REFUND' ? { originalAmountCents: 12_500 } : {}),
    ...(operationKind === 'PAYOUT' ? { providerAccountReference: 'fake-provider-account' } : {}),
    ...overrides,
  } as ExecuteUniversalV1FinancialEventCommand;
}

async function securedChain(service: UniversalV1FakeFinancialApplicationService) {
  const prepared = await service.executeFinancialEvent(preparation());
  const authorized = await service.executeFinancialEvent(
    effect('AUTHORIZE', ids.authorize, 'app:authorize:0001', prepared.id, ids.prepare, 1)
  );
  const secured = await service.executeFinancialEvent(
    effect('SECURE', ids.secure, 'app:secure:event:0001', authorized.id, ids.authorize, 2)
  );
  return { prepared, authorized, secured };
}

function openReconciliationSnapshot(
  overrides: Partial<UniversalV1ReconciliationSnapshot> = {}
): UniversalV1ReconciliationSnapshot {
  return {
    workOrderId: ids.workOrder,
    reconciliationVersion: 1,
    voidState: 'NOT_APPLICABLE',
    captureState: 'NOT_APPLICABLE',
    refundState: 'NOT_APPLICABLE',
    reversalState: 'NOT_APPLICABLE',
    settlementState: 'NOT_APPLICABLE',
    fundingState: 'NOT_APPLICABLE',
    providerReleaseState: 'NOT_APPLICABLE',
    payoutState: 'NOT_APPLICABLE',
    bankSettlementState: 'NOT_APPLICABLE',
    ledgerState: 'PENDING',
    reconciliationState: 'OPEN',
    mismatchCodes: [],
    customerLedgerAmountCents: 0,
    providerLedgerAmountCents: 0,
    currency: 'USD',
    expectedVersion: 0,
    recordedBy: ids.actor,
    ...overrides,
  };
}

function matchedReconciliationSnapshot(): UniversalV1ReconciliationSnapshot {
  return openReconciliationSnapshot({
    captureEventId: ids.captureEvent,
    settlementEventId: ids.settlementEvent,
    fundingEventId: ids.fundingEvent,
    providerReleaseEventId: ids.providerReleaseEvent,
    payoutEventId: ids.payoutEvent,
    bankSettlementEventId: ids.bankSettlementEvent,
    captureState: 'CAPTURED',
    settlementState: 'SETTLED',
    fundingState: 'FUNDED',
    providerReleaseState: 'RELEASED',
    payoutState: 'PAID',
    bankSettlementState: 'SETTLED',
    ledgerState: 'MATCHED',
    reconciliationState: 'MATCHED',
    customerLedgerAmountCents: 12_500,
    providerLedgerAmountCents: 10_000,
  });
}

describe('UniversalV1FakeFinancialApplicationService', () => {
  it('persists a successful provider-neutral preparation, authorization, and security chain', async () => {
    const { service, gate } = fixture();
    const { prepared, authorized, secured } = await securedChain(service);

    expect(prepared).toMatchObject({
      eventKind: 'PAYMENT_METHOD_PREPARED',
      status: 'SUCCEEDED',
      providerKind: 'FAKE',
      lifecycleExpectedVersion: 0,
      amountCents: null,
      currency: null,
    });
    expect(authorized).toMatchObject({
      eventKind: 'AUTHORIZED',
      status: 'SUCCEEDED',
      predecessorEventId: prepared.id,
      lifecycleExpectedVersion: 1,
      amountCents: 12_500,
      currency: 'USD',
    });
    expect(secured).toMatchObject({
      eventKind: 'SECURED',
      status: 'SUCCEEDED',
      predecessorEventId: authorized.id,
      lifecycleExpectedVersion: 2,
    });
    expect(gate.assertAuthorized).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['DECLINE', 'DECLINED', 'DECLINED'],
    ['TIMEOUT', 'PENDING', 'REQUESTED'],
  ] as const)(
    'binds a %s authorization result without inventing success',
    async (scenario, providerState, lifecycleStatus) => {
      const { service } = fixture();
      const prepared = await service.executeFinancialEvent(preparation());
      const result = await service.executeFinancialEvent(
        effect(
          'AUTHORIZE',
          ids.authorize,
          `app:authorize:${scenario.toLowerCase()}`,
          prepared.id,
          ids.prepare,
          1,
          { scenario }
        )
      );

      expect(result.providerState).toBe(providerState);
      expect(result.status).toBe(lifecycleStatus);
    }
  );

  it('replays the exact timeout without duplicating the canonical lifecycle event', async () => {
    const { service, providerRepository } = fixture();
    const prepared = await service.executeFinancialEvent(preparation());
    const command = effect(
      'AUTHORIZE',
      ids.authorize,
      'app:authorize:timeout-replay',
      prepared.id,
      ids.prepare,
      1,
      { scenario: 'TIMEOUT' }
    );

    const first = await service.executeFinancialEvent(command);
    const replay = await service.executeFinancialEvent(command);

    expect(first.idempotencyReplayed).toBe(false);
    expect(replay).toEqual({ ...first, idempotencyReplayed: true });
    expect(providerRepository.events()).toHaveLength(2);
  });

  it('separates provider retry version from the Task Draft lifecycle-chain version', async () => {
    const { service } = fixture();
    const prepared = await service.executeFinancialEvent(preparation());
    const first = await service.executeFinancialEvent(
      effect('AUTHORIZE', ids.authorize, 'app:authorize:retry:1', prepared.id, ids.prepare, 1, {
        scenario: 'RETRY',
      })
    );
    const retry = await service.executeFinancialEvent(
      effect('AUTHORIZE', ids.authorize, 'app:authorize:retry:2', first.id, ids.prepare, 2, {
        scenario: 'RETRY',
        providerExpectedVersion: 1,
      })
    );

    expect(first).toMatchObject({
      status: 'RETRYABLE_FAILURE',
      providerOperationVersion: 1,
      lifecycleExpectedVersion: 1,
    });
    expect(retry).toMatchObject({
      status: 'SUCCEEDED',
      providerOperationVersion: 2,
      lifecycleExpectedVersion: 2,
      operationId: first.operationId,
    });
  });

  it('binds reversal, partial refund, and delayed settlement as distinct facts', async () => {
    const refundFixture = fixture();
    const { secured: refundSecurity } = await securedChain(refundFixture.service);
    const capture = await refundFixture.service.executeFinancialEvent(
      effect('CAPTURE', ids.capture, 'app:capture:event:0001', refundSecurity.id, ids.secure, 3)
    );
    const partialRefund = await refundFixture.service.executeFinancialEvent(
      effect('REFUND', ids.refund, 'app:refund:partial', capture.id, ids.capture, 4, {
        amountCents: 2_500,
        scenario: 'PARTIAL_REFUND',
      })
    );

    const reversalFixture = fixture();
    const { secured: reversalSecurity } = await securedChain(reversalFixture.service);
    const reversal = await reversalFixture.service.executeFinancialEvent(
      effect(
        'REVERSAL',
        ids.reverse,
        'app:reversal:event:0001',
        reversalSecurity.id,
        ids.secure,
        3,
        { scenario: 'REVERSAL' }
      )
    );

    const settlementFixture = fixture();
    const { secured: settlementSecurity } = await securedChain(settlementFixture.service);
    const settlementCapture = await settlementFixture.service.executeFinancialEvent(
      effect('CAPTURE', ids.capture, 'app:capture:event:0001', settlementSecurity.id, ids.secure, 3)
    );
    const pendingSettlement = await settlementFixture.service.executeFinancialEvent(
      effect('SETTLE', ids.settle, 'app:settle:delayed:1', settlementCapture.id, ids.capture, 4, {
        scenario: 'DELAYED_SETTLEMENT',
      })
    );
    const settled = await settlementFixture.service.executeFinancialEvent(
      effect('SETTLE', ids.settle, 'app:settle:delayed:2', pendingSettlement.id, ids.capture, 5, {
        scenario: 'DELAYED_SETTLEMENT',
        providerExpectedVersion: 1,
      })
    );

    expect(capture.eventKind).toBe('CAPTURED');
    expect(partialRefund).toMatchObject({
      eventKind: 'REFUNDED',
      providerState: 'PARTIALLY_REFUNDED',
      amountCents: 2_500,
    });
    expect(reversal).toMatchObject({ eventKind: 'REVERSED', providerState: 'REVERSED' });
    expect(pendingSettlement).toMatchObject({
      eventKind: 'SETTLEMENT_OBSERVED',
      status: 'REQUESTED',
    });
    expect(settled).toMatchObject({
      eventKind: 'SETTLEMENT_OBSERVED',
      status: 'SUCCEEDED',
      providerOperationVersion: 2,
    });
  });

  it('keeps funding, provider release, payout, and bank settlement as distinct ordered facts', async () => {
    const { service, providerRepository } = fixture();
    const { secured } = await securedChain(service);
    const capture = await service.executeFinancialEvent(
      effect('CAPTURE', ids.capture, 'app:capture:settlement-chain', secured.id, ids.secure, 3)
    );
    const settlement = await service.executeFinancialEvent(
      effect('SETTLE', ids.settle, 'app:settle:chain', capture.id, ids.capture, 4)
    );
    const funding = await service.executeFinancialEvent(
      effect('FUND', ids.fund, 'app:fund:chain:0001', settlement.id, ids.settle, 5)
    );
    const providerRelease = await service.executeFinancialEvent(
      effect(
        'PROVIDER_RELEASE',
        ids.providerRelease,
        'app:provider-release:chain',
        funding.id,
        ids.fund,
        6,
        { amountCents: 10_000 }
      )
    );
    const payout = await service.executeFinancialEvent(
      effect('PAYOUT', ids.payout, 'app:payout:chain', providerRelease.id, ids.providerRelease, 7, {
        amountCents: 10_000,
      })
    );
    const bankSettlement = await service.executeFinancialEvent(
      effect(
        'OBSERVE_BANK_SETTLEMENT',
        ids.bankSettlement,
        'app:bank-settlement:chain',
        payout.id,
        ids.payout,
        8,
        { amountCents: 10_000 }
      )
    );

    expect([
      settlement.eventKind,
      funding.eventKind,
      providerRelease.eventKind,
      payout.eventKind,
      bankSettlement.eventKind,
    ]).toEqual([
      'SETTLEMENT_OBSERVED',
      'FUNDING_OBSERVED',
      'PROVIDER_RELEASED',
      'PAYOUT_OBSERVED',
      'BANK_SETTLEMENT_OBSERVED',
    ]);
    expect(
      providerRepository
        .events()
        .slice(-5)
        .map(({ operationKind }) => operationKind)
    ).toEqual(['SETTLE', 'FUND', 'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT']);
  });

  it('records matched and mismatched reconciliation snapshots and replays exact evidence', async () => {
    const { service } = fixture();
    const matchedCommand = {
      providerKind: 'FAKE' as const,
      operationId: ids.reconcile,
      idempotencyKey: 'app:reconcile:matched',
      providerExpectedVersion: 0,
      relatedOperationId: ids.settle,
      snapshot: matchedReconciliationSnapshot(),
    };
    const matched = await service.reconcile(matchedCommand);
    const replay = await service.reconcile(matchedCommand);
    expect(matched).toMatchObject({ providerState: 'MATCHED', reconciliationState: 'MATCHED' });
    expect(replay).toEqual({ ...matched, idempotencyReplayed: true });

    const mismatch = await service.reconcile({
      providerKind: 'FAKE',
      operationId: '00000000-0000-4000-8000-000000000121',
      idempotencyKey: 'app:reconcile:mismatch',
      providerExpectedVersion: 0,
      relatedOperationId: ids.settle,
      scenario: 'RECONCILIATION_MISMATCH',
      snapshot: openReconciliationSnapshot({
        reconciliationState: 'MISMATCH',
        ledgerState: 'MISMATCH',
        mismatchCodes: ['SYNTHETIC_LEDGER_DRIFT'],
      }),
    });
    expect(mismatch).toMatchObject({
      providerState: 'MISMATCH',
      reconciliationState: 'MISMATCH',
      mismatchCodes: ['SYNTHETIC_LEDGER_DRIFT'],
    });
  });

  it('models provider-account failure and duplicate webhook delivery through the application gate', async () => {
    const { service, gate, providerRepository } = fixture();
    const account = await service.onboardProvider({
      providerKind: 'FAKE',
      operationId: ids.account,
      idempotencyKey: 'app:account:failure',
      providerExpectedVersion: 0,
      providerId: 'synthetic-provider-1',
      scenario: 'PROVIDER_ACCOUNT_FAILURE',
    });
    const accountState = await service.refreshProviderAccountState({
      providerKind: 'FAKE',
      operationId: ids.accountState,
      idempotencyKey: 'app:account-state:failure',
      providerExpectedVersion: 0,
      providerId: 'synthetic-provider-1',
      providerAccountReference: account.externalReference,
      scenario: 'PROVIDER_ACCOUNT_FAILURE',
    });
    const webhookCommand = {
      providerKind: 'FAKE' as const,
      operationId: ids.webhook,
      idempotencyKey: 'app:webhook:duplicate',
      providerExpectedVersion: 0,
      providerEventReference: 'synthetic-event-1',
      authenticated: true,
      scenario: 'DUPLICATE_WEBHOOK' as const,
    };
    const webhook = await service.ingestWebhook(webhookCommand);
    const replay = await service.ingestWebhook(webhookCommand);

    expect(account.state).toBe('FAILED');
    expect(accountState).toMatchObject({
      operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
      accountState: 'FAILED',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: ['identity_verification'],
    });
    expect(webhook.state).toBe('ACCEPTED');
    expect(replay.idempotencyReplayed).toBe(true);
    expect(providerRepository.events()).toHaveLength(3);
    expect(gate.assertAuthorized).toHaveBeenCalledTimes(4);
  });

  it('fails closed before execution for production denial and any real-provider request', async () => {
    const deniedGate = {
      assertAuthorized: vi.fn(() => {
        throw new Error('NONPRODUCTION_FAKE_FINANCE_REFUSED:PRODUCTION');
      }),
    };
    const denied = fixture(deniedGate);
    await expect(denied.service.executeFinancialEvent(preparation())).rejects.toThrow(
      'NONPRODUCTION_FAKE_FINANCE_REFUSED:PRODUCTION'
    );
    expect(denied.providerRepository.events()).toHaveLength(0);

    const allowed = fixture();
    await expect(
      allowed.service.executeFinancialEvent({
        ...preparation(),
        providerKind: 'EXTERNAL',
      })
    ).rejects.toThrow('UNIVERSAL_FINANCE_REAL_PROVIDER_REFUSED');
    expect(allowed.providerRepository.events()).toHaveLength(0);
  });

  it('rejects a substituted provider result instead of persisting it', async () => {
    const provider = new FakeFinancialProvider(new InMemoryFakeFinancialOperationRepository());
    const substituted = new Proxy(provider as FinancialProviderPorts, {
      get(target, property, receiver) {
        if (property !== 'preparePaymentMethod') return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => ({
          ...(await Reflect.apply(target.preparePaymentMethod, target, args)),
          providerKind: 'EXTERNAL' as const,
        });
      },
    });
    const lifecycle = new InMemoryUniversalV1FinancialLifecycleRepository();
    const service = new UniversalV1FakeFinancialApplicationService(substituted, lifecycle, {
      assertAuthorized: vi.fn(),
    });

    await expect(service.executeFinancialEvent(preparation())).rejects.toThrow(
      'UNIVERSAL_FINANCE_PROVIDER_RESULT_IDENTITY_MISMATCH'
    );
  });
});
