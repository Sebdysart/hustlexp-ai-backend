import { randomUUID } from 'node:crypto';

import {
  PostgresUniversalV1ChangeOrderRecoveryRepository,
  UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION,
  UniversalV1ChangeOrderRecoveryService,
  type UniversalV1ChangeOrderRecoveryRepository,
} from '../services/UniversalV1ChangeOrderRecovery.js';
import { PostgresUniversalV1ChangeOrderRepository } from '../services/UniversalV1ChangeOrderPostgresRepository.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type UniversalV1FakeFinancialApplicationService,
} from '../services/payment/UniversalV1FinancialApplicationService.js';

type RecoveryFinance = Pick<UniversalV1FakeFinancialApplicationService, 'executeFinancialEvent'>;

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

/**
 * Nonproduction fake-only recovery worker. Constructing finance is the
 * capability gate and always happens before a lease is acquired.
 */
export class UniversalV1ChangeOrderRecoveryWorker {
  private readonly leaseOwnerId: string;
  private readonly leaseDurationSeconds: number;
  private readonly minimumAgeSeconds: number;

  constructor(
    private readonly repository: UniversalV1ChangeOrderRecoveryRepository = new PostgresUniversalV1ChangeOrderRecoveryRepository(),
    private readonly service: UniversalV1ChangeOrderRecoveryService = new UniversalV1ChangeOrderRecoveryService(
      repository,
      new PostgresUniversalV1ChangeOrderRepository()
    ),
    private readonly createFinance: () => RecoveryFinance | Promise<RecoveryFinance> = () =>
      createUniversalV1FakeFinancialApplicationService(),
    options: UniversalV1ChangeOrderRecoveryWorkerOptions = {}
  ) {
    this.leaseOwnerId = options.leaseOwnerId ?? randomUUID();
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 60;
    this.minimumAgeSeconds = options.minimumAgeSeconds ?? 30;
  }

  async runOnce(limit: number = 25): Promise<UniversalV1ChangeOrderRecoveryRunResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('CHANGE_ORDER_RECOVERY_LIMIT_INVALID');
    }
    if (
      !Number.isInteger(this.leaseDurationSeconds) ||
      this.leaseDurationSeconds < 5 ||
      this.leaseDurationSeconds > 900
    ) {
      throw new Error('CHANGE_ORDER_RECOVERY_LEASE_DURATION_INVALID');
    }
    if (
      !Number.isInteger(this.minimumAgeSeconds) ||
      this.minimumAgeSeconds < 5 ||
      this.minimumAgeSeconds > 3_600
    ) {
      throw new Error('CHANGE_ORDER_RECOVERY_MINIMUM_AGE_INVALID');
    }

    // Factory construction proves local/preview/staging, exact signed release,
    // worker identity, fake provider, and frozen-money posture before DB claim.
    const finance = await this.createFinance();
    const claims = await this.repository.claimDue({
      leaseOwnerId: this.leaseOwnerId,
      limit,
      leaseDurationSeconds: this.leaseDurationSeconds,
      minimumAgeSeconds: this.minimumAgeSeconds,
    });
    let materialized = 0;
    let cancelledRecoveryRequired = 0;
    let reconcileOnly = 0;
    let recoveryRequired = 0;
    let retryLater = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        const result = await this.service.recover(claim, finance);
        switch (result.status) {
          case 'MATERIALIZED':
            materialized += 1;
            break;
          case 'CANCELLED_RECOVERY_REQUIRED':
            cancelledRecoveryRequired += 1;
            break;
          case 'RECONCILE_ONLY':
            reconcileOnly += 1;
            break;
          case 'COMPENSATION_TERMINAL_NO_EFFECT_RECOVERY_REQUIRED':
            recoveryRequired += 1;
            break;
          case 'RETRY_LATER':
            retryLater += 1;
            break;
        }
      } catch {
        failed += 1;
      }
    }
    return {
      claimed: claims.length,
      materialized,
      cancelledRecoveryRequired,
      reconcileOnly,
      recoveryRequired,
      retryLater,
      failed,
    };
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
