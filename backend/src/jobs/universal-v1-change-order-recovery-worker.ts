import { randomUUID } from 'node:crypto';
import {
  UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION,
  type UniversalV1ChangeOrderRecoveryClaim,
} from '../services/UniversalV1ChangeOrderRecovery.js';
import {
  PostgresUniversalV1ChangeOrderRecoveryClaims,
  type ChangeOrderRecoveryLease,
} from '../services/UniversalV1ChangeOrderRecoveryClaims.js';
import { PostgresUniversalV1ChangeOrderRecoveryObservation } from '../services/UniversalV1ChangeOrderRecoveryObservation.js';
import { PostgresUniversalV1ChangeOrderRecoveryCompensation } from '../services/UniversalV1ChangeOrderRecoveryCompensation.js';
import {
  PostgresUniversalV1ChangeOrderRecoveryTerminals,
  type ChangeOrderTerminalCommand,
} from '../services/UniversalV1ChangeOrderRecoveryTerminals.js';
import { PostgresUniversalV1WorkerChangeOrderMaterialization } from '../services/UniversalV1WorkerChangeOrderMaterialization.js';
import { PostgresUniversalV1WorkerChangeOrderAdjustments } from '../services/payment/UniversalV1WorkerChangeOrderAdjustment.js';
import {
  PostgresUniversalV1ChangeOrderReversalRequests,
  authorizedChangeOrderReversalRequests,
} from '../services/payment/UniversalV1ChangeOrderReversalRequest.js';

export interface UniversalV1ChangeOrderRecoveryRunResult {
  readonly claimed: number;
  readonly materialized: number;
  readonly cancelledRecoveryRequired: number;
  readonly reconcileOnly: number;
  readonly recoveryRequired: number;
  readonly retryLater: number;
  readonly failed: number;
}
export interface UniversalV1ChangeOrderRecoveryWorkerOptions {
  readonly leaseOwnerId?: string;
  readonly leaseDurationSeconds?: number;
  readonly minimumAgeSeconds?: number;
}
export interface UniversalV1ChangeOrderRecoveryWorkerDependencies {
  readonly assertAuthorized: () => void;
  readonly claims: Pick<PostgresUniversalV1ChangeOrderRecoveryClaims, 'claimDue'>;
  readonly observations: Pick<PostgresUniversalV1ChangeOrderRecoveryObservation, 'observe'>;
  readonly adjustments: Pick<PostgresUniversalV1WorkerChangeOrderAdjustments, 'requestAdjustment'>;
  readonly materialization: Pick<
    PostgresUniversalV1WorkerChangeOrderMaterialization,
    'materialize'
  >;
  readonly compensation: Pick<PostgresUniversalV1ChangeOrderRecoveryCompensation, 'claim'>;
  readonly reversals: Pick<PostgresUniversalV1ChangeOrderReversalRequests, 'requestReversal'>;
  readonly terminals: Pick<PostgresUniversalV1ChangeOrderRecoveryTerminals, 'record'>;
}
function installedDependencies(): UniversalV1ChangeOrderRecoveryWorkerDependencies {
  return {
    assertAuthorized: () => {
      authorizedChangeOrderReversalRequests();
    },
    claims: new PostgresUniversalV1ChangeOrderRecoveryClaims(),
    observations: new PostgresUniversalV1ChangeOrderRecoveryObservation(),
    adjustments: new PostgresUniversalV1WorkerChangeOrderAdjustments(),
    materialization: new PostgresUniversalV1WorkerChangeOrderMaterialization(),
    compensation: new PostgresUniversalV1ChangeOrderRecoveryCompensation(),
    reversals: new PostgresUniversalV1ChangeOrderReversalRequests(),
    terminals: new PostgresUniversalV1ChangeOrderRecoveryTerminals(),
  };
}
type Outcome = Exclude<keyof UniversalV1ChangeOrderRecoveryRunResult, 'claimed' | 'failed'>;
type Revocation = NonNullable<
  Extract<ChangeOrderTerminalCommand, { kind: 'NO_EFFECT' }>['authorityRevocationReason']
