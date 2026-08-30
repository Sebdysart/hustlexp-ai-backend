import { createHash } from 'node:crypto';

import type { FinancialOperationState } from './FinancialProviderPorts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$/u;
const DETAIL_CODE = /^[A-Z][A-Z0-9:_-]{2,127}$/u;
const FINANCIAL_OPERATION_STATES = new Set<FinancialOperationState>([
  'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE', 'VOIDED',
  'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED', 'ACCEPTED', 'REJECTED',
  'MATCHED', 'MISMATCH',
]);

export const SYNTHETIC_PROVIDER_EVENT_KIND = 'financial_operation.observed';

export type ProviderEventProcessingErrorReason =
  | 'WORKER_ID_INVALID'
  | 'LEASE_DURATION_INVALID'
  | 'CLAIM_INVALID'
  | 'OUTCOME_INVALID'
  | 'RETRY_DELAY_INVALID'
  | 'LEASE_LOST'
  | 'PERSISTENCE_INCOMPLETE';

export class ProviderEventProcessingError extends Error {
  constructor(readonly reason: ProviderEventProcessingErrorReason) {
    super(`PROVIDER_EVENT_PROCESSING_${reason}`);
    this.name = 'ProviderEventProcessingError';
  }
}

export interface ProviderEventProcessingClaim {
  readonly observationId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly retryableFailureCount: number;
  readonly leaseToken: string;
  readonly leasedBy: string;
  readonly leasedAt: string;
  readonly leaseExpiresAt: string;
  readonly providerKind: 'FAKE';
  readonly providerEventReference: string;
  readonly providerEventKind: typeof SYNTHETIC_PROVIDER_EVENT_KIND;
  readonly operationId: string;
  readonly rawPayload: Buffer;
  readonly rawPayloadSha256: string;
  readonly normalizationIdempotencyKey: string;
}

export interface ProviderEventProcessingSuccess {
  readonly operationId: string;
  readonly version: number;
  readonly state: FinancialOperationState;
  readonly idempotencyReplayed: boolean;
}

export interface CompleteProviderEventSuccessInput {
  readonly observationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly result: ProviderEventProcessingSuccess;
}

export interface CompleteProviderEventFailureInput {
  readonly observationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly detailCode: string;
}

export interface CompleteProviderEventRetryableFailureInput
  extends CompleteProviderEventFailureInput {
  readonly retryDelayMs: number;
}

export type ProviderEventProcessingOutcomeKind =
  | 'SUCCEEDED'
  | 'RETRYABLE_FAILED'
  | 'TERMINAL_FAILED'
  | 'LEASE_EXPIRED';

export interface ProviderEventProcessingOutcome {
  readonly outcomeId: string;
  readonly attemptId: string;
  readonly observationId: string;
  readonly outcomeKind: ProviderEventProcessingOutcomeKind;
  readonly recordedAt: string;
  readonly retryAt: string | null;
}

export interface ProviderEventProcessingRepository {
  claimNext(workerId: string, leaseDurationMs: number): Promise<ProviderEventProcessingClaim | null>;
  completeSuccess(input: CompleteProviderEventSuccessInput): Promise<ProviderEventProcessingOutcome>;
  completeRetryableFailure(
    input: CompleteProviderEventRetryableFailureInput
  ): Promise<ProviderEventProcessingOutcome>;
  completeTerminalFailure(
    input: CompleteProviderEventFailureInput
  ): Promise<ProviderEventProcessingOutcome>;
}

export interface ProviderEventCandidateRow {
  observation_id: string;
  processing_state: 'PENDING' | 'LEASED' | 'RETRY_PENDING';
  attempt_count: number | string;
  retryable_failure_count: number | string;
  active_attempt_id: string | null;
  active_lease_token: string | null;
  provider_kind: 'FAKE';
  provider_event_reference: string;
  provider_event_kind: typeof SYNTHETIC_PROVIDER_EVENT_KIND;
  operation_id: string;
  raw_payload: Buffer | Uint8Array;
  raw_payload_sha256: string;
}

export interface ProviderEventAttemptRow {
  attempt_id: string;
  observation_id: string;
  attempt_number: number | string;
  lease_token: string;
  leased_by: string;
  leased_at: Date | string;
  lease_expires_at: Date | string;
  normalization_idempotency_key: string;
}

export interface ProviderEventLeaseRow {
  observation_id: string;
}

export interface ProviderEventOutcomeRow {
  outcome_id: string;
  attempt_id: string;
  observation_id: string;
  outcome_kind: ProviderEventProcessingOutcomeKind;
  retry_at: Date | string | null;
  recorded_at: Date | string;
}

export const PROVIDER_EVENT_OUTCOME_SELECT = `
  outcome_id, attempt_id, observation_id, outcome_kind, retry_at, recorded_at`;

export function providerEventNormalizationIdempotencyKey(
  providerKind: string,
  providerEventReference: string,
): string {
  const digest = createHash('sha256')
    .update(`${providerKind}\0${providerEventReference}`, 'utf8')
    .digest('hex');
  return `provider-event:${digest}`;
}

function assertUuid(value: unknown): void {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ProviderEventProcessingError('OUTCOME_INVALID');
  }
}

export function assertProviderEventLeaseInput(workerId: string, leaseDurationMs: number): void {
  if (!WORKER_ID.test(workerId)) {
    throw new ProviderEventProcessingError('WORKER_ID_INVALID');
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 100 || leaseDurationMs > 300_000) {
    throw new ProviderEventProcessingError('LEASE_DURATION_INVALID');
  }
}

export function assertProviderEventCompletionIdentity(input: {
  observationId: string;
  attemptId: string;
  leaseToken: string;
}): void {
  assertUuid(input.observationId);
  assertUuid(input.attemptId);
  assertUuid(input.leaseToken);
}

export function assertProviderEventDetailCode(value: string): void {
  if (!DETAIL_CODE.test(value)) {
    throw new ProviderEventProcessingError('OUTCOME_INVALID');
  }
}

export function assertProviderEventSuccess(result: ProviderEventProcessingSuccess): void {
  if (
    !UUID.test(result.operationId)
    || result.operationId.toLowerCase() !== result.operationId
    || !Number.isSafeInteger(result.version)
    || result.version < 0
    || !FINANCIAL_OPERATION_STATES.has(result.state)
    || typeof result.idempotencyReplayed !== 'boolean'
  ) {
    throw new ProviderEventProcessingError('OUTCOME_INVALID');
  }
}

export function assertProviderEventRetryDelay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 100 || value > 86_400_000) {
    throw new ProviderEventProcessingError('RETRY_DELAY_INVALID');
  }
}

export function mapProviderEventOutcome(
  row: ProviderEventOutcomeRow,
): ProviderEventProcessingOutcome {
  return {
    outcomeId: row.outcome_id,
    attemptId: row.attempt_id,
    observationId: row.observation_id,
    outcomeKind: row.outcome_kind,
    retryAt: row.retry_at === null ? null : new Date(row.retry_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}
