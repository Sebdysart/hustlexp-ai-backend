import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  startUniversalV1WorkOrderCompensationPoller,
  UniversalV1WorkOrderCompensationWorker,
} from '../../src/jobs/universal-v1-work-order-compensation-worker.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import {
  deterministicUuid,
  type WorkOrderCompensationCommand,
} from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';

const ids = {
  task: '30000000-0000-4000-8000-000000000001',
  draft: '30000000-0000-4000-8000-000000000002',
  scope: '30000000-0000-4000-8000-000000000003',
  route: '30000000-0000-4000-8000-000000000004',
  provider: '30000000-0000-4000-8000-000000000005',
  poster: '30000000-0000-4000-8000-000000000006',
  predecessorEligibility: '30000000-0000-4000-8000-000000000007',
  interest: '30000000-0000-4000-8000-000000000008',
  eligibility: '30000000-0000-4000-8000-000000000009',
  hold: '30000000-0000-4000-8000-000000000010',
  estimate: '30000000-0000-4000-8000-000000000011',
  preparedEvent: '30000000-0000-4000-8000-000000000012',
  authorizedEvent: '30000000-0000-4000-8000-000000000013',
  securedEvent: '30000000-0000-4000-8000-000000000014',
  voidEvent: '30000000-0000-4000-8000-000000000015',
  compensation: '30000000-0000-4000-8000-000000000016',
};
const key = 'workorder:compensation:0001';
const hold = {
  task_id: ids.task,
  task_draft_id: ids.draft,
  scope_version_id: ids.scope,
  scope_version: 1,
  routing_decision_id: ids.route,
  provider_user_id: ids.provider,
  provider_organization_id: null,
  provider_class: 'GENERAL_SERVICE_PROVIDER' as const,
  trade_credential_id: null,
  predecessor_eligibility_id: ids.predecessorEligibility,
  predecessor_eligibility_version: 1,
  predecessor_valid_until: new Date(Date.now() + 60_000).toISOString(),
  poster_user_id: ids.poster,
  interest_application_id: ids.interest,
  eligibility_decision_id: ids.eligibility,
  eligibility_version: 2,
  eligibility_valid_until: new Date(Date.now() + 60_000).toISOString(),
  conditional_hold_id: ids.hold,
  hold_reserved_at: new Date().toISOString(),
  hold_expires_at: new Date(Date.now() + 60_000).toISOString(),
  provider_estimate_submission_id: ids.estimate,
  customer_total_cents: 12_000,
  currency: 'USD',
};
const phase = {
  completed: false as const,
  context: hold,
  idempotencyKey: key,
  requestSha256: 'a'.repeat(64),
  occurredAt: hold.hold_reserved_at,
};
const compensation: WorkOrderCompensationCommand = {
  compensation_command_id: ids.compensation,
  work_order_idempotency_key: key,
  task_draft_id: ids.draft,
  task_id: ids.task,
  scope_version_id: ids.scope,
  eligibility_decision_id: ids.eligibility,
  secured_event_id: ids.securedEvent,
  secured_operation_id: deterministicUuid(key, 'secure'),
  void_operation_id: deterministicUuid(key, 'void'),
  void_idempotency_key: `${key}:void`,
  amount_cents: 12_000,
  currency: 'USD',
  requested_by: ids.poster,
  created_at: new Date().toISOString(),
};

function successfulVoid(replayed: boolean = false) {
  return {
    id: ids.voidEvent,
    operationId: compensation.void_operation_id,
    eventKind: 'VOIDED' as const,
    status: 'SUCCEEDED' as const,
    providerKind: 'FAKE' as const,
    externalReference: 'fake_void_000000000000000000000000',
    providerOperationVersion: 1,
    lifecycleExpectedVersion: 3,
    idempotencyReplayed: replayed,
    taskDraftId: ids.draft,
    taskId: ids.task,
    eligibilityDecisionId: ids.eligibility,
    scopeVersionId: ids.scope,
    changeOrderId: null,
    predecessorEventId: ids.securedEvent,
    completionFactId: null,
    amountCents: 12_000,
    currency: 'USD',
    providerState: 'VOIDED' as const,
    recordedBy: ids.poster,
    occurredAt: new Date().toISOString(),
  };
}

function financeExecutionMock(voidReplayed: boolean = false) {
  return vi.fn()
    .mockResolvedValueOnce({
      id: ids.preparedEvent,
      operationId: deterministicUuid(key, 'prepare'),
      externalReference: 'fake_prepare',
    })
    .mockResolvedValueOnce({
      id: ids.authorizedEvent,
      operationId: deterministicUuid(key, 'authorize'),
      externalReference: 'fake_authorize',
    })
    .mockResolvedValueOnce({
      id: ids.securedEvent,
      operationId: deterministicUuid(key, 'secure'),
      externalReference: 'fake_secure',
    })
    .mockResolvedValueOnce(successfulVoid(voidReplayed));
}

