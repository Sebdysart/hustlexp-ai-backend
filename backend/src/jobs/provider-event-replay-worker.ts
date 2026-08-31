import { createHash, randomUUID } from 'node:crypto';

import {
  PostgresProviderEventProcessingRepository,
  type ProviderEventProcessingClaim,
  type ProviderEventProcessingRepository,
} from '../services/payment/ProviderEventProcessing.js';
import {
  syntheticFinancialObservationSchema,
  type SyntheticFinancialObservation,
} from '../services/payment/SyntheticFinancialCommandSchemas.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  PostgresProviderObservationNormalizationRepository,
  ProviderObservationNormalizationError,
  type ProviderObservationNormalizationRepository,
  type ProviderObservationNormalizationResult,
} from '../services/payment/ProviderObservationNormalization.js';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_RETRYABLE_FAILURES = 8;
const DEFAULT_BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;

export class ProviderEventReplayNormalizationError extends Error {
  constructor(
    readonly detailCode: string,
    readonly retryable: boolean,
  ) {
    super(`PROVIDER_EVENT_REPLAY_${detailCode}`);
    this.name = 'ProviderEventReplayNormalizationError';
  }
}

export interface ProviderEventReplayNormalizer {
  normalize(claim: ProviderEventProcessingClaim): Promise<ProviderObservationNormalizationResult>;
}

export interface ProviderEventReplayWorkerDependencies {
  readonly repository: ProviderEventProcessingRepository;
  readonly normalizer: ProviderEventReplayNormalizer;
  readonly assertAuthorized: () => void;
}

export interface RunProviderEventReplayBatchOptions {
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly maxRetryableFailures?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

export interface ProviderEventReplayBatchResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retryableFailed: number;
  readonly terminalFailed: number;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function terminal(detailCode: string): never {
  throw new ProviderEventReplayNormalizationError(detailCode, false);
}

function assertReplayClaimEvidence(claim: ProviderEventProcessingClaim): void {
  if (claim.providerKind !== 'FAKE') terminal('PROVIDER_NOT_FAKE');
  if (claim.providerEventKind !== 'FINANCIAL_OPERATION_OBSERVED') {
    terminal('EVENT_KIND_UNSUPPORTED');
  }
  if (sha256(claim.rawPayload) !== claim.rawPayloadSha256) {
    terminal('RAW_PAYLOAD_DIGEST_MISMATCH');
  }
}

function parseBoundReplayObservation(
  claim: ProviderEventProcessingClaim,
): SyntheticFinancialObservation {
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(claim.rawPayload.toString('utf8'));
  } catch {
    terminal('RAW_PAYLOAD_INVALID');
  }
  const parsed = syntheticFinancialObservationSchema.safeParse(untrusted);
  if (!parsed.success) terminal('RAW_PAYLOAD_INVALID');
  const observation = parsed.data;
  if (
    observation.providerKind !== claim.providerKind
    || observation.kind !== claim.providerEventKind
    || observation.providerEventReference !== claim.providerEventReference
    || observation.operationId.toLowerCase() !== claim.operationId.toLowerCase()
  ) {
    terminal('OBSERVATION_BINDING_MISMATCH');
  }
  return observation;
}

function assertReplayResult(
  claim: ProviderEventProcessingClaim,
  observation: SyntheticFinancialObservation,
  result: ProviderObservationNormalizationResult,
): void {
  if (
    result.providerKind !== claim.providerKind
    || result.operationId.toLowerCase() !== claim.operationId.toLowerCase()
    || result.observationId !== claim.observationId
    || result.operationKind !== observation.operationKind
    || result.predecessorProviderVersion !== observation.predecessorProviderVersion
    || result.version !== observation.observedProviderVersion
    || result.state !== observation.observedState
    || result.amountCents !== observation.amountCents
    || result.currency !== observation.currency
  ) {
    terminal('NORMALIZATION_RESULT_MISMATCH');
  }
}

