import { randomUUID } from 'node:crypto';

import { db, type Database, type QueryFn } from '../../db.js';
import {
  PROVIDER_EVENT_OUTCOME_SELECT,
  ProviderEventProcessingError,
  SYNTHETIC_PROVIDER_EVENT_KIND,
  assertProviderEventCompletionIdentity,
  assertProviderEventDetailCode,
  assertProviderEventLeaseInput,
  assertProviderEventRetryDelay,
  assertProviderEventSuccess,
  mapProviderEventOutcome,
  providerEventNormalizationIdempotencyKey,
  type CompleteProviderEventFailureInput,
  type CompleteProviderEventRetryableFailureInput,
  type CompleteProviderEventSuccessInput,
  type ProviderEventAttemptRow,
  type ProviderEventCandidateRow,
  type ProviderEventLeaseRow,
  type ProviderEventOutcomeRow,
  type ProviderEventProcessingClaim,
  type ProviderEventProcessingOutcome,
  type ProviderEventProcessingRepository,
} from './ProviderEventProcessingContract.js';

export * from './ProviderEventProcessingContract.js';

/**
 * PostgreSQL lease coordinator. `SKIP LOCKED` permits multiple worker replicas;
 * an expired lease is closed with immutable evidence before its replacement is
 * inserted in the same transaction.
 */
