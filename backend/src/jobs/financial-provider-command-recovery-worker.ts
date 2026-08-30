import { createHash } from 'node:crypto';

import type {
  FinancialOperationResult,
  FinancialOperationKind,
  FinancialOperationState,
} from '../services/payment/FinancialProviderPorts.js';
import {
  assertNonproductionFakeFinanceAuthorized,
  type NonproductionFinancialAuthorizationOptions,
} from '../services/payment/NonproductionFinancialAuthorization.js';
import type {
  FinancialProviderCommandDispatchAttempt,
  FinancialProviderCommandRecoveryClaim,
  FinancialProviderCommandRecoveryRepository,
  RecordFinancialProviderCommandOutcomeInput,
} from '../services/payment/FinancialProviderCommandRecovery.js';

const NONPRODUCTION_ENVIRONMENTS = new Set(['local', 'preview', 'staging']);
const FAILURE_CODE = /^[A-Z][A-Z0-9_.:-]{2,63}$/u;
const NONTERMINAL_STATES = new Set<FinancialOperationState>(['PENDING', 'RETRYABLE_FAILURE']);
const NO_EFFECT_STATES = new Set<FinancialOperationState>([
  'DECLINED',
  'FAILED',
  'REJECTED',
  'MATCHED',
  'MISMATCH',
]);
const FAILURE_PROVIDER_STATES = [
  'PENDING',
  'DECLINED',
  'FAILED',
  'RETRYABLE_FAILURE',
] as const satisfies readonly FinancialOperationState[];
const PROVIDER_STATES_BY_OPERATION: Readonly<
  Record<FinancialOperationKind, ReadonlySet<FinancialOperationState>>
> = {
  PREPARE_PAYMENT_METHOD: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  AUTHORIZE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  SECURE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  VOID: new Set(['VOIDED', ...FAILURE_PROVIDER_STATES]),
  ADJUST: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  CAPTURE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  REFUND: new Set(['REFUNDED', 'PARTIALLY_REFUNDED', ...FAILURE_PROVIDER_STATES]),
  REVERSAL: new Set(['REVERSED', ...FAILURE_PROVIDER_STATES]),
  ONBOARD_PROVIDER: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  REFRESH_PROVIDER_ACCOUNT_STATE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  SETTLE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  FUND: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  PROVIDER_RELEASE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  PAYOUT: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  OBSERVE_BANK_SETTLEMENT: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  INGEST_WEBHOOK: new Set(['ACCEPTED', 'REJECTED', 'PENDING', 'RETRYABLE_FAILURE']),
  RECONCILE: new Set(['MATCHED', 'MISMATCH']),
};
const MONEY_OPERATION_KINDS = new Set<FinancialOperationKind>([
  'AUTHORIZE',
  'SECURE',
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
]);

export type FakeFinancialCommandRecoveryExecutionResult =
  | {
      readonly kind: 'OUTCOME_OBSERVED';
      readonly providerResult: FinancialOperationResult;
    }
  | {
      readonly kind: 'OUTCOME_UNKNOWN';
      readonly failureCode: string;
      readonly recoveryDelaySeconds: number;
    }
  | {
      readonly kind: 'FAILED';
      readonly failureCode: string;
      readonly retryable: false;
      /** A FAILED fact is legal only when provider effect is definitively absent. */
      readonly confirmedNoEffect: true;
    }
  | {
      readonly kind: 'FAILED';
      readonly failureCode: string;
      readonly retryable: true;
      readonly recoveryDelaySeconds: number;
      /** A retry is legal only when provider effect is definitively absent. */
      readonly confirmedNoEffect: true;
    };

/**
 * Deliberately fake-only. No approved-provider executor, resolver, or factory is
 * exposed by this worker foundation.
 */
export interface FakeFinancialCommandRecoveryExecutor {
  readonly providerKind: 'FAKE';
  /** Executor guarantees transport cancellation and promise settlement on abort. */
  readonly abortContract: 'ABORT_SIGNAL_SETTLES';
  reconcile(
    claim: FinancialProviderCommandRecoveryClaim,
    attempt: FinancialProviderCommandDispatchAttempt,
    signal: AbortSignal
  ): Promise<FakeFinancialCommandRecoveryExecutionResult>;
}

