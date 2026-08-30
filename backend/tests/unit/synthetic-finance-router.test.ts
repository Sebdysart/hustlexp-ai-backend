import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  executeEvent: vi.fn(),
  reconcile: vi.fn(),
  onboard: vi.fn(),
  refreshAccountState: vi.fn(),
  webhook: vi.fn(),
  assertTask: vi.fn(),
  assertWorkOrder: vi.fn(),
  assertProviderAccount: vi.fn(),
  assertWebhookBoundary: vi.fn(),
  assertHmac: vi.fn(),
  enqueueEvent: vi.fn(),
  enqueueReconciliation: vi.fn(),
  recordInbox: vi.fn(),
  materializeAccount: vi.fn(),
}));

vi.mock('../../src/services/payment/UniversalV1FinancialApplicationService.js', () => ({
  createUniversalV1FakeFinancialApplicationService: mocks.createService,
}));

vi.mock('../../src/services/payment/SyntheticFinancialCommandAuthority.js', () => {
  class SyntheticFinancialAuthorityError extends Error {}
  return {
    SyntheticFinancialAuthorityError,
    assertSyntheticFinancialWebhookHmac: mocks.assertHmac,
    syntheticFinancialCommandAuthority: {
      assertTaskParticipant: mocks.assertTask,
      assertWorkOrderParticipant: mocks.assertWorkOrder,
      assertProviderAccountAuthority: mocks.assertProviderAccount,
      assertWebhookOperationBoundary: mocks.assertWebhookBoundary,
    },
  };
});

vi.mock('../../src/jobs/synthetic-financial-worker.js', () => ({
  enqueueSyntheticFinancialEvent: mocks.enqueueEvent,
  enqueueSyntheticReconciliation: mocks.enqueueReconciliation,
}));

vi.mock('../../src/services/payment/UniversalV1FakeProviderAccountRepository.js', () => ({
  PostgresUniversalV1FakeProviderAccountRepository: class {
    materializeFromDurableEvidence(input: unknown) {
      return mocks.materializeAccount(input);
    }
  },
}));

