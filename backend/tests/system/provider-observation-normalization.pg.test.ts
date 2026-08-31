import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import { financialProviderOutcomeProjectionSha256 } from '../../src/jobs/financial-provider-command-recovery-worker.js';
import {
  canonicalFinancialProviderRequestSha256,
  PostgresFinancialProviderCommandJournal,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  PostgresFinancialProviderCommandRecoveryRepository,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';
import type { FinancialOperationResult } from '../../src/services/payment/FinancialProviderPorts.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { PostgresProviderEventInboxRepository } from '../../src/services/payment/ProviderEventInbox.js';
import {
  PostgresProviderObservationNormalizationRepository,
  ProviderObservationNormalizationError,
} from '../../src/services/payment/ProviderObservationNormalization.js';

const describePg = describe.sequential.skipIf(!hasDb);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

describePg('provider observation normalization PostgreSQL authority', () => {
  it('corroborates an exact terminal observation without provider I/O or lifecycle success', async () => {
    const actorId = randomUUID();
    const taskDraftId = randomUUID();
    const operationId = randomUUID();
    const idempotencyKey = `provider-observation:${randomUUID()}`;
    const exactRequest = {
      operationId,
      idempotencyKey,
      expectedVersion: 0,
      customerId: `synthetic-customer-${randomUUID()}`,
    };
    await db.query(
      `INSERT INTO public.users(id, email, full_name)
       VALUES ($1, $2, 'Provider Observation System Actor')`,
      [actorId, `provider-observation-${actorId}@example.invalid`],
    );
    await db.query(
      `INSERT INTO public.task_drafts(
         id, submission_id, card_token_hash, raw_input, universal_contract_version
       ) VALUES ($1, $2, $3, 'Provider observation PostgreSQL proof', 1)`,
      [taskDraftId, randomUUID(), `provider-observation-card-${randomUUID()}`],
    );

    const prepared = await new PostgresUniversalV1PreparedFinancialCommandAuthority(db).prepare({
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId,
      providerKind: 'FAKE',
      idempotencyKey,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 0,
      providerRequestSha256: canonicalFinancialProviderRequestSha256(exactRequest),
      taskDraftId,
      taskId: null,
      eligibilityDecisionId: null,
      scopeVersionId: null,
      changeOrderId: null,
      predecessorEventId: null,
      completionFactId: null,
      relatedOperationId: null,
      amountCents: null,
      currency: null,
      recordedBy: actorId,
    });
    const requested = await new PostgresFinancialProviderCommandJournal(db).recordRequested({
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId,
      providerKind: 'FAKE',
      idempotencyKey,
      providerExpectedVersion: 0,
      exactRequest,
      evidence: {
        preparedFinancialCommandId: prepared.preparedCommandId,
        preparedAuthoritySha256: prepared.authorityContextSha256,
        taskDraftId,
      },
      actor: { actorId, actorKind: 'PARTICIPANT' },
    });
    const externalReference = `fake-payment-method-${randomUUID()}`;
    const inbox = new PostgresProviderEventInboxRepository(db);
    const prematurePayload = {
      version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
      kind: 'FINANCIAL_OPERATION_OBSERVED',
      providerKind: 'FAKE',
      providerEventReference: `evt_predispatch_${randomUUID()}`,
      operationId,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      predecessorProviderVersion: 0,
      observedProviderVersion: 1,
      observedState: 'SUCCEEDED',
      externalReference,
      amountCents: null,
      currency: null,
      providerOccurredAt: new Date().toISOString(),
    } as const;
    const prematureRawPayload = Buffer.from(JSON.stringify(prematurePayload), 'utf8');
    const prematureReceipt = await inbox.recordAuthenticatedEvent({
      providerKind: 'FAKE',
      providerEventReference: prematurePayload.providerEventReference,
      providerEventKind: 'FINANCIAL_OPERATION_OBSERVED',
      operationId,
      ingressIdempotencyKey: `provider-event:${sha256(
        `FAKE\0${prematurePayload.providerEventReference}`,
      )}`,
      rawPayload: prematureRawPayload,
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256(`test-auth:${prematurePayload.providerEventReference}`),
        verifiedAt: new Date().toISOString(),
      },
    });
    const recovery = new PostgresFinancialProviderCommandRecoveryRepository(db);
    const lease = await recovery.acquireLease({
      commandId: requested.commandId,
      recoveryAction: 'DISPATCH',
      leaseOwnerId: randomUUID(),
    });
    expect(lease).not.toBeNull();
    const attempted = await recovery.recordDispatchAttempted({
      commandId: requested.commandId,
      recoveryLeaseId: lease!.recoveryLeaseId,
      outcomeTimeoutSeconds: 30,
    });
    const terminalResult: FinancialOperationResult = {
      operationId,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      providerKind: 'FAKE',
      state: 'SUCCEEDED',
      version: 1,
      amountCents: null,
      currency: null,
      externalReference,
      idempotencyReplayed: false,
      retryable: false,
    };
    const expectedProviderResultSha256 = financialProviderOutcomeProjectionSha256(terminalResult);
    const outcome = await recovery.recordOutcome({
      kind: 'OUTCOME_OBSERVED',
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      recoveryLeaseId: lease!.recoveryLeaseId,
      observationIdempotencyKey: `provider-observation:${lease!.recoveryLeaseId}`,
      providerResultSha256: expectedProviderResultSha256,
      providerState: terminalResult.state,
      providerResultVersion: terminalResult.version,
      amountCents: null,
      currency: null,
      externalReferenceSha256: sha256(externalReference),
      effectCertainty: 'CONFIRMED_EFFECT',
      retryable: false,
      recoveryDelaySeconds: null,
    });
    await expect(db.query<{
      provider_result_sha256: string;
      provider_result_version: string;
      amount_cents: number | null;
      currency: string | null;
      external_reference_sha256: string;
    }>(
      `SELECT provider_result_sha256, provider_result_version,
              amount_cents, currency, external_reference_sha256
         FROM public.financial_provider_command_outcome_facts
        WHERE outcome_fact_id=$1`,
      [outcome.outcomeFactId],
    )).resolves.toMatchObject({
      rows: [{
        provider_result_sha256: expectedProviderResultSha256,
        provider_result_version: '1',
        amount_cents: null,
        currency: null,
        external_reference_sha256: sha256(externalReference),
      }],
    });

    await expect(db.query(
      `SELECT public.normalize_financial_provider_observation_v1($1::uuid)`,
      [prematureReceipt.observationId],
    )).rejects.toMatchObject({
      message: expect.stringContaining(
        'authenticated observation receipt precedes DISPATCH_ATTEMPTED authority',
      ),
    });
    await expect(db.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM public.provider_financial_observation_normalizations
        WHERE observation_id=$1`,
      [prematureReceipt.observationId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const providerOccurredAt = new Date().toISOString();
    const exactPayload = {
      version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
      kind: 'FINANCIAL_OPERATION_OBSERVED',
      providerKind: 'FAKE',
      providerEventReference: `evt_terminal_${randomUUID()}`,
      operationId,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      predecessorProviderVersion: 0,
      observedProviderVersion: 1,
      observedState: 'SUCCEEDED',
      externalReference,
      amountCents: null,
      currency: null,
      providerOccurredAt,
    } as const;
    const exactRawPayload = Buffer.from(JSON.stringify(exactPayload), 'utf8');
    const receipt = await inbox.recordAuthenticatedEvent({
      providerKind: 'FAKE',
      providerEventReference: exactPayload.providerEventReference,
      providerEventKind: 'FINANCIAL_OPERATION_OBSERVED',
      operationId,
      ingressIdempotencyKey: `provider-event:${sha256(
        `FAKE\0${exactPayload.providerEventReference}`,
      )}`,
      rawPayload: exactRawPayload,
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256(`test-auth:${exactPayload.providerEventReference}`),
        verifiedAt: new Date().toISOString(),
      },
    });

    const normalized = await new PostgresProviderObservationNormalizationRepository(db)
      .normalizeAuthenticatedObservation(receipt.observationId);
    expect(normalized).toMatchObject({
      observationId: receipt.observationId,
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      outcomeFactId: outcome.outcomeFactId,
      operationId,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      predecessorProviderVersion: 0,
      version: 1,
      state: 'SUCCEEDED',
      amountCents: null,
      currency: null,
      materializationState: 'TERMINAL_CORROBORATED',
      idempotencyReplayed: false,
    });

    const sideEffects = await db.query<{
      lifecycle_operations: number;
      lifecycle_events: number;
      fake_operations: number;
      fake_events: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM public.task_financial_operations
           WHERE operation_id=$1::text) AS lifecycle_operations,
         (SELECT count(*)::integer FROM public.task_financial_security_events
           WHERE operation_id=$1::text) AS lifecycle_events,
         (SELECT count(*)::integer FROM public.hxos_fake_financial_operations_v1
           WHERE operation_id=$1::uuid) AS fake_operations,
         (SELECT count(*)::integer FROM public.hxos_fake_financial_operation_events_v1
           WHERE operation_id=$1::uuid) AS fake_events`,
      [operationId],
    );
    expect(sideEffects.rows[0]).toEqual({
      lifecycle_operations: 0,
      lifecycle_events: 0,
      fake_operations: 0,
      fake_events: 0,
    });

    const mismatchPayload = {
      ...exactPayload,
      providerEventReference: `evt_mismatch_${randomUUID()}`,
      externalReference: `fake-mismatch-${randomUUID()}`,
    };
    const mismatchRawPayload = Buffer.from(JSON.stringify(mismatchPayload), 'utf8');
    const mismatchReceipt = await inbox.recordAuthenticatedEvent({
      providerKind: 'FAKE',
      providerEventReference: mismatchPayload.providerEventReference,
      providerEventKind: 'FINANCIAL_OPERATION_OBSERVED',
      operationId,
      ingressIdempotencyKey: `provider-event:${sha256(
        `FAKE\0${mismatchPayload.providerEventReference}`,
      )}`,
      rawPayload: mismatchRawPayload,
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256(`test-auth:${mismatchPayload.providerEventReference}`),
        verifiedAt: new Date().toISOString(),
      },
    });
    await expect(
      new PostgresProviderObservationNormalizationRepository(db)
        .normalizeAuthenticatedObservation(mismatchReceipt.observationId),
    ).rejects.toEqual(new ProviderObservationNormalizationError('AUTHORITY_REFUSED'));
    await expect(db.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM public.provider_financial_observation_normalizations
        WHERE observation_id=$1`,
      [mismatchReceipt.observationId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('preserves authenticated raw evidence but refuses normalization before exact command authority', async () => {
    const operationId = randomUUID();
    const providerEventReference = `evt_unbound_${randomUUID()}`;
    const payload = {
      version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
      kind: 'FINANCIAL_OPERATION_OBSERVED',
      providerKind: 'FAKE',
      providerEventReference,
      operationId,
      operationKind: 'AUTHORIZE',
      predecessorProviderVersion: 0,
      observedProviderVersion: 1,
      observedState: 'UNKNOWN',
      externalReference: `fake-unbound-${randomUUID()}`,
      amountCents: 12_500,
      currency: 'USD',
      providerOccurredAt: new Date().toISOString(),
    } as const;
    const rawPayload = Buffer.from(JSON.stringify(payload), 'utf8');
    const receipt = await new PostgresProviderEventInboxRepository(db).recordAuthenticatedEvent({
      providerKind: 'FAKE',
      providerEventReference,
      providerEventKind: 'FINANCIAL_OPERATION_OBSERVED',
      operationId,
      ingressIdempotencyKey: `provider-event:${sha256(`FAKE\0${providerEventReference}`)}`,
      rawPayload,
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256(`test-auth:${providerEventReference}`),
        verifiedAt: new Date().toISOString(),
      },
    });

    await expect(
      new PostgresProviderObservationNormalizationRepository(db)
        .normalizeAuthenticatedObservation(receipt.observationId),
    ).rejects.toEqual(new ProviderObservationNormalizationError('AUTHORITY_REFUSED'));

    const preserved = await db.query<{
      raw_payload_sha256: string;
      normalization_count: number;
    }>(
      `SELECT observation.raw_payload_sha256,
              count(normalization.normalization_id)::integer AS normalization_count
         FROM public.provider_event_inbox_observations observation
         LEFT JOIN public.provider_financial_observation_normalizations normalization
           ON normalization.observation_id=observation.observation_id
        WHERE observation.observation_id=$1
        GROUP BY observation.raw_payload_sha256`,
      [receipt.observationId],
    );
    expect(preserved.rows[0]).toEqual({
      raw_payload_sha256: sha256(rawPayload),
      normalization_count: 0,
    });
  });
});