export class PostgresProviderEventProcessingRepository
implements ProviderEventProcessingRepository {
  constructor(private readonly database: Database = db) {}

  async claimNext(
    workerId: string,
    leaseDurationMs: number,
  ): Promise<ProviderEventProcessingClaim | null> {
    assertProviderEventLeaseInput(workerId, leaseDurationMs);
    try {
      return await this.database.transaction(async (query) => {
        const candidateResult = await query<ProviderEventCandidateRow>(
          `SELECT
             processing.observation_id, processing.processing_state,
             processing.attempt_count, processing.retryable_failure_count,
             processing.active_attempt_id, processing.active_lease_token,
             observation.provider_kind, observation.provider_event_reference,
             observation.provider_event_kind, observation.operation_id,
             observation.raw_payload, observation.raw_payload_sha256
           FROM public.provider_event_processing_state processing
           JOIN public.provider_event_inbox_observations observation
             ON observation.observation_id=processing.observation_id
          WHERE observation.provider_kind='FAKE'
            AND observation.provider_event_kind=$1
            AND EXISTS (
              SELECT 1 FROM public.provider_event_inbox_receipts receipt
               WHERE receipt.observation_id=observation.observation_id
                 AND receipt.authentication_status='VERIFIED'
            )
            AND (
              processing.processing_state='PENDING'
              OR (
                processing.processing_state='RETRY_PENDING'
                AND processing.available_at <= clock_timestamp()
              )
              OR (
                processing.processing_state='LEASED'
                AND processing.lease_expires_at <= clock_timestamp()
              )
            )
          ORDER BY
            CASE WHEN processing.processing_state='LEASED' THEN 0 ELSE 1 END,
            processing.available_at,
            observation.first_received_at,
            processing.observation_id
          FOR UPDATE OF processing SKIP LOCKED
          LIMIT 1`,
          [SYNTHETIC_PROVIDER_EVENT_KIND],
        );
        const candidate = candidateResult.rows[0];
        if (!candidate) return null;

        if (candidate.processing_state === 'LEASED') {
          if (!candidate.active_attempt_id || !candidate.active_lease_token) {
            throw new ProviderEventProcessingError('CLAIM_INVALID');
          }
          const expired = await query<ProviderEventOutcomeRow>(
            `INSERT INTO public.provider_event_processing_outcomes (
               attempt_id, observation_id, lease_token, outcome_kind, detail_code
             ) VALUES ($1,$2,$3,'LEASE_EXPIRED','LEASE_EXPIRED')
             RETURNING ${PROVIDER_EVENT_OUTCOME_SELECT}`,
            [
              candidate.active_attempt_id,
              candidate.observation_id,
              candidate.active_lease_token,
            ],
          );
          if (!expired.rows[0]) {
            throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
          }
        }

        const attemptId = randomUUID();
        const leaseToken = randomUUID();
        const attemptNumber = Number(candidate.attempt_count) + 1;
        if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
          throw new ProviderEventProcessingError('CLAIM_INVALID');
        }
        const normalizationIdempotencyKey = providerEventNormalizationIdempotencyKey(
          candidate.provider_kind,
          candidate.provider_event_reference,
        );
        const attemptResult = await query<ProviderEventAttemptRow>(
          `INSERT INTO public.provider_event_processing_attempts (
             attempt_id, observation_id, attempt_number, lease_token, leased_by,
             leased_at, lease_expires_at, normalization_idempotency_key
           ) SELECT
             $1,$2,$3,$4,$5,
             lease_clock.claimed_at,
             lease_clock.claimed_at + ($6::integer * INTERVAL '1 millisecond'),$7
             FROM (SELECT clock_timestamp() AS claimed_at) lease_clock
           RETURNING
             attempt_id, observation_id, attempt_number, lease_token, leased_by,
             leased_at, lease_expires_at, normalization_idempotency_key`,
          [
            attemptId,
            candidate.observation_id,
            attemptNumber,
            leaseToken,
            workerId,
            leaseDurationMs,
            normalizationIdempotencyKey,
          ],
        );
        const attempt = attemptResult.rows[0];
        if (!attempt) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');

        const leased = await query<ProviderEventLeaseRow>(
          `UPDATE public.provider_event_processing_state processing
              SET processing_state='LEASED',
                  attempt_count=processing.attempt_count + 1,
                  active_attempt_id=attempt.attempt_id,
                  active_lease_token=attempt.lease_token,
                  leased_by=attempt.leased_by,
                  leased_at=attempt.leased_at,
                  lease_expires_at=attempt.lease_expires_at,
                  completed_at=NULL
             FROM public.provider_event_processing_attempts attempt
            WHERE processing.observation_id=$1
              AND attempt.attempt_id=$2
              AND attempt.observation_id=processing.observation_id
            RETURNING processing.observation_id`,
          [candidate.observation_id, attempt.attempt_id],
        );
        if (!leased.rows[0]) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');

        const rawPayload = Buffer.from(candidate.raw_payload);
        if (rawPayload.byteLength < 1) {
          throw new ProviderEventProcessingError('CLAIM_INVALID');
        }
        return {
          observationId: candidate.observation_id,
          attemptId: attempt.attempt_id,
          attemptNumber: Number(attempt.attempt_number),
          retryableFailureCount: Number(candidate.retryable_failure_count),
          leaseToken: attempt.lease_token,
          leasedBy: attempt.leased_by,
          leasedAt: new Date(attempt.leased_at).toISOString(),
          leaseExpiresAt: new Date(attempt.lease_expires_at).toISOString(),
          providerKind: candidate.provider_kind,
          providerEventReference: candidate.provider_event_reference,
          providerEventKind: candidate.provider_event_kind,
          operationId: candidate.operation_id,
          rawPayload,
          rawPayloadSha256: candidate.raw_payload_sha256,
          normalizationIdempotencyKey: attempt.normalization_idempotency_key,
        };
      });
    } catch (error) {
      if (error instanceof ProviderEventProcessingError) throw error;
      throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
    }
  }

  async completeSuccess(
    input: CompleteProviderEventSuccessInput,
  ): Promise<ProviderEventProcessingOutcome> {
    assertProviderEventCompletionIdentity(input);
    assertProviderEventSuccess(input.result);
    return this.completeInTransaction(input, async (query) => {
      const inserted = await query<ProviderEventOutcomeRow>(
        `INSERT INTO public.provider_event_processing_outcomes (
           attempt_id, observation_id, lease_token, outcome_kind,
           normalized_operation_id, normalized_operation_version,
           normalized_state, normalization_idempotency_replayed
         ) VALUES ($1,$2,$3,'SUCCEEDED',$4,$5,$6,$7)
         RETURNING ${PROVIDER_EVENT_OUTCOME_SELECT}`,
        [
          input.attemptId,
          input.observationId,
          input.leaseToken,
          input.result.operationId,
          input.result.version,
          input.result.state,
          input.result.idempotencyReplayed,
        ],
      );
      const outcome = inserted.rows[0];
      if (!outcome) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
      await this.updateCompletedState(query, input.observationId, 'SUCCEEDED');
      return mapProviderEventOutcome(outcome);
    });
  }

  async completeRetryableFailure(
    input: CompleteProviderEventRetryableFailureInput,
  ): Promise<ProviderEventProcessingOutcome> {
    assertProviderEventCompletionIdentity(input);
    assertProviderEventDetailCode(input.detailCode);
    assertProviderEventRetryDelay(input.retryDelayMs);
    return this.completeInTransaction(input, async (query) => {
      const inserted = await query<ProviderEventOutcomeRow>(
        `INSERT INTO public.provider_event_processing_outcomes (
           attempt_id, observation_id, lease_token, outcome_kind, detail_code, retry_at
         ) VALUES (
           $1,$2,$3,'RETRYABLE_FAILED',$4,
           clock_timestamp() + ($5::integer * INTERVAL '1 millisecond')
         )
         RETURNING ${PROVIDER_EVENT_OUTCOME_SELECT}`,
        [
          input.attemptId,
          input.observationId,
          input.leaseToken,
          input.detailCode,
          input.retryDelayMs,
        ],
      );
      const outcome = inserted.rows[0];
      if (!outcome) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
      const updated = await query<ProviderEventLeaseRow>(
        `UPDATE public.provider_event_processing_state processing
            SET processing_state='RETRY_PENDING',
                retryable_failure_count=processing.retryable_failure_count + 1,
                available_at=outcome.retry_at,
                active_attempt_id=NULL,
                active_lease_token=NULL,
                leased_by=NULL,
                leased_at=NULL,
                lease_expires_at=NULL,
                completed_at=NULL
           FROM public.provider_event_processing_outcomes outcome
          WHERE processing.observation_id=$1
            AND outcome.outcome_id=$2
            AND outcome.observation_id=processing.observation_id
          RETURNING processing.observation_id`,
        [input.observationId, outcome.outcome_id],
      );
      if (!updated.rows[0]) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
      return mapProviderEventOutcome(outcome);
    });
  }

  async completeTerminalFailure(
    input: CompleteProviderEventFailureInput,
  ): Promise<ProviderEventProcessingOutcome> {
    assertProviderEventCompletionIdentity(input);
    assertProviderEventDetailCode(input.detailCode);
    return this.completeInTransaction(input, async (query) => {
      const inserted = await query<ProviderEventOutcomeRow>(
        `INSERT INTO public.provider_event_processing_outcomes (
           attempt_id, observation_id, lease_token, outcome_kind, detail_code
         ) VALUES ($1,$2,$3,'TERMINAL_FAILED',$4)
         RETURNING ${PROVIDER_EVENT_OUTCOME_SELECT}`,
        [input.attemptId, input.observationId, input.leaseToken, input.detailCode],
      );
      const outcome = inserted.rows[0];
      if (!outcome) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
      await this.updateCompletedState(query, input.observationId, 'TERMINAL_FAILED');
      return mapProviderEventOutcome(outcome);
    });
  }

  private async completeInTransaction<T>(
    input: { observationId: string; attemptId: string; leaseToken: string },
    complete: (query: QueryFn) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (query) => {
        const lease = await query<ProviderEventLeaseRow>(
          `SELECT observation_id
             FROM public.provider_event_processing_state
            WHERE observation_id=$1
              AND processing_state='LEASED'
              AND active_attempt_id=$2
              AND active_lease_token=$3
              AND lease_expires_at > clock_timestamp()
            FOR UPDATE`,
          [input.observationId, input.attemptId, input.leaseToken],
        );
        if (!lease.rows[0]) throw new ProviderEventProcessingError('LEASE_LOST');
        return complete(query);
      });
    } catch (error) {
      if (error instanceof ProviderEventProcessingError) throw error;
      throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
    }
  }

  private async updateCompletedState(
    query: QueryFn,
    observationId: string,
    state: 'SUCCEEDED' | 'TERMINAL_FAILED',
  ): Promise<void> {
    const updated = await query<ProviderEventLeaseRow>(
      `UPDATE public.provider_event_processing_state
          SET processing_state=$2,
              active_attempt_id=NULL,
              active_lease_token=NULL,
              leased_by=NULL,
              leased_at=NULL,
              lease_expires_at=NULL,
              completed_at=clock_timestamp()
        WHERE observation_id=$1
        RETURNING observation_id`,
      [observationId, state],
    );
    if (!updated.rows[0]) throw new ProviderEventProcessingError('PERSISTENCE_INCOMPLETE');
  }
}
