import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeEvent: vi.fn(),
  reconcile: vi.fn(),
  onboard: vi.fn(),
  refreshAccountState: vi.fn(),
  webhook: vi.fn(),
  assertTask: vi.fn(),
  assertWorkOrder: vi.fn(),
  assertWebhookBoundary: vi.fn(),
  assertHmac: vi.fn(),
  enqueueEvent: vi.fn(),
  enqueueReconciliation: vi.fn(),
}));

vi.mock('../../src/services/payment/UniversalV1FinancialApplicationService.js', () => ({
  createUniversalV1FakeFinancialApplicationService: () => ({
    executeFinancialEvent: mocks.executeEvent,
    reconcile: mocks.reconcile,
    onboardProvider: mocks.onboard,
    refreshProviderAccountState: mocks.refreshAccountState,
    ingestWebhook: mocks.webhook,
  }),
}));

vi.mock('../../src/services/payment/SyntheticFinancialCommandAuthority.js', () => {
  class SyntheticFinancialAuthorityError extends Error {}
  return {
    SyntheticFinancialAuthorityError,
    assertSyntheticFinancialWebhookHmac: mocks.assertHmac,
    syntheticFinancialCommandAuthority: {
      assertTaskParticipant: mocks.assertTask,
      assertWorkOrderParticipant: mocks.assertWorkOrder,
      assertWebhookOperationBoundary: mocks.assertWebhookBoundary,
    },
  };
});

vi.mock('../../src/jobs/synthetic-financial-worker.js', () => ({
  enqueueSyntheticFinancialEvent: mocks.enqueueEvent,
  enqueueSyntheticReconciliation: mocks.enqueueReconciliation,
}));

import {
  syntheticFinanceRouter,
  universalFinanceRouter,
} from '../../src/routers/syntheticFinance.js';

const ids = {
  actor: '00000000-0000-4000-8000-000000000201',
  draft: '00000000-0000-4000-8000-000000000202',
  task: '00000000-0000-4000-8000-000000000203',
  eligibility: '00000000-0000-4000-8000-000000000204',
  scope: '00000000-0000-4000-8000-000000000205',
  operation: '00000000-0000-4000-8000-000000000206',
  workOrder: '00000000-0000-4000-8000-000000000207',
  related: '00000000-0000-4000-8000-000000000208',
} as const;

function caller() {
  return universalFinanceRouter.createCaller({
    user: {
      id: ids.actor,
      is_banned: false,
      account_status: 'ACTIVE',
    } as never,
    firebaseUid: 'synthetic-user',
    ip: '127.0.0.1',
  });
}

const event = {
  providerKind: 'FAKE' as const,
  operationKind: 'PREPARE_PAYMENT_METHOD' as const,
  operationId: ids.operation,
  idempotencyKey: 'route:prepare:0001',
  providerExpectedVersion: 0,
  lifecycleExpectedVersion: 0,
  taskDraftId: ids.draft,
  taskId: ids.task,
  eligibilityDecisionId: ids.eligibility,
  scopeVersionId: ids.scope,
  occurredAt: '2026-08-26T12:00:00.000Z',
  customerId: 'synthetic-customer',
};

