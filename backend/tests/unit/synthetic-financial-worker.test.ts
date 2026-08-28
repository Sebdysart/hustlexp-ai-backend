import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

import {
  enqueueSyntheticFinancialEvent,
  enqueueSyntheticReconciliation,
  processSyntheticFinancialJob,
} from '../../src/jobs/synthetic-financial-worker.js';

const ids = {
  actor: '00000000-0000-4000-8000-000000000301',
  draft: '00000000-0000-4000-8000-000000000302',
  task: '00000000-0000-4000-8000-000000000303',
  eligibility: '00000000-0000-4000-8000-000000000304',
  scope: '00000000-0000-4000-8000-000000000305',
  operation: '00000000-0000-4000-8000-000000000306',
  workOrder: '00000000-0000-4000-8000-000000000307',
  related: '00000000-0000-4000-8000-000000000308',
} as const;

const eventCommand = {
  providerKind: 'FAKE' as const,
  operationKind: 'PREPARE_PAYMENT_METHOD' as const,
  operationId: ids.operation,
  idempotencyKey: 'worker:prepare:0001',
  providerExpectedVersion: 0,
  lifecycleExpectedVersion: 0,
  taskDraftId: ids.draft,
  taskId: ids.task,
  eligibilityDecisionId: ids.eligibility,
  scopeVersionId: ids.scope,
  occurredAt: '2026-08-26T12:00:00.000Z',
  customerId: 'synthetic-customer',
};

const bankSettlementCommand = {
  providerKind: 'FAKE' as const,
  operationKind: 'OBSERVE_BANK_SETTLEMENT' as const,
  operationId: ids.operation,
  idempotencyKey: 'worker:bank-settlement:0001',
  providerExpectedVersion: 0,
  lifecycleExpectedVersion: 8,
  taskDraftId: ids.draft,
  taskId: ids.task,
  eligibilityDecisionId: ids.eligibility,
  scopeVersionId: ids.scope,
  predecessorEventId: '00000000-0000-4000-8000-000000000309',
  relatedOperationId: ids.related,
  amountCents: 10_000,
  currency: 'usd',
  occurredAt: '2026-08-26T12:08:00.000Z',
};

const reconciliationCommand = {
  providerKind: 'FAKE' as const,
  operationId: ids.operation,
  idempotencyKey: 'worker:reconcile:0001',
  providerExpectedVersion: 0,
  relatedOperationId: ids.related,
  scenario: 'RECONCILIATION_MISMATCH' as const,
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

const mocks = {
  executeEvent: vi.fn(),
  reconcile: vi.fn(),
  assertTask: vi.fn(),
  assertWorkOrder: vi.fn(),
  createService: vi.fn(),
  verify: vi.fn(),
};

function dependencies() {
  mocks.createService.mockReturnValue({
    executeFinancialEvent: mocks.executeEvent,
    reconcile: mocks.reconcile,
  });
  return {
    authority: {
      assertTaskParticipant: mocks.assertTask,
      assertWorkOrderParticipant: mocks.assertWorkOrder,
    },
    createService: mocks.createService,
    verifySignature: mocks.verify,
  } as never;
}

function job(kind: 'FINANCIAL_EVENT' | 'RECONCILIATION', name?: string): Job {
  const command = kind === 'FINANCIAL_EVENT' ? eventCommand : reconciliationCommand;
  return {
    name:
      name ??
      (kind === 'FINANCIAL_EVENT' ? 'synthetic_finance.event' : 'synthetic_finance.reconciliation'),
    data: {
      payload: { version: 1, kind, actorId: ids.actor, command },
      _sig: 'valid-signature',
    },
  } as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.executeEvent.mockResolvedValue({ operationId: ids.operation });
  mocks.reconcile.mockResolvedValue({ operationId: ids.operation });
});

describe('synthetic financial worker', () => {
  it('rejects unsigned work before manifest service construction or database authority', async () => {
    mocks.verify.mockReturnValue(false);
    await expect(
      processSyntheticFinancialJob(job('FINANCIAL_EVENT'), dependencies())
    ).rejects.toThrow('SYNTHETIC_FINANCIAL_JOB_SIGNATURE_INVALID');
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.assertTask).not.toHaveBeenCalled();
  });

  it('refuses a signed payload placed under a different job name', async () => {
    await expect(
      processSyntheticFinancialJob(
        job('FINANCIAL_EVENT', 'synthetic_finance.reconciliation'),
        dependencies()
      )
    ).rejects.toThrow('SYNTHETIC_FINANCIAL_JOB_KIND_MISMATCH');
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('revalidates the runtime gate, participant authority, and authenticated actor for events', async () => {
    await processSyntheticFinancialJob(job('FINANCIAL_EVENT'), dependencies());
    expect(mocks.createService).toHaveBeenCalledOnce();
    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.executeEvent).toHaveBeenCalledWith({ ...eventCommand, recordedBy: ids.actor });
  });

  it('parses and revalidates a signed bank-settlement observation without changing its semantics', async () => {
    const bankJob = {
      name: 'synthetic_finance.event',
      data: {
        payload: {
          version: 1,
          kind: 'FINANCIAL_EVENT',
          actorId: ids.actor,
          command: bankSettlementCommand,
        },
        _sig: 'valid-signature',
      },
    } as Job;

    await processSyntheticFinancialJob(bankJob, dependencies());
    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.executeEvent).toHaveBeenCalledWith({
      ...bankSettlementCommand,
      recordedBy: ids.actor,
    });
  });

  it('revalidates Work Order authority and records the actor in reconciliation', async () => {
    await processSyntheticFinancialJob(job('RECONCILIATION'), dependencies());
    expect(mocks.assertWorkOrder).toHaveBeenCalledWith(ids.actor, ids.workOrder);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      ...reconciliationCommand,
      snapshot: { ...reconciliationCommand.snapshot, recordedBy: ids.actor },
    });
  });

  it('authorizes and signs deterministic event and reconciliation queue jobs', async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce({ id: 'event-job' })
      .mockResolvedValueOnce({ id: 'reconciliation-job' });
    const enqueueDependencies = {
      authority: {
        assertTaskParticipant: mocks.assertTask,
        assertWorkOrderParticipant: mocks.assertWorkOrder,
      },
      assertAuthorized: vi.fn(),
      sign: vi.fn(() => 'signed'),
      enqueue,
    } as never;

    await expect(
      enqueueSyntheticFinancialEvent(ids.actor, eventCommand, enqueueDependencies)
    ).resolves.toEqual({ queue: 'synthetic_finance', jobId: 'event-job' });
    await expect(
      enqueueSyntheticReconciliation(ids.actor, reconciliationCommand, enqueueDependencies)
    ).resolves.toEqual({ queue: 'synthetic_finance', jobId: 'reconciliation-job' });

    expect(enqueueDependencies.assertAuthorized).toHaveBeenCalledTimes(2);
    expect(mocks.assertTask).toHaveBeenCalledWith(ids.actor, ids.draft, ids.task);
    expect(mocks.assertWorkOrder).toHaveBeenCalledWith(ids.actor, ids.workOrder);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      'synthetic_finance',
      'synthetic_finance.event',
      expect.objectContaining({ _sig: 'signed' }),
      expect.objectContaining({ jobId: expect.stringContaining(ids.operation) })
    );
  });
});