export interface NonproductionFakeFinancialCommandRecoveryWorkerOptions {
  readonly environment: 'local' | 'preview' | 'staging';
  readonly leaseOwnerId: string;
  readonly batchLimit?: number;
  readonly leaseDurationSeconds?: number;
  readonly thrownOutcomeRecoveryDelaySeconds?: number;
  readonly nonterminalObservationRecoveryDelaySeconds?: number;
  readonly reconciliationDeadlineMs?: number;
}

export interface FinancialProviderCommandRecoveryRunResult {
  readonly claimed: number;
  readonly reconciled: number;
  readonly outcomeObserved: number;
  readonly outcomeUnknown: number;
  readonly failed: number;
  readonly persistenceErrors: number;
}

export interface ForegroundFinancialProviderCommandDispatchPort {
  /**
   * Must establish fresh lifecycle reservation/authorization and bind the
   * exact request identity before recording DISPATCH_ATTEMPTED and entering a
   * provider. A PREPARED fact alone grants no dispatch authority. Not
   * implemented here.
   */
  dispatchPreparedCommand(commandId: string): Promise<FinancialProviderCommandDispatchAttempt>;
}

export interface FinancialProviderCommandOutcomeMaterializationPort {
  /**
   * Must separately authorize and apply durable evidence to the authoritative
   * lifecycle. Neither PREPARED nor an outcome fact grants that write
   * authority. Not implemented here.
   */
  materializeCommandOutcome(commandId: string, outcomeFactId: string): Promise<void>;
}

export const FINANCIAL_PROVIDER_COMMAND_RECOVERY_INTEGRATION_BLOCKERS = Object.freeze({
  foregroundPreparedCommandDispatch: 'NOT_WIRED',
  lifecycleOutcomeMaterialization: 'NOT_WIRED',
  abortableProviderReconciliation: 'EXECUTOR_CONTRACT_REQUIRED',
} as const);

type FakeFinanceAuthorizer = (
  options: NonproductionFinancialAuthorizationOptions
) => unknown;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function financialProviderOutcomeProjectionSha256(
  result: FinancialOperationResult
): string {
  const canonical = [
    result.operationId,
    result.operationKind,
    result.providerKind,
    result.state,
    String(result.version),
    result.amountCents === null ? '' : String(result.amountCents),
    result.currency ?? '',
    sha256(result.externalReference),
    String(result.retryable),
  ].join(':');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function boundedInteger(value: unknown, minimum: number, maximum: number, error: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(error);
  }
  return Number(value);
}

