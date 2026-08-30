import { createHash, randomUUID } from 'node:crypto';

import type { FinancialOperationResult } from '../services/payment/FinancialProviderPorts.js';
import {
  PostgresProviderEventProcessingRepository,
  type ProviderEventProcessingClaim,
  type ProviderEventProcessingRepository,
} from '../services/payment/ProviderEventProcessing.js';
import {
  syntheticWebhookIngressCommandSchema,
  type SyntheticWebhookIngressCommand,
} from '../services/payment/SyntheticFinancialCommandSchemas.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  syntheticFinancialCommandAuthority,
  SyntheticFinancialAuthorityError,
} from '../services/payment/SyntheticFinancialCommandAuthority.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type UniversalV1FakeFinancialApplicationService,
} from '../services/payment/UniversalV1FinancialApplicationService.js';

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
  normalize(claim: ProviderEventProcessingClaim): Promise<FinancialOperationResult>;
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
  if (claim.providerEventKind !== 'financial_operation.observed') {
    terminal('EVENT_KIND_UNSUPPORTED');
  }
  if (sha256(claim.rawPayload) !== claim.rawPayloadSha256) {
    terminal('RAW_PAYLOAD_DIGEST_MISMATCH');
  }
}

function parseBoundReplayCommand(
  claim: ProviderEventProcessingClaim,
): SyntheticWebhookIngressCommand {
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(claim.rawPayload.toString('utf8'));
  } catch {
    terminal('RAW_PAYLOAD_INVALID');
  }
  const parsed = syntheticWebhookIngressCommandSchema.safeParse(untrusted);
  if (!parsed.success) terminal('RAW_PAYLOAD_INVALID');
  const command = parsed.data;
  if (
    command.providerKind !== claim.providerKind
    || command.providerEventReference !== claim.providerEventReference
    || command.operationId.toLowerCase() !== claim.operationId.toLowerCase()
  ) {
    terminal('OBSERVATION_BINDING_MISMATCH');
  }
  return command;
}

function assertReplayResult(
  claim: ProviderEventProcessingClaim,
  result: FinancialOperationResult,
): void {
  if (
    result.providerKind !== claim.providerKind
    || result.operationKind !== 'INGEST_WEBHOOK'
    || result.operationId.toLowerCase() !== claim.operationId.toLowerCase()
  ) {
    terminal('NORMALIZATION_RESULT_MISMATCH');
  }
}

/**
 * The only runtime normalizer in this worker is fake-only and re-enters the
 * existing exact-manifest gate before it resolves the fake application service.
 */
export class FakeProviderEventReplayNormalizer implements ProviderEventReplayNormalizer {
  constructor(
    private readonly assertAuthorized: () => void = () => {
      assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
    },
    private readonly createService: () => Pick<
      UniversalV1FakeFinancialApplicationService,
      'ingestWebhook'
    > = createUniversalV1FakeFinancialApplicationService,
    private readonly assertWebhookOperationBoundary: (
      taskDraftId: string,
      taskId: string,
      operationId: string,
    ) => Promise<void> = (taskDraftId, taskId, operationId) => (
      syntheticFinancialCommandAuthority.assertWebhookOperationBoundary(
        taskDraftId,
        taskId,
        operationId,
      )
    ),
  ) {}

  async normalize(claim: ProviderEventProcessingClaim): Promise<FinancialOperationResult> {
    this.assertAuthorized();
    assertReplayClaimEvidence(claim);
    const command = parseBoundReplayCommand(claim);
    try {
      await this.assertWebhookOperationBoundary(
        command.taskDraftId,
        command.taskId,
        command.operationId,
      );
    } catch (error) {
      if (error instanceof SyntheticFinancialAuthorityError) {
        terminal('WEBHOOK_OPERATION_BOUNDARY_REFUSED');
      }
      throw error;
    }

    const service = this.createService();
    const result = await service.ingestWebhook({
      providerKind: claim.providerKind,
      operationId: claim.operationId,
      idempotencyKey: claim.normalizationIdempotencyKey,
      providerExpectedVersion: command.providerExpectedVersion,
      providerEventReference: claim.providerEventReference,
      scenario: command.scenario,
      authenticated: true,
    });
    assertReplayResult(claim, result);
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
  let result: FinancialOperationResult;
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
  stop(): void;
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
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runProviderEventReplayBatch({ ...options, workerId }, dependencies);
    } finally {
      running = false;
    }
  };
  void tick().catch(() => undefined);
  const interval = setInterval(() => {
    void tick().catch(() => undefined);
  }, intervalMs);
  return {
    workerId,
    interval,
    stop: () => clearInterval(interval),
  };
}