describe('Universal V1 WorkOrder compensation', () => {
  it('claims and materializes one exact fake VOID when finalization fails', async () => {
    const finalizeError = Object.assign(new Error('INJECTED_FINALIZE_FAILURE'), { code: 'XX999' });
    const executeFinancialEvent = financeExecutionMock();
    const repository = {
      prepareMaterialization: vi.fn().mockResolvedValue(phase),
      finalizeMaterialization: vi.fn().mockRejectedValue(finalizeError),
      claimMaterializationCompensation: vi.fn().mockResolvedValue({
        completed: false,
        command: compensation,
      }),
    };
    const application = new UniversalV1WorkOrderApplication(
      { workOrder: vi.fn().mockResolvedValue(hold) } as never,
      repository as never,
      () => ({ executeFinancialEvent }) as never
    );

    await expect(application.secureAndMaterializeFakeWorkOrder(ids.poster, {
      conditional_hold_id: ids.hold,
      expected_eligibility_version: 2,
      idempotency_key: key,
      client_ts: new Date().toISOString(),
    })).rejects.toBe(finalizeError);

    expect(repository.claimMaterializationCompensation).toHaveBeenCalledWith(
      phase,
      ids.securedEvent,
      ids.poster
    );
    expect(executeFinancialEvent).toHaveBeenCalledTimes(4);
    expect(executeFinancialEvent.mock.calls[3]![0]).toMatchObject({
      operationKind: 'VOID',
      operationId: deterministicUuid(key, 'void'),
      idempotencyKey: `${key}:void`,
      lifecycleExpectedVersion: 3,
      predecessorEventId: ids.securedEvent,
      relatedOperationId: deterministicUuid(key, 'secure'),
      amountCents: 12_000,
      currency: 'usd',
      providerKind: 'FAKE',
      scenario: 'SUCCESS',
    });
  });

  it('returns an exact concurrent finalization winner without issuing VOID', async () => {
    const result = {
      work_order_id: '30000000-0000-4000-8000-000000000017',
      financial_security_event_id: ids.securedEvent,
      replayed: true,
      hard_assignment_created: false as const,
      payment_creation_performed: false as const,
    };
    const executeFinancialEvent = financeExecutionMock();
    const repository = {
      prepareMaterialization: vi.fn().mockResolvedValue(phase),
      finalizeMaterialization: vi.fn().mockRejectedValue(new Error('AMBIGUOUS_COMMIT')),
      claimMaterializationCompensation: vi.fn().mockResolvedValue({ completed: true, result }),
    };
    const application = new UniversalV1WorkOrderApplication(
      { workOrder: vi.fn().mockResolvedValue(hold) } as never,
      repository as never,
      () => ({ executeFinancialEvent }) as never
    );

    await expect(application.secureAndMaterializeFakeWorkOrder(ids.poster, {
      conditional_hold_id: ids.hold,
      expected_eligibility_version: 2,
      idempotency_key: key,
      client_ts: new Date().toISOString(),
    })).resolves.toEqual(result);
    expect(executeFinancialEvent).toHaveBeenCalledTimes(3);
  });

  it('drains exact claims idempotently and gates before acquiring commands', async () => {
    const executeFinancialEvent = vi.fn()
      .mockResolvedValueOnce(successfulVoid(false))
      .mockResolvedValueOnce(successfulVoid(true));
    const createFinance = vi.fn(() => ({ executeFinancialEvent }));
    const repository = { claimDue: vi.fn().mockResolvedValue([compensation]) };
    const worker = new UniversalV1WorkOrderCompensationWorker(repository, createFinance as never);

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, voided: 1, replayed: 0, failed: 0 });
    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, voided: 0, replayed: 1, failed: 0 });
    expect(createFinance.mock.invocationCallOrder[0]).toBeLessThan(
      repository.claimDue.mock.invocationCallOrder[0]!
    );
    expect(executeFinancialEvent.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        operationKind: 'VOID',
        operationId: compensation.void_operation_id,
        idempotencyKey: compensation.void_idempotency_key,
      })
    );
  });

  it('refuses poller startup before scheduling when the capability gate is closed', () => {
    const runOnce = vi.fn();
    expect(() => startUniversalV1WorkOrderCompensationPoller(500, {
      worker: { runOnce },
      assertAuthorized: () => { throw new Error('CAPABILITY_DENIED'); },
    })).toThrow('CAPABILITY_DENIED');
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('stops scheduling and drains the exact in-flight compensation batch', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: { claimed: number; voided: number; replayed: number; failed: number }) => void;
      const runOnce = vi.fn(() => new Promise<{
        claimed: number;
        voided: number;
        replayed: number;
        failed: number;
      }>((resolve) => { finish = resolve; }));
      const handle = startUniversalV1WorkOrderCompensationPoller(500, {
        worker: { runOnce },
        assertAuthorized: vi.fn(),
      }, { workerId: 'work-order-compensation:test' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runOnce).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = handle.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish({ claimed: 1, voided: 1, replayed: 0, failed: 0 });
      await stopping;
      expect(handle.health()).toMatchObject({ status: 'stopped', inFlight: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runOnce).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers migration 131 with an immutable claim and exact narrow DB guards', () => {
    const migration = readFileSync(new URL(
      '../../database/migrations/20260925_universal_v1_work_order_compensation_v1.sql',
      import.meta.url
    ), 'utf8');
    expect(REQUIRED_MIGRATION_FILES[129]).toEqual({
      name: '20260924_universal_v1_task_draft_route_context_v1',
      fileName: '20260924_universal_v1_task_draft_route_context_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[130]).toEqual({
      name: '20260925_universal_v1_work_order_compensation_v1',
      fileName: '20260925_universal_v1_work_order_compensation_v1.sql',
    });
    for (const proof of [
      'universal_v1_work_order_compensation_commands',
      'FINALIZATION_FAILED',
      'RECOVERY_TIMEOUT',
      'universal_v1_pre_work_order_void_is_authorized',
      'exact immutable compensation command',
      'compensation already won the WorkOrder resolution race',
      'claim_universal_v1_work_order_compensations',
      "task_record.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'",
      "checked_provider_kind = 'FAKE'",
      "bridge.fake_operation_kind = 'SECURE'",
      "void_event.provider_kind = 'FAKE'",
    ]) expect(migration).toContain(proof);
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).not.toMatch(/APPROVED_PROVIDER[^\n]*=|payment_intent|stripe_/iu);
  });
});