function assertFailureCode(value: string): void {
  if (!FAILURE_CODE.test(value)) throw new Error('FAKE_FINANCIAL_RECOVERY_FAILURE_CODE_INVALID');
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertFinalProviderResult(
  claim: FinancialProviderCommandRecoveryClaim,
  result: FinancialOperationResult
): void {
  if (
    result.providerKind !== 'FAKE' ||
    result.operationId !== claim.command.operationId ||
    result.operationKind !== claim.command.operationKind ||
    result.version !== claim.command.providerExpectedVersion + 1 ||
    !PROVIDER_STATES_BY_OPERATION[claim.command.operationKind].has(result.state) ||
    (NONTERMINAL_STATES.has(result.state)
      ? result.retryable !== true
      : result.retryable !== false) ||
    typeof result.externalReference !== 'string' ||
    result.externalReference.length < 1 ||
    result.externalReference.length > 512 ||
    result.externalReference.trim() !== result.externalReference ||
    containsControlCharacter(result.externalReference) ||
    typeof result.idempotencyReplayed !== 'boolean' ||
    (MONEY_OPERATION_KINDS.has(claim.command.operationKind)
      ? !Number.isSafeInteger(claim.command.amountCents) ||
        result.amountCents !== claim.command.amountCents ||
        typeof claim.command.currency !== 'string' ||
        !/^[A-Z]{3}$/u.test(claim.command.currency) ||
        result.currency !== claim.command.currency
      : result.amountCents !== null || result.currency !== null)
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_RESULT_INVALID');
  }
}

function outcomeIdempotencyKey(recoveryLeaseId: string): string {
  return `finance-recovery:${recoveryLeaseId}`;
}

function outcomeInput(
  claim: FinancialProviderCommandRecoveryClaim,
  attempt: FinancialProviderCommandDispatchAttempt,
  execution: FakeFinancialCommandRecoveryExecutionResult,
  nonterminalObservationRecoveryDelaySeconds: number
): RecordFinancialProviderCommandOutcomeInput {
  const common = {
    commandId: claim.command.commandId,
    dispatchAttemptId: attempt.dispatchAttemptId,
    recoveryLeaseId: claim.lease.recoveryLeaseId,
    observationIdempotencyKey: outcomeIdempotencyKey(claim.lease.recoveryLeaseId),
  } as const;
  if (execution.kind === 'OUTCOME_OBSERVED') {
    assertFinalProviderResult(claim, execution.providerResult);
    const nonterminal = NONTERMINAL_STATES.has(execution.providerResult.state);
    return {
      kind: execution.kind,
      ...common,
      providerResultSha256: financialProviderOutcomeProjectionSha256(execution.providerResult),
      providerState: execution.providerResult.state,
      providerResultVersion: execution.providerResult.version,
      amountCents: execution.providerResult.amountCents,
      currency: execution.providerResult.currency,
      externalReferenceSha256: sha256(execution.providerResult.externalReference),
      effectCertainty: nonterminal
        ? 'UNKNOWN'
        : NO_EFFECT_STATES.has(execution.providerResult.state)
          ? 'CONFIRMED_NO_EFFECT'
          : 'CONFIRMED_EFFECT',
      retryable: nonterminal,
      recoveryDelaySeconds: nonterminal
        ? nonterminalObservationRecoveryDelaySeconds
        : null,
    };
  }

  assertFailureCode(execution.failureCode);
  if (execution.kind === 'OUTCOME_UNKNOWN') {
    return {
      kind: execution.kind,
      ...common,
      failureCode: execution.failureCode,
      recoveryDelaySeconds: boundedInteger(
        execution.recoveryDelaySeconds,
        1,
        86_400,
        'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
      ),
    };
  }
  if (execution.confirmedNoEffect !== true) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_NO_EFFECT_UNCONFIRMED');
  }
  if (execution.retryable) {
    return {
      kind: execution.kind,
      ...common,
      failureCode: execution.failureCode,
      retryable: true,
      recoveryDelaySeconds: boundedInteger(
        execution.recoveryDelaySeconds,
        1,
        86_400,
        'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
      ),
    };
  }
  return {
    kind: execution.kind,
    ...common,
    failureCode: execution.failureCode,
    retryable: false,
  };
}

/**
 * One-shot nonproduction worker foundation. It is intentionally not registered
 * with BullMQ or any schedule. The caller must supply an explicit fake
 * executor and invoke `runOnce`; production construction fails closed.
 */
export class NonproductionFakeFinancialCommandRecoveryWorker {
  private readonly batchLimit: number;
  private readonly leaseDurationSeconds: number;
  private readonly thrownOutcomeRecoveryDelaySeconds: number;
  private readonly nonterminalObservationRecoveryDelaySeconds: number;
  private readonly reconciliationDeadlineMs: number;

  constructor(
    private readonly repository: FinancialProviderCommandRecoveryRepository,
    private readonly executor: FakeFinancialCommandRecoveryExecutor,
    private readonly options: NonproductionFakeFinancialCommandRecoveryWorkerOptions,
    private readonly authorize: FakeFinanceAuthorizer = assertNonproductionFakeFinanceAuthorized
  ) {
    if (
      !NONPRODUCTION_ENVIRONMENTS.has(options.environment) ||
      executor.providerKind !== 'FAKE' ||
      executor.abortContract !== 'ABORT_SIGNAL_SETTLES'
    ) {
      throw new Error('FAKE_FINANCIAL_RECOVERY_NONPRODUCTION_ONLY');
    }
    authorize({ component: 'worker' });
    this.batchLimit = boundedInteger(
      options.batchLimit ?? 20,
      1,
      50,
      'FAKE_FINANCIAL_RECOVERY_BATCH_INVALID'
    );
    this.leaseDurationSeconds = boundedInteger(
      options.leaseDurationSeconds ?? 60,
      2,
      900,
      'FAKE_FINANCIAL_RECOVERY_LEASE_INVALID'
    );
    this.thrownOutcomeRecoveryDelaySeconds = boundedInteger(
      options.thrownOutcomeRecoveryDelaySeconds ?? 30,
      1,
      86_400,
      'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
    );
    this.nonterminalObservationRecoveryDelaySeconds = boundedInteger(
      options.nonterminalObservationRecoveryDelaySeconds ?? 30,
      1,
      86_400,
      'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
    );
    this.reconciliationDeadlineMs = boundedInteger(
      options.reconciliationDeadlineMs ?? 30_000,
      1,
      this.leaseDurationSeconds * 1_000 - 1_000,
      'FAKE_FINANCIAL_RECOVERY_DEADLINE_INVALID'
    );
  }