/**
 * The runtime normalizer is fake-only and re-enters the exact-manifest gate,
 * then asks PostgreSQL to correlate authenticated inbox bytes. No provider
 * adapter is resolved or invoked by this path.
 */
export class FakeProviderEventReplayNormalizer implements ProviderEventReplayNormalizer {
  constructor(
    private readonly assertAuthorized: () => void = () => {
      assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
    },
    private readonly repository: ProviderObservationNormalizationRepository =
      new PostgresProviderObservationNormalizationRepository(),
  ) {}

  async normalize(
    claim: ProviderEventProcessingClaim,
  ): Promise<ProviderObservationNormalizationResult> {
    this.assertAuthorized();
    assertReplayClaimEvidence(claim);
    const observation = parseBoundReplayObservation(claim);
    let result: ProviderObservationNormalizationResult;
    try {
      result = await this.repository.normalizeAuthenticatedObservation(claim.observationId);
    } catch (error) {
      if (error instanceof ProviderObservationNormalizationError) {
        if (error.reason === 'AUTHORITY_REFUSED' || error.reason === 'OBSERVATION_INVALID') {
          terminal('OBSERVATION_AUTHORITY_REFUSED');
        }
        throw new ProviderEventReplayNormalizationError(
          'OBSERVATION_PERSISTENCE_UNAVAILABLE',
          true,
        );
      }
      throw error;
    }
    assertReplayResult(claim, observation, result);
    return result;
  }
}

const runtimeDependencies: ProviderEventReplayWorkerDependencies = {
  repository: new PostgresProviderEventProcessingRepository(),
  normalizer: new FakeProviderEventReplayNormalizer(),
  assertAuthorized: () => {
    assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  },
};

function integerOption(
  value: number,
  minimum: number,
  maximum: number,
  reason: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`PROVIDER_EVENT_REPLAY_${reason}`);
  }
  return value;
}

function retryDelay(
  failureNumber: number,
  baseDelayMs: number,
  maximumDelayMs: number,
): number {
  const exponent = Math.min(Math.max(failureNumber - 1, 0), 20);
  return Math.min(baseDelayMs * (2 ** exponent), maximumDelayMs);
}

function normalizedFailure(error: unknown): ProviderEventReplayNormalizationError {
  if (error instanceof ProviderEventReplayNormalizationError) return error;
  return new ProviderEventReplayNormalizationError(
    'NORMALIZATION_TEMPORARILY_UNAVAILABLE',
    true,
  );
}

interface ProviderEventReplayPolicy {
  readonly maxRetryableFailures: number;
  readonly baseRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
}

interface ProviderEventReplayClaimResult {
  readonly succeeded: number;
  readonly retryableFailed: number;
  readonly terminalFailed: number;
}

async function processProviderEventReplayClaim(
  claim: ProviderEventProcessingClaim,
  policy: ProviderEventReplayPolicy,
  dependencies: ProviderEventReplayWorkerDependencies,
): Promise<ProviderEventReplayClaimResult> {
  let result: ProviderObservationNormalizationResult;
  try {
    result = await dependencies.normalizer.normalize(claim);
  } catch (error) {
    const failure = normalizedFailure(error);
    const nextFailureNumber = claim.retryableFailureCount + 1;
    if (failure.retryable && nextFailureNumber < policy.maxRetryableFailures) {
      await dependencies.repository.completeRetryableFailure({
        observationId: claim.observationId,
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        detailCode: failure.detailCode,
        retryDelayMs: retryDelay(
          nextFailureNumber,
          policy.baseRetryDelayMs,
          policy.maxRetryDelayMs,
        ),
      });
      return { succeeded: 0, retryableFailed: 1, terminalFailed: 0 };
    }
    await dependencies.repository.completeTerminalFailure({
      observationId: claim.observationId,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      detailCode: failure.detailCode,
    });
    return { succeeded: 0, retryableFailed: 0, terminalFailed: 1 };
  }

  await dependencies.repository.completeSuccess({
    observationId: claim.observationId,
    attemptId: claim.attemptId,
    leaseToken: claim.leaseToken,
    result: {
      operationId: result.operationId.toLowerCase(),
      version: result.version,
      state: result.state,
      idempotencyReplayed: result.idempotencyReplayed,
    },
  });
  return { succeeded: 1, retryableFailed: 0, terminalFailed: 0 };
}