vi.mock('../../src/services/payment/ProviderEventInbox.js', () => ({
  ProviderEventInboxError: class ProviderEventInboxError extends Error {
    constructor(readonly reason: string) {
      super(`PROVIDER_EVENT_INBOX_${reason}`);
    }
  },
  PostgresProviderEventInboxRepository: class {
    recordAuthenticatedEvent(input: unknown) {
      return mocks.recordInbox(input);
    }
  },
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
  organization: '00000000-0000-4000-8000-000000000209',
  onboardOperation: '00000000-0000-4000-8000-000000000212',
  refreshOperation: '00000000-0000-4000-8000-000000000213',
} as const;

const onboardEvidence = {
  commandId: '00000000-0000-4000-8000-000000000214',
  dispatchAttemptId: '00000000-0000-4000-8000-000000000215',
  outcomeFactId: '00000000-0000-4000-8000-000000000216',
  fakeOperationEventId: '00000000-0000-4000-8000-000000000217',
};
const refreshEvidence = {
  commandId: '00000000-0000-4000-8000-000000000218',
  dispatchAttemptId: '00000000-0000-4000-8000-000000000219',
  outcomeFactId: '00000000-0000-4000-8000-000000000220',
  fakeOperationEventId: '00000000-0000-4000-8000-000000000221',
};

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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectedNormalizationIdempotencyKey(
  providerKind: string,
  providerEventReference: string
): string {
  return `provider-event:${sha256(`${providerKind}\0${providerEventReference}`)}`;
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

const terminalOperationKinds = [
  'VOID',
  'ADJUST',
  'CAPTURE',
  'REFUND',
  'REVERSAL',
  'SETTLE',
  'FUND',
  'PROVIDER_RELEASE',
  'PAYOUT',
  'OBSERVE_BANK_SETTLEMENT',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createService.mockReturnValue({
    executeFinancialEvent: mocks.executeEvent,
    reconcile: mocks.reconcile,
    onboardProvider: mocks.onboard,
    refreshProviderAccountState: mocks.refreshAccountState,
    ingestWebhook: mocks.webhook,
  });
  mocks.executeEvent.mockResolvedValue({ operationId: ids.operation });
  mocks.reconcile.mockResolvedValue({ operationId: ids.operation });
  mocks.onboard.mockResolvedValue({
    operationId: ids.operation,
    externalReference: 'fake-provider-account-1',
    durableFakeEvidence: onboardEvidence,
  });
  mocks.refreshAccountState.mockResolvedValue({
    operationId: ids.operation,
    durableFakeEvidence: refreshEvidence,
  });
  mocks.webhook.mockResolvedValue({ operationId: ids.operation });
  mocks.enqueueEvent.mockResolvedValue({ queue: 'synthetic_finance', jobId: 'event-job' });
  mocks.enqueueReconciliation.mockResolvedValue({
    queue: 'synthetic_finance',
    jobId: 'reconciliation-job',
  });
  mocks.recordInbox.mockResolvedValue({
    observationId: '00000000-0000-4000-8000-000000000210',
    receiptId: '00000000-0000-4000-8000-000000000211',
    observationReplayed: false,
    idempotencyReplayed: false,
  });
  mocks.materializeAccount.mockResolvedValue({ providerAccountFactId: ids.related });
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

  it.each(['AUTHORIZE', 'SECURE'] as const)(
    'keeps the pre-WorkOrder %s lane participant-bound',
    async (operationKind) => {
      const command = {
        providerKind: 'FAKE' as const,
        operationKind,
        operationId: ids.operation,
        idempotencyKey: `route:${operationKind.toLowerCase()}:0001`,
        providerExpectedVersion: 0,
        lifecycleExpectedVersion: operationKind === 'AUTHORIZE' ? 1 : 2,
        taskDraftId: ids.draft,
        taskId: ids.task,
        eligibilityDecisionId: ids.eligibility,
        scopeVersionId: ids.scope,
        predecessorEventId: '00000000-0000-4000-8000-000000000209',
        relatedOperationId: ids.related,
        amountCents: 12_500,
        currency: 'usd',
        occurredAt: '2026-08-26T12:05:00.000Z',
      };

      await caller().executeEvent(command);

      expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
      expect(mocks.executeEvent).toHaveBeenCalledWith({
        ...command,
        recordedBy: ids.actor,
      });
    }
  );

  it.each(terminalOperationKinds)(
    'refuses public terminal operation %s before service, authority, or queue calls',
    async (operationKind) => {
      const command = {
        providerKind: 'FAKE' as const,
        operationKind,
        operationId: ids.operation,
        idempotencyKey: `route:terminal:${operationKind.toLowerCase()}:0001`,
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
        occurredAt: '2026-08-26T12:05:00.000Z',
      };

      await expect(caller().executeEvent(command as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(caller().enqueueEvent(command as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });

      expect(mocks.createService).not.toHaveBeenCalled();
      expect(mocks.assertTask).not.toHaveBeenCalled();
      expect(mocks.executeEvent).not.toHaveBeenCalled();
      expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    }
  );

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

  it('refuses direct and queued generic reconciliation before service, authority, or queue calls', async () => {
    await expect(caller().reconcile(reconciliation)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(caller().enqueueReconciliation(reconciliation)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.assertWorkOrder).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.enqueueReconciliation).not.toHaveBeenCalled();
  });

  it('limits provider onboarding and account refresh to self and requires signed participant-bound webhooks', async () => {
    const auxiliary = {
      providerKind: 'FAKE' as const,
      operationId: ids.operation,
      idempotencyKey: 'route:auxiliary:0001',
      providerExpectedVersion: 0,
    };
    await caller().onboardSelf(auxiliary);
    expect(mocks.onboard).toHaveBeenCalledWith({
      ...auxiliary,
      providerId: ids.actor,
      recordedBy: ids.actor,
    });

    await caller().refreshProviderAccountState({
      ...auxiliary,
      providerAccountReference: 'fake-provider-account-1',
    });
    expect(mocks.refreshAccountState).toHaveBeenCalledWith({
      ...auxiliary,
      providerAccountReference: 'fake-provider-account-1',
      providerId: ids.actor,
      recordedBy: ids.actor,
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
    expect(mocks.recordInbox).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      providerEventReference: 'synthetic-event-1',
      providerEventKind: 'financial_operation.observed',
      operationId: ids.operation,
      ingressIdempotencyKey: 'route:auxiliary:0001',
      rawPayload: Buffer.from(rawBody, 'utf8'),
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256(`HUSTLEXP_SYNTHETIC_WEBHOOK_HMAC_SHA256_V1\0${signature}`),
        verifiedAt: expect.any(String),
      },
    });
    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.assertWebhookBoundary).toHaveBeenCalledWith(ids.draft, ids.task, ids.operation);
    expect(mocks.webhook).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId: ids.operation,
      idempotencyKey: expectedNormalizationIdempotencyKey('FAKE', 'synthetic-event-1'),
      providerExpectedVersion: 0,
      providerEventReference: 'synthetic-event-1',
      scenario: 'DUPLICATE_WEBHOOK',
      authenticated: true,
    });
    expect(mocks.recordInbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertTask.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mocks.recordInbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertWebhookBoundary.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mocks.recordInbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.webhook.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('proves organization authority before establishing and materializing an account fact', async () => {
    const command = {
      providerKind: 'FAKE' as const,
      providerOrganizationId: ids.organization,
      onboardOperationId: ids.onboardOperation,
      onboardIdempotencyKey: 'route:onboard:establish:0001',
      refreshOperationId: ids.refreshOperation,
      refreshIdempotencyKey: 'route:refresh:establish:0001',
      providerExpectedVersion: 0,
      onboardScenario: 'SUCCESS' as const,
      refreshScenario: 'PROVIDER_ACCOUNT_FAILURE' as const,
    };

    await caller().establishSelfAccount(command);

    expect(mocks.assertProviderAccount).toHaveBeenCalledWith(ids.actor, ids.organization);
    expect(mocks.assertProviderAccount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onboard.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mocks.onboard).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId: ids.onboardOperation,
      idempotencyKey: command.onboardIdempotencyKey,
      providerExpectedVersion: 0,
      providerId: ids.organization,
      scenario: 'SUCCESS',
      recordedBy: ids.actor,
    });
    expect(mocks.refreshAccountState).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId: ids.refreshOperation,
      idempotencyKey: command.refreshIdempotencyKey,
      providerExpectedVersion: 0,
      providerId: ids.organization,
      providerAccountReference: 'fake-provider-account-1',
      scenario: 'PROVIDER_ACCOUNT_FAILURE',
      recordedBy: ids.actor,
    });
    expect(mocks.materializeAccount).toHaveBeenCalledWith({
      providerSubject: {
        kind: 'ORGANIZATION',
        organizationId: ids.organization,
      },
      recordedBy: ids.actor,
      onboard: onboardEvidence,
      refresh: refreshEvidence,
    });
  });

  it('refuses organization account commands before committing fake provider evidence', async () => {
    const { SyntheticFinancialAuthorityError } =
      await import('../../src/services/payment/SyntheticFinancialCommandAuthority.js');
    mocks.assertProviderAccount.mockRejectedValueOnce(
      new SyntheticFinancialAuthorityError('PROVIDER_ACCOUNT_AUTHORITY_REQUIRED')
    );

    await expect(
      caller().establishSelfAccount({
        providerKind: 'FAKE',
        providerOrganizationId: ids.organization,
        onboardOperationId: ids.onboardOperation,
        onboardIdempotencyKey: 'route:onboard:refused:0001',
        refreshOperationId: ids.refreshOperation,
        refreshIdempotencyKey: 'route:refresh:refused:0001',
        providerExpectedVersion: 0,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.onboard).not.toHaveBeenCalled();
    expect(mocks.refreshAccountState).not.toHaveBeenCalled();
    expect(mocks.materializeAccount).not.toHaveBeenCalled();
  });

  it('preserves an authenticated unmatched event before participant refusal without normalization', async () => {
    const { SyntheticFinancialAuthorityError } =
      await import('../../src/services/payment/SyntheticFinancialCommandAuthority.js');
    mocks.assertTask.mockRejectedValueOnce(
      new SyntheticFinancialAuthorityError('TASK_PARTICIPANT_OR_SYNTHETIC_BOUNDARY')
    );
    const webhook = {
      providerKind: 'FAKE',
      operationId: ids.operation,
      idempotencyKey: 'route:webhook:unmatched-0001',
      providerExpectedVersion: 0,
      taskDraftId: ids.draft,
      taskId: ids.task,
      providerEventReference: 'synthetic-event-unmatched',
      scenario: 'DUPLICATE_WEBHOOK',
    };
    const rawBody = JSON.stringify(webhook);

    await expect(
      caller().ingestWebhook({
        rawBody,
        signature: 'b'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.recordInbox).toHaveBeenCalledTimes(1);
    expect(mocks.recordInbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertTask.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mocks.assertWebhookBoundary).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });

  it('fails retryably before participant lookup when durable inbox persistence is unavailable', async () => {
    mocks.recordInbox.mockRejectedValueOnce(new Error('database detail'));
    const rawBody = JSON.stringify({
      providerKind: 'FAKE',
      operationId: ids.operation,
      idempotencyKey: 'route:webhook:unavailable-0001',
      providerExpectedVersion: 0,
      taskDraftId: ids.draft,
      taskId: ids.task,
      providerEventReference: 'synthetic-event-unavailable',
    });

    await expect(
      caller().ingestWebhook({
        rawBody,
        signature: 'c'.repeat(64),
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Synthetic webhook evidence is temporarily unavailable.',
    });
    expect(mocks.assertTask).not.toHaveBeenCalled();
    expect(mocks.assertWebhookBoundary).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
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
    expect(mocks.recordInbox).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
});
