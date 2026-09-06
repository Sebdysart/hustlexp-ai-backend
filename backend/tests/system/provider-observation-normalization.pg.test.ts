import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import { createUniversalV1DisposableDatabase } from '../helpers/universal-v1-disposable-database.js';
import { financialProviderOutcomeProjectionSha256 } from '../../src/jobs/financial-provider-command-recovery-worker.js';
import {
  canonicalFinancialProviderRequestSha256,
  prepareFinancialProviderCommand,
  type RecordFinancialProviderCommandInput,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import { PostgresFinancialProviderCommandRecoveryRepository } from '../../src/services/payment/FinancialProviderCommandRecovery.js';
import type { FinancialOperationResult } from '../../src/services/payment/FinancialProviderPorts.js';
import type { PrepareUniversalV1FinancialCommandInput } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { PostgresProviderEventInboxRepository } from '../../src/services/payment/ProviderEventInbox.js';
import {
  PostgresProviderObservationNormalizationRepository,
  ProviderObservationNormalizationError,
} from '../../src/services/payment/ProviderObservationNormalization.js';

const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
let fixture: Awaited<ReturnType<typeof createUniversalV1DisposableDatabase>>;
let db: Database;

// Historical normalization requires the original committed PREPARED/REQUESTED
// primitives. Current runtime commands require independent v13 actor provenance
// and are covered separately; this fixture never installs or bypasses that gate.
async function prepareHistoricalCommand(input: PrepareUniversalV1FinancialCommandInput) {
  return db.transaction(async (query) => {
    const result = await query<{ prepared_command_id: string; authority_context_sha256: string }>(
      `SELECT prepared_command_id,authority_context_sha256
         FROM public.hxos_prepare_universal_v1_financial_command_v1(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
         )`,
      [
        randomUUID(),
        input.operationKind,
        input.operationId,
        input.providerKind,
        input.idempotencyKey,
        input.providerExpectedVersion,
        input.lifecycleExpectedVersion,
        input.providerRequestSha256,
        input.taskDraftId,
        input.taskId,
        input.eligibilityDecisionId,
        input.scopeVersionId,
        input.changeOrderId,
        input.predecessorEventId,
        input.completionFactId,
        input.relatedOperationId,
        input.amountCents,
        input.currency,
        input.recordedBy,
      ]
    );
    expect(result.rowCount).toBe(1);
    const row = result.rows[0]!;
    expect(row.authority_context_sha256).toMatch(/^[a-f0-9]{64}$/u);
    return {
      preparedCommandId: row.prepared_command_id,
      authorityContextSha256: row.authority_context_sha256,
    };
  });
}

async function requestHistoricalCommand<T>(input: RecordFinancialProviderCommandInput<T>) {
  const command = prepareFinancialProviderCommand(input);
  return db.transaction(async (query) => {
    const result = await query<{ command_id: string }>(
      `SELECT command_id FROM public.hxos_record_financial_provider_command_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      )`,
      [
        randomUUID(),
        command.operationKind,
        command.operationId,
        command.providerKind,
        command.idempotencyKey,
        command.providerExpectedVersion,
        command.requestSha256,
        command.commandIdentitySha256,
        command.evidence.preparedFinancialCommandId,
        command.evidence.preparedAuthoritySha256,
        command.evidence.taskDraftId,
        command.evidence.taskId,
        command.evidence.workOrderId,
        command.evidence.relatedOperationId,
        command.evidence.amountCents,
        command.evidence.currency,
        command.actor?.actorId ?? null,
        command.actor?.actorKind ?? null,
        command.release?.manifestDigest ?? null,
        command.release?.releaseId ?? null,
        command.release?.revision ?? null,
        command.release?.environment ?? null,
        command.release?.authenticationStatus ?? null,
      ]
    );
    expect(result.rowCount).toBe(1);
    return { commandId: result.rows[0]!.command_id };
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

describePg('historical pre-v13 provider observation normalization authority', () => {
  beforeAll(async () => {
    fixture = await createUniversalV1DisposableDatabase({
      throughFinancialMigration: '20261015_universal_v1_work_order_bootstrap_seal_v1',
      canonicalMigrationLedger: true,
    });
    const query: QueryFn = async <Row>(sql: string, parameters?: unknown[]) => {
      const result = await fixture.pool.query(sql, parameters);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    };
    db = {
      query,
      readQuery: query,
      transaction: async <T>(work: (query: QueryFn) => Promise<T>): Promise<T> => {
        const client = await fixture.pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(async <Row>(sql: string, parameters?: unknown[]) => {
            const reply = await client.query(sql, parameters);
            return { rows: reply.rows as Row[], rowCount: reply.rowCount ?? 0 };
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    } as Database;
    await expect(
      db.query(
        `SELECT count(*)::int AS count FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN (
          'hxos_prepare_authenticated_fake_financial_command_v13',
          'hxos_request_fake_financial_command_v13')`
      )
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 120_000);
  afterAll(async () => {
    await fixture?.close();
  }, 30_000);
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
      [actorId, `provider-observation-${actorId}@example.invalid`]
    );
    await db.query(
      `INSERT INTO public.task_drafts(
         id, submission_id, card_token_hash, raw_input, universal_contract_version
       ) VALUES ($1, $2, $3, 'Provider observation PostgreSQL proof', 1)`,
      [taskDraftId, randomUUID(), `provider-observation-card-${randomUUID()}`]
    );

    const prepared = await prepareHistoricalCommand({
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
    const requested = await requestHistoricalCommand({
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
        `FAKE\0${prematurePayload.providerEventReference}`
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
      recordedAt: attempted.attemptedAt,
      expiresAt: null,
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
    await expect(
      db.query<{
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
        [outcome.outcomeFactId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          provider_result_sha256: expectedProviderResultSha256,
          provider_result_version: '1',
          amount_cents: null,
          currency: null,
          external_reference_sha256: sha256(externalReference),
        },
      ],
    });

    await expect(
      db.query(`SELECT public.normalize_financial_provider_observation_v1($1::uuid)`, [
        prematureReceipt.observationId,
      ])
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'authenticated observation receipt precedes DISPATCH_ATTEMPTED authority'
      ),
    });
    await expect(
      db.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM public.provider_financial_observation_normalizations
        WHERE observation_id=$1`,
        [prematureReceipt.observationId]
      )
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

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
        `FAKE\0${exactPayload.providerEventReference}`
      )}`,
      rawPayload: exactRawPayload,
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256(`test-auth:${exactPayload.providerEventReference}`),
        verifiedAt: new Date().toISOString(),
      },
    });

    const normalized = await new PostgresProviderObservationNormalizationRepository(
      db
    ).normalizeAuthenticatedObservation(receipt.observationId);
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
      [operationId]
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
        `FAKE\0${mismatchPayload.providerEventReference}`
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
      new PostgresProviderObservationNormalizationRepository(db).normalizeAuthenticatedObservation(
        mismatchReceipt.observationId
      )
    ).rejects.toEqual(new ProviderObservationNormalizationError('AUTHORITY_REFUSED'));
    await expect(
      db.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM public.provider_financial_observation_normalizations
        WHERE observation_id=$1`,
        [mismatchReceipt.observationId]
      )
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
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
      new PostgresProviderObservationNormalizationRepository(db).normalizeAuthenticatedObservation(
        receipt.observationId
      )
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
      [receipt.observationId]
    );
    expect(preserved.rows[0]).toEqual({
      raw_payload_sha256: sha256(rawPayload),
      normalization_count: 0,
    });
  });
});