export async function runProviderEventReplayBatch(
  options: RunProviderEventReplayBatchOptions = {},
  dependencies: ProviderEventReplayWorkerDependencies = runtimeDependencies,
): Promise<ProviderEventReplayBatchResult> {
  dependencies.assertAuthorized();
  const workerId = options.workerId ?? `provider-event-replay:${randomUUID()}`;
  const batchSize = integerOption(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 100, 'BATCH_INVALID');
  const leaseDurationMs = integerOption(
    options.leaseDurationMs ?? DEFAULT_LEASE_MS,
    100,
    5 * 60_000,
    'LEASE_INVALID',
  );
  const maxRetryableFailures = integerOption(
    options.maxRetryableFailures ?? DEFAULT_MAX_RETRYABLE_FAILURES,
    1,
    32,
    'RETRY_LIMIT_INVALID',
  );
  const baseRetryDelayMs = integerOption(
    options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
    100,
    60_000,
    'RETRY_DELAY_INVALID',
  );
  const maxRetryDelayMs = integerOption(
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    baseRetryDelayMs,
    24 * 60 * 60_000,
    'MAX_RETRY_DELAY_INVALID',
  );
  let claimed = 0;
  let succeeded = 0;
  let retryableFailed = 0;
  let terminalFailed = 0;

  for (let index = 0; index < batchSize; index += 1) {
    const claim = await dependencies.repository.claimNext(workerId, leaseDurationMs);
    if (!claim) break;
    claimed += 1;
    const processed = await processProviderEventReplayClaim(claim, {
      maxRetryableFailures,
      baseRetryDelayMs,
      maxRetryDelayMs,
    }, dependencies);
    succeeded += processed.succeeded;
    retryableFailed += processed.retryableFailed;
    terminalFailed += processed.terminalFailed;
  }

  return { claimed, succeeded, retryableFailed, terminalFailed };
}

export interface ProviderEventReplayWorkerHandle {
  readonly workerId: string;
  readonly interval: NodeJS.Timeout;
  health(): ProviderEventReplayWorkerHealth;
  stop(): Promise<void>;
}

export interface ProviderEventReplayWorkerHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped';
  readonly inFlight: boolean;
  readonly consecutiveFailures: number;
  readonly lastFailureCode: string | null;
}

/**
 * Explicit nonproduction scheduler. It is intentionally not registered by the
 * production worker bootstrap; callers must opt in and pass the fake-finance
 * manifest gate before the first tick or timer is created.
 */
export function startProviderEventReplayWorker(
  intervalMs: number = 5_000,
  options: RunProviderEventReplayBatchOptions = {},
  dependencies: ProviderEventReplayWorkerDependencies = runtimeDependencies,
): ProviderEventReplayWorkerHandle {
  integerOption(intervalMs, 500, 60_000, 'INTERVAL_INVALID');
  dependencies.assertAuthorized();
  const workerId = options.workerId ?? `provider-event-replay:${randomUUID()}`;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let consecutiveFailures = 0;
  let lastFailureCode: string | null = null;
  const tick = (): Promise<void> => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    inFlight = runProviderEventReplayBatch({ ...options, workerId }, dependencies)
      .then(() => {
        consecutiveFailures = 0;
        lastFailureCode = null;
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        lastFailureCode = error instanceof ProviderEventReplayNormalizationError
          ? error.detailCode
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
      consecutiveFailures,
      lastFailureCode,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      await inFlight;
    },
  };
}