>;
function permanentRevocation(reason: string | null): Revocation | null {
  switch (reason) {
    case 'PROPOSAL_NOT_APPROVED':
    case 'TASK_AUTHORITY_REVOKED':
    case 'CUSTOMER_ACTOR_AUTHORITY_REVOKED':
    case 'CUSTOMER_APPROVAL_AUTHORITY_REVOKED':
    case 'PROVIDER_ACTOR_AUTHORITY_REVOKED':
    case 'PROVIDER_APPROVAL_AUTHORITY_REVOKED':
    case 'PROVIDER_ELIGIBILITY_REVOKED':
    case 'EXECUTION_AUTHORITY_REVOKED':
    case 'FINANCIAL_SECURITY_EXPIRED':
      return reason;
    default:
      return null;
  }
}
function required(value: string | null, name: string): string {
  if (value === null) throw Error('CHANGE_ORDER_RECOVERY_' + name + '_MISSING');
  return value;
}
function bindObservation(
  lease: ChangeOrderRecoveryLease,
  claim: UniversalV1ChangeOrderRecoveryClaim
): void {
  if (
    claim.proposalId !== lease.proposal_id ||
    claim.recoveryLeaseId !== lease.recovery_lease_id ||
    claim.leaseOwnerId !== lease.lease_owner_id ||
    claim.workOrderId !== lease.work_order_id ||
    claim.witnessRequestSha256 !== lease.witness_request_sha256
  )
    throw Error('CHANGE_ORDER_RECOVERY_OBSERVATION_IDENTITY_MISMATCH');
}

/** Scheduled recovery uses the installed restricted worker commands. REQUESTED
 * work belongs to the durable publisher/processor; this worker never executes a
 * provider call or clears a hold without a committed terminal command. */
