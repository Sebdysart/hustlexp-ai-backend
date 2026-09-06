import { describe, expect, it, vi } from 'vitest';
import {
  UniversalV1ChangeOrderRecoveryWorker,
  type UniversalV1ChangeOrderRecoveryWorkerDependencies,
} from '../../src/jobs/universal-v1-change-order-recovery-worker.js';
import type { ChangeOrderRecoveryLease } from '../../src/services/UniversalV1ChangeOrderRecoveryClaims.js';
import type { UniversalV1ChangeOrderRecoveryClaim } from '../../src/services/UniversalV1ChangeOrderRecovery.js';

const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lease: ChangeOrderRecoveryLease = Object.freeze({
  proposal_id: id(1),
  recovery_lease_id: id(2),
  lease_owner_id: id(3),
  witness_request_sha256: 'a'.repeat(64),
  work_order_id: id(4),
  acquired_at: '2026-09-06T12:00:00.000Z',
  expires_at: '2026-09-06T12:01:00.000Z',
  target_authority_id: id(5),
  release_manifest_digest: 'sha256:' + 'b'.repeat(64),
});
function observation(
  state: UniversalV1ChangeOrderRecoveryClaim['observation'],
  extra: Partial<UniversalV1ChangeOrderRecoveryClaim> = {}
): UniversalV1ChangeOrderRecoveryClaim {
  return {
    proposalId: lease.proposal_id,
    recoveryLeaseId: lease.recovery_lease_id,
    leaseOwnerId: lease.lease_owner_id,
    witnessRequestSha256: lease.witness_request_sha256,
    workOrderId: lease.work_order_id,
    observation: state,
    idempotencyKey: 'recovery:sealed:01',
    actorUserId: id(6),
    taskId: id(7),
    taskDraftId: id(8),
    eligibilityDecisionId: id(9),
    baseScopeVersionId: id(10),
    replacementScopeVersionId: id(11),
    replacementScopeVersion: 2,
    expectedFinancialVersion: 2,
    predecessorEventId: id(12),
    predecessorOperationId: id(13),
    adjustmentOperationId: id(14),
    customerTotalCents: 15000,
    currency: 'USD',
    occurredAt: lease.acquired_at,
    adjustmentEventId: id(15),
    amendmentId: id(16),
    compensationEventId: id(17),
    adjustmentOutcomeFactId: null,
    authorityRevocationReason: null,
    compensationCommand: null,
    ...extra,
  };
}
function fixture(state: UniversalV1ChangeOrderRecoveryClaim['observation']) {
  const dependencies = {
    assertAuthorized: vi.fn(),
    claims: {
      claimDue: vi
        .fn<UniversalV1ChangeOrderRecoveryWorkerDependencies['claims']['claimDue']>()
        .mockResolvedValue([lease]),
    },
    observations: {
      observe: vi
        .fn<UniversalV1ChangeOrderRecoveryWorkerDependencies['observations']['observe']>()
        .mockResolvedValue(observation(state)),
    },
    adjustments: {
      requestAdjustment:
        vi.fn<
          UniversalV1ChangeOrderRecoveryWorkerDependencies['adjustments']['requestAdjustment']
        >(),
    },
    materialization: {
      materialize:
        vi.fn<UniversalV1ChangeOrderRecoveryWorkerDependencies['materialization']['materialize']>(),
    },
    compensation: {
      claim: vi.fn<UniversalV1ChangeOrderRecoveryWorkerDependencies['compensation']['claim']>(),
    },
    reversals: {
      requestReversal:
        vi.fn<UniversalV1ChangeOrderRecoveryWorkerDependencies['reversals']['requestReversal']>(),
    },
    terminals: {
      record: vi.fn<UniversalV1ChangeOrderRecoveryWorkerDependencies['terminals']['record']>(),
    },
  } satisfies UniversalV1ChangeOrderRecoveryWorkerDependencies;
  const worker = new UniversalV1ChangeOrderRecoveryWorker(dependencies, {
    leaseOwnerId: lease.lease_owner_id,
  });
  return { worker, ...dependencies };
}
describe('sealed scheduled change order recovery', () => {
  it('authorizes before claiming and rechecks each proposal before observation', async () => {
    const f = fixture('WAITING');
    f.assertAuthorized.mockImplementationOnce(() => {
      throw Error('DENIED');
    });
    await expect(f.worker.runOnce()).rejects.toThrow('DENIED');
    expect(f.claims.claimDue).not.toHaveBeenCalled();
    f.assertAuthorized
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw Error('REVOKED');
      });
    expect(await f.worker.runOnce()).toMatchObject({ claimed: 1, failed: 1 });
    expect(f.observations.observe).not.toHaveBeenCalled();
  });
  it('commits an ADJUST request with the original lease and leaves processing to the queue', async () => {
    const f = fixture('ADJUST_READY');
    expect(await f.worker.runOnce()).toMatchObject({ claimed: 1, retryLater: 1, failed: 0 });
    expect(f.adjustments.requestAdjustment).toHaveBeenCalledExactlyOnceWith(lease);
    expect(f.materialization.materialize).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
  it.each([
    'ADJUST_REPLAYABLE',
    'COMPENSATION_REPLAYABLE',
    'ADJUST_RECONCILE_ONLY',
    'COMPENSATION_RECONCILE_ONLY',
    'WAITING',
  ] as const)('does not redispatch %s', async (state) => {
    const f = fixture(state);
    expect(await f.worker.runOnce()).toMatchObject({ claimed: 1, failed: 0, materialized: 0 });
    expect(f.adjustments.requestAdjustment).not.toHaveBeenCalled();
    expect(f.reversals.requestReversal).not.toHaveBeenCalled();
    expect(f.materialization.materialize).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
  it('preserves an uncertain REQUESTED commit for a later exact retry', async () => {
    const f = fixture('ADJUST_READY');
    f.adjustments.requestAdjustment.mockRejectedValue(Error('COMMIT_ACK_LOST'));
    expect(await f.worker.runOnce()).toMatchObject({ failed: 1, materialized: 0 });
    expect(f.adjustments.requestAdjustment).toHaveBeenCalledTimes(1);
    expect(f.compensation.claim).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
  it('uses a committed amendment as the exact terminal evidence', async () => {
    const f = fixture('AMENDMENT_MATERIALIZED');
    expect(await f.worker.runOnce()).toMatchObject({ materialized: 1, failed: 0 });
    expect(f.terminals.record).toHaveBeenCalledExactlyOnceWith({
      kind: 'MATERIALIZED',
      lease,
      actorUserId: id(6),
      amendmentId: id(16),
      adjustmentEventId: id(15),
    });
  });
  it('does not compensate a transient finalization failure', async () => {
    const f = fixture('ADJUSTMENT_SUCCEEDED');
    f.materialization.materialize.mockRejectedValue(Error('LOCK_BUSY'));
    expect(await f.worker.runOnce()).toMatchObject({ failed: 1 });
    expect(f.observations.observe).toHaveBeenCalledTimes(2);
    expect(f.compensation.claim).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
  it('recovers a lost amendment acknowledgement from a fresh committed observation', async () => {
    const f = fixture('ADJUSTMENT_SUCCEEDED');
    f.materialization.materialize.mockRejectedValue(Error('COMMIT_ACK_LOST'));
    f.observations.observe
      .mockResolvedValueOnce(observation('ADJUSTMENT_SUCCEEDED'))
      .mockResolvedValueOnce(observation('AMENDMENT_MATERIALIZED'));
    expect(await f.worker.runOnce()).toMatchObject({ materialized: 1, failed: 0 });
    expect(f.terminals.record).toHaveBeenCalledTimes(1);
    expect(f.compensation.claim).not.toHaveBeenCalled();
  });
  it('requires a database compensation winner after a fresh permanent revocation', async () => {
    const f = fixture('ADJUSTMENT_SUCCEEDED');
    f.materialization.materialize.mockRejectedValue(Error('AUTHORITY_CHANGED'));
    f.observations.observe
      .mockResolvedValueOnce(observation('ADJUSTMENT_SUCCEEDED'))
      .mockResolvedValueOnce(
        observation('ADJUSTMENT_SUCCEEDED', {
          authorityRevocationReason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
        })
      );
    f.compensation.claim.mockResolvedValue(null);
    expect(await f.worker.runOnce()).toMatchObject({ retryLater: 1, failed: 0 });
    expect(f.compensation.claim).toHaveBeenCalledExactlyOnceWith(lease, id(15));
    expect(f.reversals.requestReversal).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
  it('leaves expired or completed leases without writes', async () => {
    const f = fixture('WAITING');
    f.observations.observe.mockResolvedValue(null);
    expect(await f.worker.runOnce()).toMatchObject({ retryLater: 1, failed: 0 });
    expect(f.adjustments.requestAdjustment).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
  it('rejects a mismatched observation and continues the rest of a batch', async () => {
    const f = fixture('WAITING');
    f.claims.claimDue.mockResolvedValue([lease, lease]);
    f.observations.observe.mockResolvedValueOnce(
      observation('ADJUST_READY', { proposalId: id(99) })
    );
    expect(await f.worker.runOnce()).toMatchObject({ claimed: 2, failed: 1, retryLater: 1 });
    expect(f.adjustments.requestAdjustment).not.toHaveBeenCalled();
  });
  it('terminalizes the amendment returned by the materialization command', async () => {
    const f = fixture('ADJUSTMENT_SUCCEEDED');
    f.materialization.materialize.mockResolvedValue({ result: { amendment_id: id(90) } } as never);
    expect(await f.worker.runOnce()).toMatchObject({ materialized: 1, failed: 0 });
    expect(f.materialization.materialize).toHaveBeenCalledExactlyOnceWith({
      lease,
      adjustmentEventId: id(15),
      actorUserId: id(6),
      replacementScopeVersionId: id(11),
      replacementScopeVersion: 2,
    });
    expect(f.terminals.record).toHaveBeenCalledExactlyOnceWith({
      kind: 'MATERIALIZED',
      lease,
      actorUserId: id(6),
      amendmentId: id(90),
      adjustmentEventId: id(15),
    });
  });
  it.each([true, false])(
    'preserves the exact compensation winner with worker origin present=%s',
    async (hasOrigin) => {
      const f = fixture('COMPENSATION_READY');
      const winner = {
        resolution: { kind: 'COMPENSATE', command: { compensationCommandId: id(20) } },
        workerOrigin: hasOrigin ? { compensation_command_id: id(20) } : null,
        created: false,
        observedAt: lease.acquired_at,
      };
      f.compensation.claim.mockResolvedValue(winner as never);
      expect(await f.worker.runOnce()).toMatchObject(
        hasOrigin ? { retryLater: 1, failed: 0 } : { recoveryRequired: 1, failed: 0 }
      );
      if (hasOrigin) expect(f.reversals.requestReversal).toHaveBeenCalledExactlyOnceWith(winner);
      else expect(f.reversals.requestReversal).not.toHaveBeenCalled();
      expect(f.terminals.record).not.toHaveBeenCalled();
    }
  );
  it('records an existing reversal with cancellation authority only after terminal commit', async () => {
    const f = fixture('COMPENSATION_SUCCEEDED');
    f.observations.observe.mockResolvedValue(
      observation('COMPENSATION_SUCCEEDED', {
        compensationCommand: { compensationCommandId: id(20) } as never,
      })
    );
    f.terminals.record.mockRejectedValueOnce(Error('COMMIT_ACK_LOST'));
    expect(await f.worker.runOnce()).toMatchObject({ cancelledRecoveryRequired: 0, failed: 1 });
    expect(await f.worker.runOnce()).toMatchObject({ cancelledRecoveryRequired: 1, failed: 0 });
    expect(f.terminals.record).toHaveBeenLastCalledWith({
      kind: 'COMPENSATED',
      lease,
      actorUserId: id(6),
      adjustmentEventId: id(15),
      compensationCommandId: id(20),
      compensationEventId: id(17),
    });
    expect(f.reversals.requestReversal).not.toHaveBeenCalled();
  });
  it.each(['ADJUST_TERMINAL_NO_EFFECT', 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED'] as const)(
    'records exact no-effect evidence for %s without requesting money',
    async (state) => {
      const f = fixture(state);
      f.observations.observe.mockResolvedValue(
        observation(state, {
          adjustmentEventId: null,
          adjustmentOutcomeFactId: state === 'ADJUST_TERMINAL_NO_EFFECT' ? id(30) : null,
          authorityRevocationReason:
            state === 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED' ? 'TASK_AUTHORITY_REVOKED' : null,
        })
      );
      expect(await f.worker.runOnce()).toMatchObject({ cancelledRecoveryRequired: 1, failed: 0 });
      expect(f.terminals.record).toHaveBeenCalledExactlyOnceWith({
        kind: 'NO_EFFECT',
        lease,
        actorUserId: id(6),
        adjustmentEventId: null,
        noEffectOutcomeFactId: state === 'ADJUST_TERMINAL_NO_EFFECT' ? id(30) : null,
        authorityRevocationReason:
          state === 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED' ? 'TASK_AUTHORITY_REVOKED' : null,
      });
      expect(f.adjustments.requestAdjustment).not.toHaveBeenCalled();
      expect(f.reversals.requestReversal).not.toHaveBeenCalled();
    }
  );
  it('does not classify an uncertain financial chain as permanent revocation', async () => {
    const f = fixture('ADJUSTMENT_SUCCEEDED');
    f.materialization.materialize.mockRejectedValue(Error('CHAIN_CHANGED'));
    f.observations.observe.mockResolvedValue(
      observation('ADJUSTMENT_SUCCEEDED', { authorityRevocationReason: 'FINANCIAL_CHAIN_CHANGED' })
    );
    expect(await f.worker.runOnce()).toMatchObject({ failed: 1, recoveryRequired: 0 });
    expect(f.compensation.claim).not.toHaveBeenCalled();
    expect(f.terminals.record).not.toHaveBeenCalled();
  });
});