const reconciliation = {
  providerKind: 'FAKE' as const,
  operationId: ids.operation,
  idempotencyKey: 'route:reconcile:0001',
  providerExpectedVersion: 0,
  relatedOperationId: ids.related,
  snapshot: {
    workOrderId: ids.workOrder,
    reconciliationVersion: 1,
    voidState: 'NOT_APPLICABLE' as const,
    captureState: 'NOT_APPLICABLE' as const,
    refundState: 'NOT_APPLICABLE' as const,
    reversalState: 'NOT_APPLICABLE' as const,
    settlementState: 'NOT_APPLICABLE' as const,
    fundingState: 'NOT_APPLICABLE' as const,
    providerReleaseState: 'NOT_APPLICABLE' as const,
    payoutState: 'NOT_APPLICABLE' as const,
    bankSettlementState: 'NOT_APPLICABLE' as const,
    ledgerState: 'MISMATCH' as const,
    reconciliationState: 'MISMATCH' as const,
    mismatchCodes: ['SYNTHETIC_MISMATCH'],
    customerLedgerAmountCents: 0,
    providerLedgerAmountCents: 0,
    currency: 'USD',
    expectedVersion: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeEvent.mockResolvedValue({ operationId: ids.operation });
  mocks.reconcile.mockResolvedValue({ operationId: ids.operation });
  mocks.onboard.mockResolvedValue({ operationId: ids.operation });
  mocks.refreshAccountState.mockResolvedValue({ operationId: ids.operation });
  mocks.webhook.mockResolvedValue({ operationId: ids.operation });
  mocks.enqueueEvent.mockResolvedValue({ queue: 'synthetic_finance', jobId: 'event-job' });
  mocks.enqueueReconciliation.mockResolvedValue({
    queue: 'synthetic_finance',
    jobId: 'reconciliation-job',
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('universalFinanceRouter', () => {
  it('keeps the synthetic route name as an exact compatibility alias', () => {
    expect(syntheticFinanceRouter).toBe(universalFinanceRouter);
  });

  it('requires a current authenticated user', async () => {
    const anonymous = universalFinanceRouter.createCaller({
      user: null,
      firebaseUid: null,
      ip: '127.0.0.1',
    });
    await expect(anonymous.executeEvent(event)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.executeEvent).not.toHaveBeenCalled();
  });

  it('forces the authenticated actor into a participant-authorized event command', async () => {
    await caller().executeEvent(event);
    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.executeEvent).toHaveBeenCalledWith({ ...event, recordedBy: ids.actor });
  });

  it('routes recovery effects through the same provider-neutral application service', async () => {
    const recovery = {
      providerKind: 'FAKE' as const,
      operationKind: 'REFUND' as const,
      operationId: ids.operation,
      idempotencyKey: 'route:refund:recovery:0001',
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 4,
      taskDraftId: ids.draft,
      taskId: ids.task,
      eligibilityDecisionId: ids.eligibility,
      scopeVersionId: ids.scope,
      predecessorEventId: '00000000-0000-4000-8000-000000000209',
      relatedOperationId: ids.related,
      amountCents: 2_500,
      originalAmountCents: 12_500,
      currency: 'usd',
      scenario: 'PARTIAL_REFUND' as const,
      occurredAt: '2026-08-26T12:05:00.000Z',
    };

    await caller().executeEvent(recovery);

    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.executeEvent).toHaveBeenCalledWith({
      ...recovery,
      recordedBy: ids.actor,
    });
  });

  it('admits provider release and bank-settlement observation as distinct fake-only commands', async () => {
    const base = {
      providerKind: 'FAKE' as const,
      operationId: ids.operation,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 7,
      taskDraftId: ids.draft,
      taskId: ids.task,
      eligibilityDecisionId: ids.eligibility,
      scopeVersionId: ids.scope,
      predecessorEventId: '00000000-0000-4000-8000-000000000209',
      relatedOperationId: ids.related,
      amountCents: 10_000,
      currency: 'usd',
      occurredAt: '2026-08-26T12:06:00.000Z',
    };
    const providerRelease = {
      ...base,
      operationKind: 'PROVIDER_RELEASE' as const,
      idempotencyKey: 'route:provider-release:0001',
    };
    await caller().executeEvent(providerRelease);
    expect(mocks.executeEvent).toHaveBeenLastCalledWith({
      ...providerRelease,
      recordedBy: ids.actor,
    });

    const bankSettlement = {
      ...base,
      operationKind: 'OBSERVE_BANK_SETTLEMENT' as const,
      idempotencyKey: 'route:bank-settlement:0001',
      lifecycleExpectedVersion: 8,
    };
    await caller().executeEvent(bankSettlement);
    expect(mocks.executeEvent).toHaveBeenLastCalledWith({
      ...bankSettlement,
      recordedBy: ids.actor,
    });
  });

  it('queues only the closed fake-provider command schema', async () => {
    await expect(
      caller().enqueueEvent({
        ...event,
        providerKind: 'EXTERNAL' as 'FAKE',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.enqueueEvent).not.toHaveBeenCalled();

    await caller().enqueueEvent(event);
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(ids.actor, event);
  });

  it('binds direct and queued reconciliation to the authenticated Work Order participant', async () => {
    await caller().reconcile(reconciliation);
    expect(mocks.assertWorkOrder).toHaveBeenCalledWith(ids.actor, ids.workOrder);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      ...reconciliation,
      snapshot: { ...reconciliation.snapshot, recordedBy: ids.actor },
    });

    await caller().enqueueReconciliation(reconciliation);
    expect(mocks.enqueueReconciliation).toHaveBeenCalledWith(ids.actor, reconciliation);
  });

  it('limits provider onboarding and account refresh to self and requires signed participant-bound webhooks', async () => {
    const auxiliary = {
      providerKind: 'FAKE' as const,
      operationId: ids.operation,
      idempotencyKey: 'route:auxiliary:0001',
      providerExpectedVersion: 0,
    };
    await caller().onboardSelf(auxiliary);
    expect(mocks.onboard).toHaveBeenCalledWith({ ...auxiliary, providerId: ids.actor });

    await caller().refreshProviderAccountState({
      ...auxiliary,
      providerAccountReference: 'fake-provider-account-1',
    });
    expect(mocks.refreshAccountState).toHaveBeenCalledWith({
      ...auxiliary,
      providerAccountReference: 'fake-provider-account-1',
      providerId: ids.actor,
    });

    const webhook = {
      ...auxiliary,
      taskDraftId: ids.draft,
      taskId: ids.task,
      providerEventReference: 'synthetic-event-1',
      scenario: 'DUPLICATE_WEBHOOK' as const,
    };
    const rawBody = JSON.stringify(webhook);
    const signature = 'a'.repeat(64);
    await caller().ingestWebhook({ rawBody, signature });
    expect(mocks.assertHmac).toHaveBeenCalledWith(rawBody, signature);
    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.assertWebhookBoundary).toHaveBeenCalledWith(ids.draft, ids.task, ids.operation);
    expect(mocks.webhook).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId: ids.operation,
      idempotencyKey: 'route:auxiliary:0001',
      providerExpectedVersion: 0,
      providerEventReference: 'synthetic-event-1',
      scenario: 'DUPLICATE_WEBHOOK',
      authenticated: true,
    });
  });

  it('does not trust an authenticated tRPC caller without fake-provider HMAC authority', async () => {
    const { SyntheticFinancialAuthorityError } =
      await import('../../src/services/payment/SyntheticFinancialCommandAuthority.js');
    mocks.assertHmac.mockImplementationOnce(() => {
      throw new SyntheticFinancialAuthorityError('WEBHOOK_HMAC_INVALID');
    });
    const rawBody = JSON.stringify({
      providerKind: 'FAKE',
      operationId: ids.operation,
      idempotencyKey: 'route:webhook:unsigned-0001',
      providerExpectedVersion: 0,
      taskDraftId: ids.draft,
      taskId: ids.task,
      providerEventReference: 'synthetic-event-unsigned',
    });
    await expect(
      caller().ingestWebhook({ rawBody, signature: '0'.repeat(64) })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.assertTask).not.toHaveBeenCalled();
    expect(mocks.assertWebhookBoundary).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
});
