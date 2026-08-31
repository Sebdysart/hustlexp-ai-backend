import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';
import {
  startUniversalV1ChangeOrderRecoveryPoller,
  UniversalV1ChangeOrderRecoveryWorker,
} from '../../src/jobs/universal-v1-change-order-recovery-worker.js';
import { UniversalV1ChangeOrderError } from '../../src/services/UniversalV1ChangeOrderContracts.js';
import {
  UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION,
  UniversalV1ChangeOrderRecoveryService,
  type UniversalV1ChangeOrderCompensationCommand,
  type UniversalV1ChangeOrderRecoveryClaim,
} from '../../src/services/UniversalV1ChangeOrderRecovery.js';

const ids = {
  proposal: '70000000-0000-4000-8000-000000000001',
  lease: '70000000-0000-4000-8000-000000000002',
  owner: '70000000-0000-4000-8000-000000000003',
  actor: '70000000-0000-4000-8000-000000000004',
  workOrder: '70000000-0000-4000-8000-000000000005',
  task: '70000000-0000-4000-8000-000000000006',
  draft: '70000000-0000-4000-8000-000000000007',
  eligibility: '70000000-0000-4000-8000-000000000008',
  baseScope: '70000000-0000-4000-8000-000000000009',
  replacementScope: '70000000-0000-4000-8000-000000000010',
  predecessorEvent: '70000000-0000-4000-8000-000000000011',
  predecessorOperation: '70000000-0000-4000-8000-000000000012',
  adjustmentOperation: '70000000-0000-4000-8000-000000000013',
  adjustmentEvent: '70000000-0000-4000-8000-000000000014',
  amendment: '70000000-0000-4000-8000-000000000015',
  compensationCommand: '70000000-0000-4000-8000-000000000016',
  reversalOperation: '70000000-0000-4000-8000-000000000017',
  reversalEvent: '70000000-0000-4000-8000-000000000018',
  outcome: '70000000-0000-4000-8000-000000000019',
};

const compensationCommand: UniversalV1ChangeOrderCompensationCommand = {
  compensationCommandId: ids.compensationCommand,
  proposalId: ids.proposal,
  witnessRequestSha256: 'a'.repeat(64),
  taskDraftId: ids.draft,
  taskId: ids.task,
  eligibilityDecisionId: ids.eligibility,
  baseScopeVersionId: ids.baseScope,
  adjustmentEventId: ids.adjustmentEvent,
  adjustmentOperationId: ids.adjustmentOperation,
  reversalOperationId: ids.reversalOperation,
  reversalIdempotencyKey: 'change:recovery:0001:reversal',
  lifecycleExpectedVersion: 4,
  amountCents: 15_000,
  currency: 'USD',
  requestedBy: ids.actor,
  createdAt: '2026-08-30T12:00:00.000Z',
  semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
};

function claim(
  observation: UniversalV1ChangeOrderRecoveryClaim['observation'],
  overrides: Partial<UniversalV1ChangeOrderRecoveryClaim> = {}
): UniversalV1ChangeOrderRecoveryClaim {
  return {
    proposalId: ids.proposal,
    recoveryLeaseId: ids.lease,
    leaseOwnerId: ids.owner,
    observation,
    idempotencyKey: 'change:recovery:0001',
    witnessRequestSha256: 'a'.repeat(64),
    actorUserId: ids.actor,
    workOrderId: ids.workOrder,
    taskId: ids.task,
    taskDraftId: ids.draft,
    eligibilityDecisionId: ids.eligibility,
    baseScopeVersionId: ids.baseScope,
    replacementScopeVersionId: ids.replacementScope,
    replacementScopeVersion: 2,
    expectedFinancialVersion: 2,
    predecessorEventId: ids.predecessorEvent,
    predecessorOperationId: ids.predecessorOperation,
    adjustmentOperationId: ids.adjustmentOperation,
    customerTotalCents: 15_000,
    currency: 'USD',
    occurredAt: '2026-08-30T12:00:00.000Z',
    adjustmentEventId: null,
    amendmentId: null,
    compensationEventId: null,
    adjustmentOutcomeFactId: null,
    authorityRevocationReason: null,
    compensationCommand: null,
    ...overrides,
  };
}

