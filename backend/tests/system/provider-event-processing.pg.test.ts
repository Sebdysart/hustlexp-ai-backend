import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import {
  PostgresProviderEventInboxRepository,
} from '../../src/services/payment/ProviderEventInbox.js';
import {
  PostgresProviderEventProcessingRepository,
  providerEventNormalizationIdempotencyKey,
} from '../../src/services/payment/ProviderEventProcessing.js';

const describePg = describe.sequential.skipIf(!hasDb);
const inbox = new PostgresProviderEventInboxRepository(db);
const processing = new PostgresProviderEventProcessingRepository(db);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function recordObservation(): Promise<string> {
  const operationId = randomUUID();
  const providerEventReference = `evt_processing_${randomUUID()}`;
  const rawPayload = Buffer.from(JSON.stringify({
    providerKind: 'FAKE',
    operationId,
    idempotencyKey: `provider-event-processing:${randomUUID()}`,
    providerExpectedVersion: 0,
    providerEventReference,
    taskDraftId: randomUUID(),
    taskId: randomUUID(),
  }), 'utf8');
  const receipt = await inbox.recordAuthenticatedEvent({
    providerKind: 'FAKE',
    providerEventReference,
    providerEventKind: 'financial_operation.observed',
    operationId,
    ingressIdempotencyKey: `provider-event:${randomUUID()}`,
    rawPayload,
    authentication: {
      status: 'VERIFIED',
      scheme: 'HMAC_SHA256',
      evidenceSha256: sha256(`provider-event-processing:${providerEventReference}`),
      verifiedAt: new Date().toISOString(),
    },
  });
  return receipt.observationId;
}