export class UniversalV1ChangeOrderRecoveryWorker {
  private readonly leaseOwnerId: string;
  private readonly leaseDurationSeconds: number;
  private readonly minimumAgeSeconds: number;
  constructor(
    private readonly dependencies: UniversalV1ChangeOrderRecoveryWorkerDependencies = installedDependencies(),
    options: UniversalV1ChangeOrderRecoveryWorkerOptions = {}
  ) {
    this.leaseOwnerId = options.leaseOwnerId ?? randomUUID();
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 60;
    this.minimumAgeSeconds = options.minimumAgeSeconds ?? 30;
  }
  async runOnce(limit: number = 25): Promise<UniversalV1ChangeOrderRecoveryRunResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error('CHANGE_ORDER_RECOVERY_LIMIT_INVALID');
    if (
      !Number.isInteger(this.leaseDurationSeconds) ||
      this.leaseDurationSeconds < 5 ||
      this.leaseDurationSeconds > 900
    )
      throw Error('CHANGE_ORDER_RECOVERY_LEASE_DURATION_INVALID');
    if (
      !Number.isInteger(this.minimumAgeSeconds) ||
      this.minimumAgeSeconds < 5 ||
      this.minimumAgeSeconds > 3600
    )
      throw Error('CHANGE_ORDER_RECOVERY_MINIMUM_AGE_INVALID');
    this.dependencies.assertAuthorized();
    const leases = await this.dependencies.claims.claimDue({
      leaseOwnerId: this.leaseOwnerId,
      limit,
      leaseDurationSeconds: this.leaseDurationSeconds,
      minimumAgeSeconds: this.minimumAgeSeconds,
    });
    const counts = {
      claimed: leases.length,
      materialized: 0,
      cancelledRecoveryRequired: 0,
      reconcileOnly: 0,
      recoveryRequired: 0,
      retryLater: 0,
      failed: 0,
    };
    for (const lease of leases) {
      try {
        this.dependencies.assertAuthorized();
        const claim = await this.dependencies.observations.observe(lease);
        if (claim === null) {
          counts.retryLater++;
          continue;
        }
        bindObservation(lease, claim);
        counts[await this.recover(lease, claim)]++;
      } catch {
        counts.failed++;
      }
    }
    return Object.freeze(counts);
  }
  private async materialized(
    lease: ChangeOrderRecoveryLease,
    claim: UniversalV1ChangeOrderRecoveryClaim,
    amendmentId = required(claim.amendmentId, 'AMENDMENT')
  ): Promise<Outcome> {
    await this.dependencies.terminals.record({
      kind: 'MATERIALIZED',
      lease,
      actorUserId: claim.actorUserId,
      amendmentId,
      adjustmentEventId: required(claim.adjustmentEventId, 'ADJUSTMENT_EVENT'),
    });
    return 'materialized';
  }
  private async compensate(
    lease: ChangeOrderRecoveryLease,
    claim: UniversalV1ChangeOrderRecoveryClaim
  ): Promise<Outcome> {
    const winner = await this.dependencies.compensation.claim(
      lease,
      required(claim.adjustmentEventId, 'ADJUSTMENT_EVENT')
    );
    if (winner === null) return 'retryLater';
    if (winner.resolution.kind === 'AMENDMENT_MATERIALIZED')
      return this.materialized(lease, claim, winner.resolution.amendmentId);
    // A historical API/legacy winner has no worker provenance. Never fabricate it.
    if (winner.workerOrigin === null) return 'recoveryRequired';
    await this.dependencies.reversals.requestReversal(winner);
    return 'retryLater';
  }
  private async finalize(
    lease: ChangeOrderRecoveryLease,
    claim: UniversalV1ChangeOrderRecoveryClaim
  ): Promise<Outcome> {
    let amendmentId: string;
    try {
      const receipt = await this.dependencies.materialization.materialize({
        lease,
        adjustmentEventId: required(claim.adjustmentEventId, 'ADJUSTMENT_EVENT'),
        actorUserId: claim.actorUserId,
        replacementScopeVersionId: claim.replacementScopeVersionId,
        replacementScopeVersion: claim.replacementScopeVersion,
      });
      amendmentId = receipt.result.amendment_id;
    } catch (error) {
      // A failure is not evidence of revocation: the commit may have succeeded.
      // Refresh once, then let the compensation command validate a durable winner.
      const fresh = await this.dependencies.observations.observe(lease);
      if (fresh === null) return 'retryLater';
      bindObservation(lease, fresh);
      if (fresh.observation === 'AMENDMENT_MATERIALIZED') return this.materialized(lease, fresh);
      if (fresh.observation === 'COMPENSATION_SUCCEEDED') return this.recover(lease, fresh);
      if (
        fresh.observation === 'COMPENSATION_READY' ||
        (fresh.observation === 'ADJUSTMENT_SUCCEEDED' &&
          permanentRevocation(fresh.authorityRevocationReason))
      )
        return this.compensate(lease, fresh);
      throw error;
    }
    return this.materialized(lease, claim, amendmentId);
  }
  private async recover(
    lease: ChangeOrderRecoveryLease,
    claim: UniversalV1ChangeOrderRecoveryClaim
  ): Promise<Outcome> {
    switch (claim.observation) {
      case 'ADJUST_READY':
        await this.dependencies.adjustments.requestAdjustment(lease);
        return 'retryLater';
      case 'ADJUSTMENT_SUCCEEDED':
        return this.finalize(lease, claim);
      case 'AMENDMENT_MATERIALIZED':
        return this.materialized(lease, claim);
      case 'COMPENSATION_READY':
        return this.compensate(lease, claim);
      case 'COMPENSATION_SUCCEEDED':
        if (!claim.compensationCommand)
          throw Error('CHANGE_ORDER_RECOVERY_COMPENSATION_COMMAND_MISSING');
        await this.dependencies.terminals.record({
          kind: 'COMPENSATED',
          lease,
          actorUserId: claim.actorUserId,
          adjustmentEventId: required(claim.adjustmentEventId, 'ADJUSTMENT_EVENT'),
          compensationCommandId: claim.compensationCommand.compensationCommandId,
          compensationEventId: required(claim.compensationEventId, 'COMPENSATION_EVENT'),
        });
        return 'cancelledRecoveryRequired';
      case 'ADJUST_TERMINAL_NO_EFFECT':
        await this.dependencies.terminals.record({
          kind: 'NO_EFFECT',
          lease,
          actorUserId: claim.actorUserId,
          adjustmentEventId: claim.adjustmentEventId,
          noEffectOutcomeFactId: required(claim.adjustmentOutcomeFactId, 'NO_EFFECT_OUTCOME'),
          authorityRevocationReason: null,
        });
        return 'cancelledRecoveryRequired';
      case 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED': {
        const reason = permanentRevocation(claim.authorityRevocationReason);
        if (!reason) throw Error('CHANGE_ORDER_RECOVERY_PERMANENT_REVOCATION_REQUIRED');
        await this.dependencies.terminals.record({
          kind: 'NO_EFFECT',
          lease,
          actorUserId: claim.actorUserId,
          adjustmentEventId: null,
          noEffectOutcomeFactId: null,
          authorityRevocationReason: reason,
        });
        return 'cancelledRecoveryRequired';
      }
      case 'ADJUST_RECONCILE_ONLY':
      case 'COMPENSATION_RECONCILE_ONLY':
        return 'reconcileOnly';
      case 'COMPENSATION_TERMINAL_NO_EFFECT':
        return 'recoveryRequired';
      case 'ADJUST_REPLAYABLE':
      case 'COMPENSATION_REPLAYABLE':
      case 'WAITING':
        return 'retryLater';
    }
  }
}