function adjustmentEvent() {
  return {
    id: ids.adjustmentEvent,
    operationId: ids.adjustmentOperation,
    eventKind: 'ADJUSTMENT_AUTHORIZED' as const,
    status: 'SUCCEEDED' as const,
    providerKind: 'FAKE' as const,
    externalReference: 'fake_adjust_0001',
    providerOperationVersion: 1,
    lifecycleExpectedVersion: 3,
    idempotencyReplayed: false,
    taskDraftId: ids.draft,
    taskId: ids.task,
    eligibilityDecisionId: ids.eligibility,
    scopeVersionId: ids.replacementScope,
    changeOrderId: ids.proposal,
    predecessorEventId: ids.predecessorEvent,
    completionFactId: null,
    amountCents: 15_000,
    currency: 'USD',
    providerState: 'SUCCEEDED' as const,
    recordedBy: ids.actor,
    occurredAt: '2026-08-30T12:00:01.000Z',
  };
}

function reversalEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.reversalEvent,
    operationId: ids.reversalOperation,
    eventKind: 'REVERSED' as const,
    status: 'SUCCEEDED' as const,
    providerKind: 'FAKE' as const,
    externalReference: 'fake_reversal_0001',
    providerOperationVersion: 1,
    lifecycleExpectedVersion: 4,
    idempotencyReplayed: false,
    taskDraftId: ids.draft,
    taskId: ids.task,
    eligibilityDecisionId: ids.eligibility,
    scopeVersionId: ids.baseScope,
    changeOrderId: null,
    predecessorEventId: ids.adjustmentEvent,
    completionFactId: null,
    amountCents: 15_000,
    currency: 'USD',
    providerState: 'REVERSED' as const,
    recordedBy: ids.actor,
    occurredAt: '2026-08-30T12:00:02.000Z',
    ...overrides,
  };
}