describePg('provider-event processing PostgreSQL authority', () => {
  it('auto-enrolls authenticated observations and claims distinct rows with SKIP LOCKED', async () => {
    const inserted = await Promise.all(Array.from({ length: 4 }, () => recordObservation()));
    const initialized = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM public.provider_event_processing_state
        WHERE observation_id=ANY($1::uuid[]) AND processing_state='PENDING'`,
      [inserted],
    );
    expect(initialized.rows[0]?.count).toBe(4);

    const claims = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      processing.claimNext(`provider-event-replay:pg-${index}`, 30_000)));
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map(claim => claim?.observationId)).size).toBe(4);
    for (const claim of claims) {
      expect(claim?.normalizationIdempotencyKey).toBe(
        providerEventNormalizationIdempotencyKey(
          claim?.providerKind ?? '',
          claim?.providerEventReference ?? '',
        ),
      );
      await processing.completeTerminalFailure({
        observationId: claim!.observationId,
        attemptId: claim!.attemptId,
        leaseToken: claim!.leaseToken,
        detailCode: 'PG_TEST_COMPLETE',
      });
    }
  });

  it('closes a crashed expired lease and reclaims the same observation exactly once', async () => {
    await recordObservation();
    const first = await processing.claimNext('provider-event-replay:pg-crash-1', 100);
    expect(first).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 175));

    const replay = await processing.claimNext('provider-event-replay:pg-crash-2', 30_000);
    expect(replay).toMatchObject({
      observationId: first?.observationId,
      attemptNumber: (first?.attemptNumber ?? 0) + 1,
      normalizationIdempotencyKey: first?.normalizationIdempotencyKey,
    });
    const expired = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM public.provider_event_processing_outcomes
        WHERE attempt_id=$1 AND outcome_kind='LEASE_EXPIRED'`,
      [first?.attemptId],
    );
    expect(expired.rows[0]?.count).toBe(1);
    await expect(processing.completeTerminalFailure({
      observationId: first!.observationId,
      attemptId: first!.attemptId,
      leaseToken: first!.leaseToken,
      detailCode: 'STALE_WORKER',
    })).rejects.toThrow('PROVIDER_EVENT_PROCESSING_LEASE_LOST');
    await processing.completeTerminalFailure({
      observationId: replay!.observationId,
      attemptId: replay!.attemptId,
      leaseToken: replay!.leaseToken,
      detailCode: 'PG_TEST_COMPLETE',
    });
  });

  it('rejects a forged success after the active processing lease expires', async () => {
    await recordObservation();
    const expired = await processing.claimNext('provider-event-replay:pg-expired-success', 100);
    expect(expired).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 175));

    await expect(db.query(
      `INSERT INTO public.provider_event_processing_outcomes (
         attempt_id, observation_id, lease_token, outcome_kind, normalized_operation_id,
         normalized_operation_version, normalized_state,
         normalization_idempotency_replayed
       ) VALUES ($1, $2, $3, 'SUCCEEDED', $4, 1, 'ACCEPTED', FALSE)`,
      [
        expired!.attemptId,
        expired!.observationId,
        expired!.leaseToken,
        expired!.operationId,
      ],
    )).rejects.toThrow(/expired lease cannot record a processing outcome/iu);

    const reclaimed = await processing.claimNext(
      'provider-event-replay:pg-expired-success-cleanup',
      30_000,
    );
    expect(reclaimed?.observationId).toBe(expired!.observationId);
    await processing.completeTerminalFailure({
      observationId: reclaimed!.observationId,
      attemptId: reclaimed!.attemptId,
      leaseToken: reclaimed!.leaseToken,
      detailCode: 'PG_TEST_COMPLETE',
    });
  });

  it('appends an immutable successful outcome and freezes terminal coordination', async () => {
    await recordObservation();
    const claim = await processing.claimNext('provider-event-replay:pg-success', 30_000);
    expect(claim).not.toBeNull();
    const outcome = await processing.completeSuccess({
      observationId: claim!.observationId,
      attemptId: claim!.attemptId,
      leaseToken: claim!.leaseToken,
      result: {
        operationId: claim!.operationId,
        version: 1,
        state: 'ACCEPTED',
        idempotencyReplayed: false,
      },
    });
    expect(outcome).toMatchObject({ outcomeKind: 'SUCCEEDED', retryAt: null });

    await expect(db.query(
      `UPDATE public.provider_event_processing_outcomes
          SET normalized_operation_version=2
        WHERE outcome_id=$1`,
      [outcome.outcomeId],
    )).rejects.toThrow(/append-only/iu);
    await expect(db.query(
      'DELETE FROM public.provider_event_processing_attempts WHERE attempt_id=$1',
      [claim!.attemptId],
    )).rejects.toThrow(/append-only/iu);
    await expect(db.query(
      `UPDATE public.provider_event_processing_state
          SET processing_state='PENDING', completed_at=NULL
        WHERE observation_id=$1`,
      [claim!.observationId],
    )).rejects.toThrow(/terminal/iu);
  });

  it('records a retryable outcome without exposing raw error material', async () => {
    await recordObservation();
    const claim = await processing.claimNext('provider-event-replay:pg-retry', 30_000);
    const outcome = await processing.completeRetryableFailure({
      observationId: claim!.observationId,
      attemptId: claim!.attemptId,
      leaseToken: claim!.leaseToken,
      detailCode: 'NORMALIZATION_TEMPORARILY_UNAVAILABLE',
      retryDelayMs: 60_000,
    });
    expect(outcome).toMatchObject({ outcomeKind: 'RETRYABLE_FAILED' });
    expect(Date.parse(outcome.retryAt ?? '')).toBeGreaterThan(Date.now());
    const stored = await db.query<{ serialized: string }>(
      `SELECT to_jsonb(outcome)::text AS serialized
         FROM public.provider_event_processing_outcomes outcome
        WHERE outcome_id=$1`,
      [outcome.outcomeId],
    );
    expect(stored.rows[0]?.serialized).not.toMatch(/secret|database host/iu);
  });

  it('requires append-only attempt and outcome evidence for every lease transition', async () => {
    await recordObservation();
    const claim = await processing.claimNext('provider-event-replay:pg-evidence', 30_000);
    expect(claim).not.toBeNull();

    await expect(db.query(
      `UPDATE public.provider_event_processing_state
          SET processing_state='LEASED',
              attempt_count=attempt_count + 1,
              active_attempt_id=$2,
              active_lease_token=$3,
              leased_by='provider-event-replay:forged',
              leased_at=clock_timestamp(),
              lease_expires_at=clock_timestamp() + INTERVAL '30 seconds'
        WHERE observation_id=$1`,
      [claim!.observationId, randomUUID(), randomUUID()],
    )).rejects.toThrow(/must match its append-only attempt/iu);

    await expect(db.query(
      `UPDATE public.provider_event_processing_state
          SET processing_state='TERMINAL_FAILED',
              active_attempt_id=NULL,
              active_lease_token=NULL,
              leased_by=NULL,
              leased_at=NULL,
              lease_expires_at=NULL,
              completed_at=clock_timestamp()
        WHERE observation_id=$1`,
      [claim!.observationId],
    )).rejects.toThrow(/requires append-only outcome evidence/iu);
    await processing.completeTerminalFailure({
      observationId: claim!.observationId,
      attemptId: claim!.attemptId,
      leaseToken: claim!.leaseToken,
      detailCode: 'PG_TEST_COMPLETE',
    });
  });

  it('database-authorizes lease identity, complete bundles, and audit time', async () => {
    await recordObservation();
    const claim = await processing.claimNext('provider-event-replay:pg-db-authority', 30_000);
    expect(claim).not.toBeNull();

    await expect(db.query(
      `INSERT INTO public.provider_event_processing_outcomes (
         attempt_id, observation_id, lease_token, outcome_kind, detail_code
       ) VALUES ($1, $2, $3, 'TERMINAL_FAILED', 'FORGED_TOKEN')`,
      [claim!.attemptId, claim!.observationId, randomUUID()],
    )).rejects.toThrow(/active leased attempt|foreign key/iu);

    const partialBundleObservationId = await recordObservation();
    await expect(db.query(
      `UPDATE public.provider_event_processing_state
          SET active_lease_token=$2
        WHERE observation_id=$1`,
      [partialBundleObservationId, randomUUID()],
    )).rejects.toThrow(
      /lease bundle|active leased attempt|check constraint|invalid provider event processing transition/iu,
    );

    const forgedObservationId = await recordObservation();
    const forgedObservation = await db.query<{ provider_event_reference: string }>(
      `SELECT provider_event_reference
         FROM public.provider_event_inbox_observations
        WHERE observation_id=$1`,
      [forgedObservationId],
    );
    const forgedReference = forgedObservation.rows[0]?.provider_event_reference;
    expect(forgedReference).toBeDefined();

    await expect(db.transaction(async query => {
      const forgedAttemptId = randomUUID();
      const forgedLeaseToken = randomUUID();
      const attempt = await query<{ leased_at: Date | string; lease_expires_at: Date | string }>(
        `INSERT INTO public.provider_event_processing_attempts (
           attempt_id, observation_id, attempt_number, lease_token, leased_by,
           leased_at, lease_expires_at, normalization_idempotency_key
         ) VALUES (
           $1, $2, 1, $3, 'provider-event-replay:forged-time',
           '2100-01-01T00:00:00Z'::timestamptz,
           '2100-01-01T00:00:30Z'::timestamptz,
           $4
         )
         RETURNING leased_at, lease_expires_at`,
        [
          forgedAttemptId,
          forgedObservationId,
          forgedLeaseToken,
          providerEventNormalizationIdempotencyKey('FAKE', forgedReference!),
        ],
      );
      const row = attempt.rows[0];
      expect(row).toBeDefined();
      expect(new Date(row!.leased_at).getUTCFullYear()).toBeLessThan(2100);
      expect(
        new Date(row!.lease_expires_at).getTime() - new Date(row!.leased_at).getTime(),
      ).toBe(30_000);
      throw new Error('ROLLBACK_FORGED_TIME_FIXTURE');
    })).rejects.toThrow('ROLLBACK_FORGED_TIME_FIXTURE');

    await processing.completeTerminalFailure({
      observationId: claim!.observationId,
      attemptId: claim!.attemptId,
      leaseToken: claim!.leaseToken,
      detailCode: 'PG_TEST_COMPLETE',
    });
  });
});