export interface UniversalV1ChangeOrderRecoveryPollerDependencies {
  readonly worker: Pick<UniversalV1ChangeOrderRecoveryWorker, 'runOnce'>;
  /** Must assert the same local/preview/staging fake-finance capability. */
  readonly assertAuthorized: () => void;
}

export interface UniversalV1ChangeOrderRecoveryPollerHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped';
  readonly inFlight: boolean;
  readonly drained: boolean;
  readonly consecutiveFailures: number;
  readonly lastFailureCode: 'BATCH_FAILED' | 'BATCH_INCOMPLETE' | null;
  readonly compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED';
  readonly priorSecuredStateRestored: false;
  readonly executionMayResumeAfterCompensation: false;
}

export interface UniversalV1ChangeOrderRecoveryPollerHandle {
  readonly workerId: string;
  readonly interval: NodeJS.Timeout;
  health(): UniversalV1ChangeOrderRecoveryPollerHealth;
  stop(): Promise<void>;
}

/** Starts only after explicit nonproduction authorization and drains on stop. */
export function startUniversalV1ChangeOrderRecoveryPoller(
  intervalMs: number,
  dependencies: UniversalV1ChangeOrderRecoveryPollerDependencies,
  options: { readonly workerId?: string } = {}
): UniversalV1ChangeOrderRecoveryPollerHandle {
  if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60_000) {
    throw new Error('CHANGE_ORDER_RECOVERY_INTERVAL_INVALID');
  }
  dependencies.assertAuthorized();
  const workerId = options.workerId ?? `change-order-recovery:${randomUUID()}`;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let consecutiveFailures = 0;
  let lastFailureCode: 'BATCH_FAILED' | 'BATCH_INCOMPLETE' | null = null;

  const tick = (): Promise<void> => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    inFlight = Promise.resolve()
      .then(() => {
        dependencies.assertAuthorized();
        return dependencies.worker.runOnce();
      })
      .then((result) => {
        if (result.failed > 0) throw new Error('CHANGE_ORDER_RECOVERY_BATCH_INCOMPLETE');
        consecutiveFailures = 0;
        lastFailureCode = null;
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        lastFailureCode =
          error instanceof Error && error.message === 'CHANGE_ORDER_RECOVERY_BATCH_INCOMPLETE'
            ? 'BATCH_INCOMPLETE'
            : 'BATCH_FAILED';
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  return {
    workerId,
    interval,
    health: () => ({
      status: stopped ? 'stopped' : consecutiveFailures > 0 ? 'degraded' : 'healthy',
      inFlight: inFlight !== null,
      drained: stopped && inFlight === null,
      consecutiveFailures,
      lastFailureCode,
      compensationOutcome:
        UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION.compensationOutcome,
      priorSecuredStateRestored:
        UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION.priorSecuredStateRestored,
      executionMayResumeAfterCompensation:
        UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION.executionMayResumeAfterCompensation,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      await inFlight;
    },
  };
}