  async runOnce(): Promise<FinancialProviderCommandRecoveryRunResult> {
    const mutable = {
      claimed: 0,
      reconciled: 0,
      outcomeObserved: 0,
      outcomeUnknown: 0,
      failed: 0,
      persistenceErrors: 0,
    };
    const processedCommandIds = new Set<string>();

    for (let index = 0; index < this.batchLimit; index += 1) {
      let claims: readonly FinancialProviderCommandRecoveryClaim[];
      try {
        claims = await this.repository.claimRecoverable({
          leaseOwnerId: this.options.leaseOwnerId,
          leaseDurationSeconds: this.leaseDurationSeconds,
          excludeCommandIds: [...processedCommandIds],
        });
      } catch {
        mutable.persistenceErrors += 1;
        break;
      }
      if (claims.length === 0) break;
      if (claims.length !== 1) {
        mutable.persistenceErrors += 1;
        break;
      }
      const claim = claims[0]!;
      if (processedCommandIds.has(claim.command.commandId)) {
        mutable.persistenceErrors += 1;
        break;
      }
      processedCommandIds.add(claim.command.commandId);
      mutable.claimed += 1;
      if (
        claim.command.providerKind !== 'FAKE' ||
        claim.lease.recoveryAction !== 'RECONCILE' ||
        claim.lastDispatchAttempt === null
      ) {
        mutable.persistenceErrors += 1;
        continue;
      }
      let execution: FakeFinancialCommandRecoveryExecutionResult;
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => {
        abortController.abort(new Error('FAKE_FINANCIAL_RECOVERY_DEADLINE_EXCEEDED'));
      }, this.reconciliationDeadlineMs);
      try {
        this.authorize({ component: 'worker' });
      } catch {
        clearTimeout(abortTimer);
        mutable.persistenceErrors += 1;
        continue;
      }
      mutable.reconciled += 1;
      try {
        execution = await this.executor.reconcile(
          claim,
          claim.lastDispatchAttempt,
          abortController.signal
        );
        if (abortController.signal.aborted) {
          throw new Error('FAKE_FINANCIAL_RECOVERY_DEADLINE_EXCEEDED');
        }
      } catch {
        execution = {
          kind: 'OUTCOME_UNKNOWN',
          failureCode: 'FAKE_EXECUTOR_THROWN',
          recoveryDelaySeconds: this.thrownOutcomeRecoveryDelaySeconds,
        };
      } finally {
        clearTimeout(abortTimer);
      }

      let durableOutcome: RecordFinancialProviderCommandOutcomeInput;
      try {
        durableOutcome = outcomeInput(
          claim,
          claim.lastDispatchAttempt,
          execution,
          this.nonterminalObservationRecoveryDelaySeconds
        );
      } catch {
        durableOutcome = outcomeInput(
          claim,
          claim.lastDispatchAttempt,
          {
            kind: 'OUTCOME_UNKNOWN',
            failureCode: 'FAKE_EXECUTOR_RESULT_INVALID',
            recoveryDelaySeconds: this.thrownOutcomeRecoveryDelaySeconds,
          },
          this.nonterminalObservationRecoveryDelaySeconds
        );
      }

      try {
        const outcome = await this.repository.recordOutcome(durableOutcome);
        if (outcome.outcomeKind === 'OUTCOME_OBSERVED') mutable.outcomeObserved += 1;
        else if (outcome.outcomeKind === 'OUTCOME_UNKNOWN') mutable.outcomeUnknown += 1;
        else mutable.failed += 1;
      } catch {
        mutable.persistenceErrors += 1;
      }
    }

    return mutable;
  }
}