function repository() {
  return {
    claimDue: vi.fn().mockResolvedValue([]),
    recordMaterialized: vi.fn().mockResolvedValue(undefined),
    claimCompensation: vi.fn(),
    recordCompensated: vi.fn().mockResolvedValue(undefined),
    recordNoEffect: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Universal V1 change-order recovery', () => {
  it('issues the witness-exact fake ADJUST and records the exact amendment', async () => {
    const repo = repository();
    const finalizePriceAndScopeMaterialization = vi.fn().mockResolvedValue({
      amendment_id: ids.amendment,
      amendment_version: 1,
      proposal_id: ids.proposal,
      scope_version_id: ids.replacementScope,
      scope_version: 2,
      adjustment_event_id: ids.adjustmentEvent,
      provider_kind: 'FAKE',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    const executeFinancialEvent = vi.fn().mockResolvedValue(adjustmentEvent());
    const service = new UniversalV1ChangeOrderRecoveryService(
      repo as never,
      { finalizePriceAndScopeMaterialization } as never
    );

    await expect(
      service.recover(claim('ADJUST_READY'), { executeFinancialEvent } as never)
    ).resolves.toEqual({
      status: 'MATERIALIZED',
      terminal: true,
      holdsMayClear: true,
      allowedNextCommands: 'ORDINARY_AMENDMENT_FLOW',
      amendmentId: ids.amendment,
    });
    expect(executeFinancialEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: 'ADJUST',
        operationId: ids.adjustmentOperation,
        lifecycleExpectedVersion: 3,
        predecessorEventId: ids.predecessorEvent,
        relatedOperationId: ids.predecessorOperation,
        changeOrderId: ids.proposal,
        providerKind: 'FAKE',
      })
    );
    expect(repo.recordMaterialized).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: ids.proposal }),
      ids.amendment,
      ids.adjustmentEvent
    );
  });

  it('never blindly redispatches an UNKNOWN adjustment or compensation', async () => {
    const repo = repository();
    const finalizer = { finalizePriceAndScopeMaterialization: vi.fn() };
    const executeFinancialEvent = vi.fn();
    const service = new UniversalV1ChangeOrderRecoveryService(repo as never, finalizer as never);

    for (const observation of [
      'ADJUST_RECONCILE_ONLY',
      'COMPENSATION_RECONCILE_ONLY',
    ] as const) {
      await expect(
        service.recover(claim(observation), { executeFinancialEvent } as never)
      ).resolves.toEqual({
        status: 'RECONCILE_ONLY',
        terminal: false,
        holdsMayClear: false,
        allowedNextCommands: 'NONE',
      });
    }
    expect(executeFinancialEvent).not.toHaveBeenCalled();
    expect(finalizer.finalizePriceAndScopeMaterialization).not.toHaveBeenCalled();
  });

  it('uses one exact fake REVERSAL after permanent Phase-C revocation and never claims restore', async () => {
    const repo = repository();
    repo.claimCompensation.mockResolvedValue({
      kind: 'COMPENSATE',
      command: compensationCommand,
    });
    const finalizer = {
      finalizePriceAndScopeMaterialization: vi.fn().mockRejectedValue(
        new UniversalV1ChangeOrderError(
          'CHANGE_ORDER_AUTHORITY_REVOKED',
          'current authority was revoked'
        )
      ),
    };
    const executeFinancialEvent = vi.fn().mockResolvedValue(reversalEvent());
    const service = new UniversalV1ChangeOrderRecoveryService(repo as never, finalizer as never);
    const recoveryClaim = claim('ADJUSTMENT_SUCCEEDED', {
      adjustmentEventId: ids.adjustmentEvent,
    });

    await expect(
      service.recover(recoveryClaim, { executeFinancialEvent } as never)
    ).resolves.toEqual({
      status: 'CANCELLED_RECOVERY_REQUIRED',
      terminal: true,
      holdsMayClear: true,
      allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
      terminalEvidence: 'REVERSAL',
      compensationEventId: ids.reversalEvent,
    });
    expect(executeFinancialEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: 'REVERSAL',
        operationId: ids.reversalOperation,
        predecessorEventId: ids.adjustmentEvent,
        relatedOperationId: ids.adjustmentOperation,
        providerKind: 'FAKE',
      })
    );
    expect(executeFinancialEvent.mock.calls[0]![0]).not.toHaveProperty('changeOrderId');
    expect(repo.recordCompensated).toHaveBeenCalledWith(
      recoveryClaim,
      compensationCommand,
      ids.reversalEvent
    );
    expect(UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION).toEqual(
      expect.objectContaining({
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
        captureMayResumeAfterCompensation: false,
      })
    );
  });

  it.each([
    [
      'ADJUST_TERMINAL_NO_EFFECT',
      { adjustmentOutcomeFactId: ids.outcome, authorityRevocationReason: null },
    ],
    [
      'ADJUST_NO_EFFECT_AUTHORITY_REVOKED',
      {
        adjustmentOutcomeFactId: null,
        authorityRevocationReason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
      },
    ],
  ] as const)(
    'records %s as terminal NO_EFFECT without provider value I/O',
    async (observation, evidence) => {
      const repo = repository();
      const executeFinancialEvent = vi.fn();
      const service = new UniversalV1ChangeOrderRecoveryService(repo as never, {
        finalizePriceAndScopeMaterialization: vi.fn(),
      } as never);
      const recoveryClaim = claim(observation, evidence);

      await expect(
        service.recover(recoveryClaim, { executeFinancialEvent } as never)
      ).resolves.toEqual({
        status: 'CANCELLED_RECOVERY_REQUIRED',
        terminal: true,
        holdsMayClear: true,
        allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
        terminalEvidence: 'NO_EFFECT',
        compensationEventId: null,
      });
      expect(repo.recordNoEffect).toHaveBeenCalledWith(recoveryClaim);
      expect(executeFinancialEvent).not.toHaveBeenCalled();
    }
  );

  it('fails closed when a purported REVERSAL drifts from its immutable command', async () => {
    const repo = repository();
    const executeFinancialEvent = vi.fn().mockResolvedValue(
      reversalEvent({ scopeVersionId: ids.replacementScope })
    );
    const service = new UniversalV1ChangeOrderRecoveryService(repo as never, {
      finalizePriceAndScopeMaterialization: vi.fn(),
    } as never);

    await expect(
      service.recover(
        claim('COMPENSATION_READY', { compensationCommand }),
        { executeFinancialEvent } as never
      )
    ).rejects.toThrow('CHANGE_ORDER_RECOVERY_COMPENSATION_IDENTITY_MISMATCH');
    expect(repo.recordCompensated).not.toHaveBeenCalled();
  });

  it('gates before lease acquisition and reports deterministic worker outcomes', async () => {
    const repo = repository();
    const createFinance = vi.fn(() => {
      throw new Error('CAPABILITY_DENIED');
    });
    const worker = new UniversalV1ChangeOrderRecoveryWorker(
      repo as never,
      { recover: vi.fn() } as never,
      createFinance as never,
      { leaseOwnerId: ids.owner }
    );
    await expect(worker.runOnce()).rejects.toThrow('CAPABILITY_DENIED');
    expect(repo.claimDue).not.toHaveBeenCalled();
  });

  it('refuses unauthorized poller startup and drains an exact in-flight batch', async () => {
    const deniedRun = vi.fn();
    expect(() =>
      startUniversalV1ChangeOrderRecoveryPoller(500, {
        worker: { runOnce: deniedRun },
        assertAuthorized: () => {
          throw new Error('CAPABILITY_DENIED');
        },
      })
    ).toThrow('CAPABILITY_DENIED');
    expect(deniedRun).not.toHaveBeenCalled();

    vi.useFakeTimers();
    let finish!: (value: {
      claimed: number;
      materialized: number;
      cancelledRecoveryRequired: number;
      reconcileOnly: number;
      recoveryRequired: number;
      retryLater: number;
      failed: number;
    }) => void;
    const runOnce = vi.fn(
      () =>
        new Promise<Parameters<typeof finish>[0]>((resolve) => {
          finish = resolve;
        })
    );
    const handle = startUniversalV1ChangeOrderRecoveryPoller(
      500,
      { worker: { runOnce }, assertAuthorized: vi.fn() },
      { workerId: 'change-order-recovery:test' }
    );
    await vi.advanceTimersByTimeAsync(0);
    const stopping = handle.stop();
    expect(handle.health()).toMatchObject({
      status: 'stopped',
      inFlight: true,
      drained: false,
      priorSecuredStateRestored: false,
      executionMayResumeAfterCompensation: false,
    });
    finish({
      claimed: 1,
      materialized: 0,
      cancelledRecoveryRequired: 1,
      reconcileOnly: 0,
      recoveryRequired: 0,
      retryLater: 0,
      failed: 0,
    });
    await stopping;
    expect(handle.health()).toMatchObject({ status: 'stopped', inFlight: false, drained: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('seals mutation paths and both financial-slot race directions in migration 133', () => {
    const migrationPath = resolve(
      process.cwd(),
      'backend/database/migrations/20260927_universal_v1_change_order_recovery_v1.sql'
    );
    const migration = readFileSync(migrationPath, 'utf8');

    for (const proof of [
      'SECURITY DEFINER',
      'SET search_path = pg_catalog, public',
      'hxos_fake_financial_schema_evidence_v6',
      'hxos_fake_financial_schema_evidence_v7',
      'hxos_fake_financial_schema_evidence_append_only_v7',
      'record_universal_v1_change_order_no_effect_recovery_v1',
      'JOIN public.users approval_actor ON approval_actor.id = approval.actor_id',
      "approval_actor.account_status = 'ACTIVE'",
      'approval_actor.is_minor IS FALSE',
      'COALESCE(approval_actor.is_banned, FALSE) IS FALSE',
      'CANCELLED_RECOVERY_REQUIRED',
      'PRIOR_SECURED_STATE_NOT_RESTORED',
      "resolution_evidence_kind IN ('AMENDMENT', 'REVERSAL', 'NO_EFFECT')",
      "fake_operation_kind = 'REVERSAL'",
      'compensation.work_order_id = NEW.work_order_id',
      'a0_universal_v1_change_order_financial_slot_lock',
      'work_order.task_draft_id = NEW.task_draft_id',
      'prepared command task binding conflicts with immutable draft WorkOrder',
      'NEW.work_order_id IS DISTINCT FROM checked_work_order_id',
      'prepared command supplied a WorkOrder not bound to its immutable draft',
      'zz_universal_v1_change_order_phase_a_financial_slot_guard',
      'financial lifecycle slot was prepared before Phase A',
      'unresolved change-order witness owns the exact financial lifecycle slot',
      'universal_v1_change_order_compensating_reversal_is_exact_v1',
      "checked_event.event_kind = 'REVERSED'",
      "checked_predecessor.event_kind = 'ADJUSTMENT_AUTHORIZED'",
      'prepared.scope_version_id = compensation.base_scope_version_id',
      'checked_predecessor.scope_version_id = witness.replacement_scope_version_id',
      'inherited FIN-12 predicate is not exact',
      "IN ('AMENDMENT_CHAIN_CHANGED', 'FINANCIAL_CHAIN_CHANGED')",
      'WORK_ORDER_TERMINALIZED',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'FROM PUBLIC',
    ]) {
      expect(migration).toContain(proof);
    }
    expect(migration.match(/SECURITY DEFINER/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT\s*,\s*)?INSERT\s+ON\s+TABLE/iu);
    expect(migration).not.toMatch(/\bTO\s+CURRENT_USER\b/iu);
    expect(migration).not.toContain('acquired_at::TEXT');
    expect(migration).not.toMatch(/APPROVED_PROVIDER|stripe_|payment_intent/iu);
    expect(
      analyzeMigrationFile(migrationPath, migration).filter(
        (issue) => issue.severity === 'BLOCKER'
      )
    ).toEqual([]);
  });
});
