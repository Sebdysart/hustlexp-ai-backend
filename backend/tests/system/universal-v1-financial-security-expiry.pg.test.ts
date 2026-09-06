import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  FakeFinancialProvider,
  PostgresFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import { PostgresFinancialProviderCommandJournal } from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  DurableFakeFinancialProviderCommandCoordinator,
  PostgresFinancialProviderCommandRecoveryRepository,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';
import {
  LegacyFakeFinancialExpiryCompensationWorker,
  PostgresLegacyFakeFinancialExpiryCompensationRepository,
} from '../../src/services/payment/LegacyFakeFinancialExpiryCompensation.js';
import { PostgresUniversalV1PreparedFinancialCommandAuthority } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import {
  PostgresUniversalV1FinancialLifecycleRepository,
  UniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
} from '../../src/services/payment/UniversalV1FinancialApplicationService.js';

const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const describePg = describe.sequential.skipIf(databaseUrl.length === 0);

const recordedAt = '2020-01-01T00:00:00.123Z';
const expiresAt = '2020-01-01T00:15:00.123Z';
const amountCents = 1_000;
const currency = 'USD';
const externalReference = 'fake_authorize_0123456789abcdef01234567';

const ids = {
  user: '91000000-0000-4000-8000-000000000001',
  task: '91000000-0000-4000-8000-000000000002',
  draft: '91000000-0000-4000-8000-000000000003',
  route: '91000000-0000-4000-8000-000000000004',
  eligibility: '91000000-0000-4000-8000-000000000005',
  scope: '91000000-0000-4000-8000-000000000006',
  predecessorOperation: '91000000-0000-4000-8000-000000000010',
  predecessorEvent: '91000000-0000-4000-8000-000000000011',
  authorizeOperation: '91000000-0000-4000-8000-000000000012',
  authorizeEvent: '91000000-0000-4000-8000-000000000013',
  prepared: '91000000-0000-4000-8000-000000000014',
  command: '91000000-0000-4000-8000-000000000015',
  lease: '91000000-0000-4000-8000-000000000016',
  dispatch: '91000000-0000-4000-8000-000000000017',
  outcome: '91000000-0000-4000-8000-000000000018',
  fakeEvent: '91000000-0000-4000-8000-000000000019',
  bridge: '91000000-0000-4000-8000-000000000020',
  leaseOwner: '91000000-0000-4000-8000-000000000021',
  secureOperation: '91000000-0000-4000-8000-000000000022',
  securePrepared: '91000000-0000-4000-8000-000000000023',
  reversalOperation: '91000000-0000-4000-8000-000000000024',
  reversalPrepared: '91000000-0000-4000-8000-000000000025',
  interest: '91000000-0000-4000-8000-000000000031',
  hold: '91000000-0000-4000-8000-000000000032',
  workOrder: '91000000-0000-4000-8000-000000000033',
  revisedScope: '91000000-0000-4000-8000-000000000034',
  changeOrder: '91000000-0000-4000-8000-000000000035',
  customerApproval: '91000000-0000-4000-8000-000000000036',
  providerApproval: '91000000-0000-4000-8000-000000000037',
  providerUser: '91000000-0000-4000-8000-000000000049',
  securedOperation: '91000000-0000-4000-8000-000000000038',
  securedEvent: '91000000-0000-4000-8000-000000000039',
  adjustmentOperation: '91000000-0000-4000-8000-000000000040',
  adjustmentEvent: '91000000-0000-4000-8000-000000000041',
  amendment: '91000000-0000-4000-8000-000000000042',
  secureCommand: '91000000-0000-4000-8000-000000000043',
  secureLease: '91000000-0000-4000-8000-000000000044',
  secureAttempt: '91000000-0000-4000-8000-000000000045',
  reversalCommand: '91000000-0000-4000-8000-000000000046',
  reversalLease: '91000000-0000-4000-8000-000000000047',
  reversalAttempt: '91000000-0000-4000-8000-000000000048',
} as const;

interface PgFailure extends Error {
  readonly code?: string;
  readonly constraint?: string;
}

interface BridgeObservation {
  readonly provider_recorded_at: Date;
  readonly provider_expires_at: Date;
  readonly raw_recorded_at: Date;
  readonly raw_expires_at: Date;
  readonly lifecycle_occurred_at: Date;
  readonly lifecycle_expires_at: Date;
  readonly expiry_authority_sha256: string;
}

interface TimeZoneProof {
  readonly bridge: BridgeObservation;
  readonly expectedDigest: string;
  readonly secureFailure: PgFailure | null;
  readonly addressFailure: PgFailure | null;
  readonly dispatchFailure: PgFailure | null;
  readonly amendmentFailure: PgFailure | null;
  readonly reversalAttemptedAt: Date | null;
}

interface ApplicationAuthorityFixture {
  readonly userId: string;
  readonly taskId: string;
  readonly draftId: string;
  readonly routeId: string;
  readonly eligibilityId: string;
  readonly scopeId: string;
}

interface ApplicationFinancialCommands {
  readonly preparation: Extract<
    ExecuteUniversalV1FinancialEventCommand,
    { operationKind: 'PREPARE_PAYMENT_METHOD' }
  >;
  readonly authorization: Omit<
    Extract<ExecuteUniversalV1FinancialEventCommand, { operationKind: 'AUTHORIZE' }>,
    'predecessorEventId'
  >;
}

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    parsed.pathname !== '/hx_ci_system_test' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Financial-security expiry PG proof may run only on the exact disposable system database'
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function epochMicroseconds(value: string): bigint {
  return BigInt(Date.parse(value)) * 1_000n;
}

function canonicalExpiryDigest(): string {
  return sha256(
    `${ids.fakeEvent}:${ids.authorizeEvent}:${epochMicroseconds(recordedAt)}` +
      `:${epochMicroseconds(expiresAt)}`
  );
}

function applicationAuthorityFixture(): ApplicationAuthorityFixture {
  return {
    userId: randomUUID(),
    taskId: randomUUID(),
    draftId: randomUUID(),
    routeId: randomUUID(),
    eligibilityId: randomUUID(),
    scopeId: randomUUID(),
  };
}

function applicationFinancialCommands(
  fixture: ApplicationAuthorityFixture
): ApplicationFinancialCommands {
  const preparationOperationId = randomUUID();
  const authorizationOperationId = randomUUID();
  const suffix = randomUUID();
  return {
    preparation: {
      operationKind: 'PREPARE_PAYMENT_METHOD',
      providerKind: 'FAKE',
      operationId: preparationOperationId,
      idempotencyKey: `expiry-app-prepare:${suffix}`,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 0,
      taskDraftId: fixture.draftId,
      taskId: fixture.taskId,
      eligibilityDecisionId: fixture.eligibilityId,
      scopeVersionId: fixture.scopeId,
      recordedBy: fixture.userId,
      occurredAt: new Date().toISOString(),
      customerId: `synthetic-expiry-customer-${fixture.userId}`,
    },
    authorization: {
      operationKind: 'AUTHORIZE',
      providerKind: 'FAKE',
      operationId: authorizationOperationId,
      idempotencyKey: `expiry-app-authorize:${suffix}`,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 1,
      taskDraftId: fixture.draftId,
      taskId: fixture.taskId,
      eligibilityDecisionId: fixture.eligibilityId,
      scopeVersionId: fixture.scopeId,
      relatedOperationId: preparationOperationId,
      amountCents,
      currency: currency.toLowerCase(),
      recordedBy: fixture.userId,
      occurredAt: new Date().toISOString(),
      paymentMethodReference: `fake-payment-method-${fixture.userId}`,
    },
  };
}

function clientDatabase(client: pg.Client): Database {
  const query: QueryFn = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    const result = await client.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    };
  };
  let savepointSequence = 0;
  let transactionTail = Promise.resolve();
  const transaction = async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
    const previous = transactionTail;
    let releaseTransaction: () => void = () => undefined;
    transactionTail = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previous;
    savepointSequence += 1;
    const savepoint = `expiry_application_${savepointSequence}`;
    try {
      await client.query(`SAVEPOINT ${savepoint}`);
      const result = await fn(query);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      releaseTransaction();
    }
  };

  return {
    query,
    readQuery: query,
    transaction,
    serializableTransaction: transaction,
    healthCheck: async () => ({ connected: true, schemaVersion: null, latencyMs: 0 }),
    getPool: () => {
      throw new Error('Rollback-only client database does not expose a pool');
    },
    getPoolStats: () => ({
      totalConnections: 1,
      idleConnections: 0,
      waitingRequests: 0,
      maxConnections: 1,
      utilizationPercent: 100,
      replicaConnections: null,
    }),
    close: async () => undefined,
  };
}

function fakeFinancialHarness(
  database: Database,
  coordinatorOptions: {
    readonly leaseDurationSeconds?: number;
    readonly outcomeTimeoutSeconds?: number;
    readonly recoveryDelaySeconds?: number;
  } = {}
) {
  const fakeEvents = new PostgresFakeFinancialOperationRepository(database);
  const provider = new FakeFinancialProvider(fakeEvents);
  const coordinator = new DurableFakeFinancialProviderCommandCoordinator(
    new PostgresFinancialProviderCommandRecoveryRepository(database),
    fakeEvents,
    { leaseOwnerId: randomUUID(), ...coordinatorOptions }
  );
  const service = new UniversalV1FakeFinancialApplicationService(
    provider,
    new PostgresUniversalV1FinancialLifecycleRepository(database),
    { assertAuthorized: () => undefined },
    new PostgresFinancialProviderCommandJournal(database),
    new PostgresUniversalV1PreparedFinancialCommandAuthority(database),
    coordinator
  );
  return { fakeEvents, provider, service };
}

async function seedApplicationAuthority(
  client: pg.Client,
  fixture: ApplicationAuthorityFixture
): Promise<void> {
  const suffix = fixture.draftId.replaceAll('-', '');
  await client.query(
    `INSERT INTO public.users(
       id, firebase_uid, email, full_name, default_mode, date_of_birth, is_minor
     ) VALUES ($1, $2, $3, 'Application Expiry PG Proof', 'poster',
               DATE '1990-01-01', FALSE)`,
    [fixture.userId, `firebase-${fixture.userId}`, `${fixture.userId}@example.invalid`]
  );
  await client.query(
    `INSERT INTO public.tasks(
       id, poster_id, title, description, price, automation_classification,
       hustler_payout_cents, platform_margin_cents, active_scope_version_id,
       currency, universal_contract_version, payment_method,
       universal_payment_posture
     ) VALUES (
       $1, $2, 'Application financial expiry proof',
       'Synthetic rollback-only application path fixture.', $3,
       'CONTROLLED_TEST', 800, 200, $4, $5, 1,
       'universal_financial_security', 'PAYMENT_CREATION_FROZEN'
     )`,
    [fixture.taskId, fixture.userId, amountCents, fixture.scopeId, currency]
  );
  await client.query(
    `INSERT INTO public.task_drafts(
       id, submission_id, card_token_hash, category, raw_input,
       poster_user_id, task_id, universal_contract_version
     ) VALUES (
       $1, $2, repeat('a', 64), 'yard',
       'Synthetic application financial expiry PostgreSQL proof', $3, $4, 1
     )`,
    [fixture.draftId, randomUUID(), fixture.userId, fixture.taskId]
  );
  await client.query(
    `INSERT INTO public.task_scope_versions(
       id, task_id, version, scope_hash, title, description, checklist,
       customer_total_cents, hustler_payout_cents, source, change_summary,
       created_by, universal_contract_version, currency
     ) VALUES (
       $1, $2, 1, repeat('7', 64), 'Application expiry scope',
       'Rollback-only application scope for PostgreSQL authority proof.',
       '[]'::jsonb, $3, 800, 'INITIAL', 'Initial synthetic scope', $4, 1, $5
     )`,
    [fixture.scopeId, fixture.taskId, amountCents, fixture.userId, currency]
  );
  await client.query(
    `INSERT INTO public.task_routing_decisions(
       id, task_draft_id, decision_version, outcome, reason_codes,
       policy_version, category_snapshot, decision_authority, idempotency_key
     ) VALUES (
       $1, $2, 1, 'FULFILLMENT_CANDIDATE', ARRAY['SYNTHETIC_EXPIRY_PROOF'],
       'financial-expiry-pg-v1', 'yard', 'DETERMINISTIC_POLICY', $3
     )`,
    [fixture.routeId, fixture.draftId, `expiry-app-route:${suffix}`]
  );
  await client.query(
    `INSERT INTO public.task_provider_eligibility_decisions(
       id, task_draft_id, task_id, scope_version_id, routing_decision_id,
       decision_version, provider_user_id, provider_class,
       profile_eligible, identity_eligible, category_eligible,
       credential_eligible, geography_eligible, availability_eligible,
       restriction_clear, task_eligible, processor_payment_eligible,
       payout_funding_eligible, trust_tier, policy_version, decided_by,
       idempotency_key, evaluated_at, valid_until
     ) VALUES (
       $1, $2, $3, $4, $5, 1, $6, 'GENERAL_SERVICE_PROVIDER',
       TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE,
       'TIER_1', 'financial-expiry-pg-v1', $6, $7,
       clock_timestamp(), TIMESTAMPTZ '2040-01-01 00:00:00Z'
     )`,
    [
      fixture.eligibilityId,
      fixture.draftId,
      fixture.taskId,
      fixture.scopeId,
      fixture.routeId,
      fixture.userId,
      `expiry-app-eligibility:${suffix}`,
    ]
  );
}

async function captureSavepointFailure(
  client: pg.Client,
  savepoint: string,
  action: () => Promise<unknown>
): Promise<PgFailure> {
  await client.query(`SAVEPOINT ${savepoint}`);
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  if (!(failure instanceof Error)) {
    throw new Error(`Expected ${savepoint} to reject`);
  }
  return failure as PgFailure;
}

async function captureFailure(action: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof Error)) {
    throw new Error('Expected action to reject');
  }
  return failure;
}

async function insertRawOnlyLegacyTerminalOutcome(
  client: pg.Client,
  idempotencyKey: string,
  observationIdempotencyKey: string,
  outcomeKind: 'FAILED' | 'OUTCOME_OBSERVED'
): Promise<void> {
  const inserted = await client.query(
    `WITH authority AS MATERIALIZED (
       SELECT command.command_id,
              command.operation_id,
              command.operation_kind,
              command.provider_kind,
              command.amount_cents,
              command.currency,
              attempt.dispatch_attempt_id,
              attempt.recovery_lease_id,
              raw.state AS provider_state,
              raw.event_version AS provider_result_version,
              encode(digest(raw.external_reference, 'sha256'), 'hex')
                AS external_reference_sha256
         FROM public.financial_provider_command_journal command
         JOIN public.financial_provider_command_dispatch_attempts attempt
           ON attempt.command_id = command.command_id
         JOIN public.hxos_fake_financial_operation_events_v1 raw
           ON raw.idempotency_key = command.idempotency_key
        WHERE command.idempotency_key = $1
        ORDER BY attempt.attempt_number DESC
        LIMIT 1
     )
     INSERT INTO public.financial_provider_command_outcome_facts(
       command_id, dispatch_attempt_id, recovery_lease_id, outcome_kind,
       observation_idempotency_key, provider_result_sha256, provider_state,
       provider_result_version, amount_cents, currency,
       external_reference_sha256, effect_certainty, retryable, failure_code
     )
     SELECT authority.command_id,
            authority.dispatch_attempt_id,
            authority.recovery_lease_id,
            $3::TEXT,
            $2,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED' THEN
              encode(
                digest(
                  authority.operation_id::TEXT || ':' ||
                  authority.operation_kind || ':' ||
                  authority.provider_kind || ':' ||
                  authority.provider_state || ':' ||
                  authority.provider_result_version::TEXT || ':' ||
                  authority.amount_cents::TEXT || ':' ||
                  authority.currency || ':' ||
                  authority.external_reference_sha256 || ':false',
                  'sha256'
                ),
                'hex'
              )
            ELSE NULL END,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED'
              THEN authority.provider_state ELSE NULL END,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED'
              THEN authority.provider_result_version ELSE NULL END,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED'
              THEN authority.amount_cents ELSE NULL END,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED'
              THEN authority.currency ELSE NULL END,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED'
              THEN authority.external_reference_sha256 ELSE NULL END,
            CASE WHEN $3::TEXT = 'OUTCOME_OBSERVED'
              THEN 'CONFIRMED_EFFECT' ELSE 'CONFIRMED_NO_EFFECT' END,
            FALSE,
            CASE WHEN $3::TEXT = 'FAILED'
              THEN 'LEGACY_RAW_SUCCESS_CONTRADICTION' ELSE NULL END
       FROM authority
     RETURNING outcome_fact_id`,
    [idempotencyKey, observationIdempotencyKey, outcomeKind]
  );
  if (inserted.rowCount !== 1) {
    throw new Error('Expected exact raw-only terminal outcome authority');
  }
}

async function seedBridgeAuthority(client: pg.Client): Promise<void> {
  const requestSha256 = 'b'.repeat(64);
  const externalReferenceSha256 = sha256(externalReference);
  const providerResultSha256 = sha256(
    `${ids.authorizeOperation}:AUTHORIZE:FAKE:SUCCEEDED:1:${amountCents}` +
      `:${currency}:${externalReferenceSha256}:false`
  );

  await client.query(
    `INSERT INTO public.users(
       id, firebase_uid, email, full_name, default_mode, date_of_birth, is_minor
     ) VALUES ($1, $2, $3, 'Financial Expiry PG Proof', 'poster', DATE '1990-01-01', FALSE)`,
    [ids.user, `firebase-${ids.user}`, `${ids.user}@example.invalid`]
  );
  await client.query(
    `INSERT INTO public.tasks(
       id, poster_id, title, description, price, automation_classification,
       hustler_payout_cents, platform_margin_cents, active_scope_version_id,
       currency, universal_contract_version, payment_method,
       universal_payment_posture
     ) VALUES (
       $1, $2, 'Expired financial authority proof',
       'Synthetic rollback-only PostgreSQL authority fixture.', $3,
       'CONTROLLED_TEST', 800, 200, $4, $5, 1,
       'universal_financial_security', 'PAYMENT_CREATION_FROZEN'
     )`,
    [ids.task, ids.user, amountCents, ids.scope, currency]
  );
  await client.query(
    `INSERT INTO public.task_drafts(
       id, submission_id, card_token_hash, category, raw_input,
       poster_user_id, task_id, universal_contract_version
     ) VALUES (
       $1, $2, repeat('a', 64), 'yard',
       'Synthetic financial expiry PostgreSQL proof', $3, $4, 1
     )`,
    [ids.draft, '91000000-0000-4000-8000-000000000030', ids.user, ids.task]
  );
  await client.query(
    `INSERT INTO public.task_scope_versions(
       id, task_id, version, scope_hash, title, description, checklist,
       customer_total_cents, hustler_payout_cents, source, change_summary,
       created_by, universal_contract_version, currency
     ) VALUES (
       $1, $2, 1, repeat('7', 64), 'Synthetic expiry scope',
       'Rollback-only scope for PostgreSQL authority proof.', '[]'::jsonb,
       $3, 800, 'INITIAL', 'Initial synthetic scope', $4, 1, $5
     )`,
    [ids.scope, ids.task, amountCents, ids.user, currency]
  );
  await client.query(
    `INSERT INTO public.task_routing_decisions(
       id, task_draft_id, decision_version, outcome, reason_codes,
       policy_version, category_snapshot, decision_authority,
       idempotency_key
     ) VALUES (
       $1, $2, 1, 'FULFILLMENT_CANDIDATE', ARRAY['SYNTHETIC_EXPIRY_PROOF'],
       'financial-expiry-pg-v1', 'yard', 'DETERMINISTIC_POLICY',
       'expiry-proof-route-0001'
     )`,
    [ids.route, ids.draft]
  );
  await client.query(
    `INSERT INTO public.task_provider_eligibility_decisions(
       id, task_draft_id, task_id, scope_version_id, routing_decision_id,
       decision_version, provider_user_id, provider_class,
       profile_eligible, identity_eligible, category_eligible,
       credential_eligible, geography_eligible, availability_eligible,
       restriction_clear, task_eligible, processor_payment_eligible,
       payout_funding_eligible, trust_tier, policy_version, decided_by,
       idempotency_key, evaluated_at, valid_until
     ) VALUES (
       $1, $2, $3, $4, $5, 1, $6, 'GENERAL_SERVICE_PROVIDER',
       TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE,
       'TIER_1', 'financial-expiry-pg-v1', $6,
       'expiry-proof-eligibility-0001', TIMESTAMPTZ '2019-01-01 00:00:00Z',
       TIMESTAMPTZ '2040-01-01 00:00:00Z'
     )`,
    [ids.eligibility, ids.draft, ids.task, ids.scope, ids.route, ids.user]
  );
  await client.query(
    `INSERT INTO public.task_financial_operations(
       operation_id, task_draft_id, task_id, eligibility_decision_id,
       scope_version_id, event_kind, provider_kind
     ) VALUES ($1, $2, $3, $4, $5, 'PAYMENT_METHOD_PREPARED', 'FAKE')`,
    [ids.predecessorOperation, ids.draft, ids.task, ids.eligibility, ids.scope]
  );
  await client.query(
    `INSERT INTO public.task_financial_operations(
       operation_id, task_draft_id, task_id, eligibility_decision_id,
       scope_version_id, event_kind, provider_kind, external_reference,
       amount_cents, currency
     ) VALUES ($1, $2, $3, $4, $5, 'AUTHORIZED', 'FAKE', $6, $7, $8)`,
    [
      ids.authorizeOperation,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      externalReference,
      amountCents,
      currency,
    ]
  );
  await client.query(
    `INSERT INTO public.task_financial_security_events(
       id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
       event_kind, status, operation_id, idempotency_key, expected_version,
       provider_kind, evidence, recorded_by, occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'PAYMENT_METHOD_PREPARED', 'SUCCEEDED', $6,
       'expiry-proof-prepare-0001', 0, 'FAKE',
       '{"providerState":"SUCCEEDED","providerOperationVersion":1}'::jsonb,
       $7, $8
     )`,
    [
      ids.predecessorEvent,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      ids.predecessorOperation,
      ids.user,
      recordedAt,
    ]
  );
  await client.query(
    `INSERT INTO public.task_financial_security_events(
       id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
       predecessor_event_id, event_kind, status, operation_id,
       idempotency_key, expected_version, provider_kind, external_reference,
       amount_cents, currency, evidence, recorded_by, occurred_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'AUTHORIZED', 'SUCCEEDED', $7,
       'expiry-proof-authorize-0001', 1, 'FAKE', $8, $9, $10,
       '{"providerState":"SUCCEEDED","providerOperationVersion":1}'::jsonb,
       $11, $12, $13
     )`,
    [
      ids.authorizeEvent,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      ids.predecessorEvent,
      ids.authorizeOperation,
      externalReference,
      amountCents,
      currency,
      ids.user,
      recordedAt,
      expiresAt,
    ]
  );
  await client.query(
    `INSERT INTO public.universal_v1_prepared_financial_commands(
       prepared_command_id, operation_kind, event_kind, operation_id,
       provider_kind, idempotency_key, provider_expected_version,
       lifecycle_expected_version, provider_request_sha256, task_draft_id,
       task_id, eligibility_decision_id, eligibility_decision_version,
       eligibility_valid_until, scope_version_id, scope_version, scope_hash,
       predecessor_event_id, predecessor_operation_id, predecessor_event_kind,
       predecessor_status, predecessor_lifecycle_version,
       related_operation_id, amount_cents, currency, recorded_by, occurred_at,
       request_identity_sha256, authority_context_sha256, prepared_at
     ) VALUES (
       $1, 'AUTHORIZE', 'AUTHORIZED', $2, 'FAKE',
       'expiry-proof-authorize-0001', 0, 1, $3, $4, $5, $6, 1,
       TIMESTAMPTZ '2040-01-01 00:00:00Z', $7, 1, repeat('7', 64),
       $8, $9, 'PAYMENT_METHOD_PREPARED', 'SUCCEEDED', 0, $9, $10, $11,
       $12, $13, repeat('f', 64), repeat('1', 64), $13
     )`,
    [
      ids.prepared,
      ids.authorizeOperation,
      requestSha256,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      ids.predecessorEvent,
      ids.predecessorOperation,
      amountCents,
      currency,
      ids.user,
      recordedAt,
    ]
  );
  await client.query(
    `INSERT INTO public.financial_provider_command_journal(
       command_id, operation_kind, operation_id, provider_kind,
       idempotency_key, provider_expected_version, request_sha256,
       command_identity_sha256, task_draft_id, task_id, related_operation_id,
       amount_cents, currency, recorded_actor_id, recorded_actor_kind,
       recorded_at, prepared_financial_command_id, prepared_authority_sha256
     ) VALUES (
       $1, 'AUTHORIZE', $2, 'FAKE', 'expiry-proof-authorize-0001', 0, $3,
       repeat('e', 64), $4, $5, $6, $7, $8, $9, 'PARTICIPANT', $10,
       $11, repeat('1', 64)
     )`,
    [
      ids.command,
      ids.authorizeOperation,
      requestSha256,
      ids.draft,
      ids.task,
      ids.predecessorOperation,
      amountCents,
      currency,
      ids.user,
      recordedAt,
      ids.prepared,
    ]
  );
  await client.query(
    `INSERT INTO public.financial_provider_command_recovery_leases(
       recovery_lease_id, command_id, recovery_action, lease_owner_id,
       lease_duration_seconds, acquired_at, expires_at
     ) VALUES ($1, $2, 'DISPATCH', $3, 60, $4, $4::timestamptz + INTERVAL '60 seconds')`,
    [ids.lease, ids.command, ids.leaseOwner, recordedAt]
  );
  await client.query(
    `INSERT INTO public.financial_provider_command_dispatch_attempts(
       dispatch_attempt_id, command_id, recovery_lease_id, attempt_number,
       request_sha256, outcome_timeout_seconds, attempted_at,
       outcome_deadline_at
     ) VALUES (
       $1, $2, $3, 1, $4, 60, $5, $5::timestamptz + INTERVAL '60 seconds'
     )`,
    [ids.dispatch, ids.command, ids.lease, requestSha256, recordedAt]
  );
  await client.query(
    `INSERT INTO public.financial_provider_command_outcome_facts(
       outcome_fact_id, command_id, dispatch_attempt_id, recovery_lease_id,
       outcome_kind, observation_idempotency_key, provider_result_sha256,
       provider_state, provider_result_version, amount_cents, currency,
       external_reference_sha256, effect_certainty, retryable, recorded_at
     ) VALUES (
       $1, $2, $3, $4, 'OUTCOME_OBSERVED',
       'expiry-proof-outcome-0001', $5, 'SUCCEEDED', 1, $6, $7, $8,
       'CONFIRMED_EFFECT', FALSE, $9
     )`,
    [
      ids.outcome,
      ids.command,
      ids.dispatch,
      ids.lease,
      providerResultSha256,
      amountCents,
      currency,
      externalReferenceSha256,
      recordedAt,
    ]
  );
  await client.query(
    `INSERT INTO public.hxos_fake_financial_operations_v1(
       operation_id, operation_kind, identity_sha256, external_reference,
       amount_cents, currency, related_operation_id, created_at
     ) VALUES ($1, 'AUTHORIZE', repeat('a', 64), $2, $3, 'usd', $4, $5)`,
    [ids.authorizeOperation, externalReference, amountCents, ids.predecessorOperation, recordedAt]
  );
  await client.query(
    `INSERT INTO public.hxos_fake_financial_operation_events_v1(
       event_id, operation_id, operation_kind, event_version, state, scenario,
       amount_cents, currency, related_operation_id, external_reference,
       idempotency_key, identity_sha256, request_sha256, response_sha256,
       retryable, metadata, recorded_at, provider_request_sha256, expires_at
     ) VALUES (
       $1, $2, 'AUTHORIZE', 1, 'SUCCEEDED', 'SUCCESS', $3, 'usd', $4, $5,
       'expiry-proof-authorize-0001', repeat('a', 64), repeat('c', 64),
       repeat('d', 64), FALSE, '{}'::jsonb, $6, $7, $8
     )`,
    [
      ids.fakeEvent,
      ids.authorizeOperation,
      amountCents,
      ids.predecessorOperation,
      externalReference,
      recordedAt,
      requestSha256,
      expiresAt,
    ]
  );
}

async function seedHistoricalNullExpiryBridge(
  client: pg.Client,
  mismatchProviderTime: boolean
): Promise<void> {
  await client.query(
    `ALTER TABLE public.hxos_fake_financial_operation_events_v1
       DROP CONSTRAINT hxos_fake_financial_event_expiry_v9_chk`
  );
  await client.query(
    `ALTER TABLE public.task_financial_security_events
       DROP CONSTRAINT task_financial_security_events_expiry_v1_chk`
  );
  await client.query(`SET LOCAL session_replication_role = 'replica'`);
  await seedBridgeAuthority(client);
  await client.query(`SET LOCAL session_replication_role = 'origin'`);
  await client.query(
    `INSERT INTO public.universal_v1_fake_financial_lifecycle_bridges(
       bridge_id, prepared_command_id, command_id, dispatch_attempt_id,
       outcome_fact_id, fake_operation_event_id,
       task_financial_security_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ids.bridge,
      ids.prepared,
      ids.command,
      ids.dispatch,
      ids.outcome,
      ids.fakeEvent,
      ids.authorizeEvent,
    ]
  );
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query(`SET LOCAL session_replication_role = 'replica'`);
  await client.query(
    `UPDATE public.hxos_fake_financial_operation_events_v1
        SET expires_at = NULL
      WHERE event_id = $1`,
    [ids.fakeEvent]
  );
  await client.query(
    `UPDATE public.task_financial_security_events
        SET occurred_at = occurred_at + $2::INTERVAL,
            expires_at = NULL
      WHERE id = $1`,
    [ids.authorizeEvent, mismatchProviderTime ? '1 millisecond' : '0 milliseconds']
  );
  await client.query(
    `UPDATE public.universal_v1_fake_financial_lifecycle_bridges
        SET provider_recorded_at = NULL,
            provider_expires_at = NULL,
            expiry_authority_sha256 = NULL
      WHERE bridge_id = $1`,
    [ids.bridge]
  );
  await client.query(`SET LOCAL session_replication_role = 'origin'`);
  await client.query(
    `ALTER TABLE public.task_financial_security_events
       ADD CONSTRAINT task_financial_security_events_expiry_v1_chk CHECK (
         (
           status = 'SUCCEEDED'
           AND event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED')
           AND expires_at IS NOT NULL
           AND expires_at > occurred_at
         )
         OR
         (
           NOT (
             status = 'SUCCEEDED'
             AND event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED')
           )
           AND expires_at IS NULL
         )
       ) NOT VALID`
  );
}

async function seedExpiredWorkOrder(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO public.task_applications(
       id, task_id, hustler_id, status, universal_contract_version
     ) VALUES ($1, $2, $3, 'pending', 0)`,
    [ids.interest, ids.task, ids.user]
  );
  await client.query(
    `INSERT INTO public.task_reservations(
       id, task_id, hustler_id, status, reserved_by, universal_contract_version
     ) VALUES ($1, $2, $3, 'ACTIVE', $3, 0)`,
    [ids.hold, ids.task, ids.user]
  );
  await client.query(
    `INSERT INTO public.task_financial_operations(
       operation_id, task_draft_id, task_id, eligibility_decision_id,
       scope_version_id, event_kind, provider_kind, external_reference,
       amount_cents, currency
     ) VALUES (
       $1, $2, $3, $4, $5, 'SECURED', 'FAKE',
       'fake_secure_0123456789abcdef01234567', $6, $7
     )`,
    [ids.securedOperation, ids.draft, ids.task, ids.eligibility, ids.scope, amountCents, currency]
  );
  await client.query(
    `INSERT INTO public.task_financial_security_events(
       id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
       predecessor_event_id, event_kind, status, operation_id,
       idempotency_key, expected_version, provider_kind, external_reference,
       amount_cents, currency, evidence, recorded_by, occurred_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'SECURED', 'SUCCEEDED', $7,
       'expiry-proof-secured-0001', 2, 'FAKE',
       'fake_secure_0123456789abcdef01234567', $8, $9,
       '{"providerState":"SUCCEEDED","providerOperationVersion":1}'::jsonb,
       $10, $11, $12
     )`,
    [
      ids.securedEvent,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      ids.authorizeEvent,
      ids.securedOperation,
      amountCents,
      currency,
      ids.user,
      recordedAt,
      expiresAt,
    ]
  );
  await client.query(
    `INSERT INTO public.task_work_orders(
       id, task_draft_id, task_id, scope_version_id, routing_decision_id,
       interest_application_id, eligibility_decision_id, conditional_hold_id,
       financial_security_event_id, provider_user_id,
       materialization_version, idempotency_key, materialized_by,
       materialized_at, execution_contract_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1,
       'expiry-proof-work-order-0001', $10, $11, 0
     )`,
    [
      ids.workOrder,
      ids.draft,
      ids.task,
      ids.scope,
      ids.route,
      ids.interest,
      ids.eligibility,
      ids.hold,
      ids.securedEvent,
      ids.user,
      recordedAt,
    ]
  );
  await client.query(
    `UPDATE public.tasks
        SET work_order_id = $1
      WHERE id = $2`,
    [ids.workOrder, ids.task]
  );
}

async function seedDispatchCommand(
  client: pg.Client,
  input: {
    readonly operationKind: 'SECURE' | 'REVERSAL';
    readonly eventKind: 'SECURED' | 'REVERSED';
    readonly operationId: string;
    readonly preparedCommandId: string;
    readonly commandId: string;
    readonly leaseId: string;
    readonly predecessorEventId: string;
    readonly predecessorOperationId: string;
    readonly lifecycleExpectedVersion: number;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO public.universal_v1_prepared_financial_commands(
       prepared_command_id, operation_kind, event_kind, operation_id,
       provider_kind, idempotency_key, provider_expected_version,
       lifecycle_expected_version, provider_request_sha256, task_draft_id,
       task_id, eligibility_decision_id, eligibility_decision_version,
       eligibility_valid_until, scope_version_id, scope_version, scope_hash,
       work_order_id, work_order_materialization_version,
       work_order_execution_contract_version, predecessor_event_id,
       predecessor_operation_id, predecessor_event_kind, predecessor_status,
       predecessor_lifecycle_version, related_operation_id, amount_cents,
       currency, recorded_by, request_identity_sha256,
       authority_context_sha256
     ) VALUES (
       $1, $2, $3, $4, 'FAKE', $5, 0, $6, $7, $8, $9, $10, 1,
       TIMESTAMPTZ '2040-01-01 00:00:00Z', $11, 1, repeat('7', 64),
       $12, 1, 0, $13, $14, $15, 'SUCCEEDED', $16, $14, $17, $18, $19,
       repeat('3', 64), repeat('4', 64)
     )`,
    [
      input.preparedCommandId,
      input.operationKind,
      input.eventKind,
      input.operationId,
      input.idempotencyKey,
      input.lifecycleExpectedVersion,
      input.requestSha256,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      ids.workOrder,
      input.predecessorEventId,
      input.predecessorOperationId,
      input.eventKind === 'SECURED' ? 'AUTHORIZED' : 'SECURED',
      input.lifecycleExpectedVersion - 1,
      amountCents,
      currency,
      ids.user,
    ]
  );
  await client.query(
    `INSERT INTO public.financial_provider_command_journal(
       command_id, operation_kind, operation_id, provider_kind,
       idempotency_key, provider_expected_version, request_sha256,
       command_identity_sha256, task_draft_id, task_id, work_order_id,
       related_operation_id, amount_cents, currency, recorded_actor_id,
       recorded_actor_kind, prepared_financial_command_id,
       prepared_authority_sha256
     ) VALUES (
       $1, $2, $3, 'FAKE', $4, 0, $5, repeat('5', 64), $6, $7, $8, $9,
       $10, $11, $12, 'PARTICIPANT', $13, repeat('4', 64)
     )`,
    [
      input.commandId,
      input.operationKind,
      input.operationId,
      input.idempotencyKey,
      input.requestSha256,
      ids.draft,
      ids.task,
      ids.workOrder,
      input.predecessorOperationId,
      amountCents,
      currency,
      ids.user,
      input.preparedCommandId,
    ]
  );
  await client.query(
    `WITH observation AS (SELECT clock_timestamp() AS observed_at)
     INSERT INTO public.financial_provider_command_recovery_leases(
       recovery_lease_id, command_id, recovery_action, lease_owner_id,
       lease_duration_seconds, acquired_at, expires_at
     )
     SELECT $1, $2, 'DISPATCH', $3, 300, observed_at,
            observed_at + INTERVAL '300 seconds'
       FROM observation`,
    [input.leaseId, input.commandId, ids.leaseOwner]
  );
}

async function seedExpiredAmendmentAuthority(client: pg.Client): Promise<void> {
  const revisedAmountCents = 1_200;
  const revisedTitle = 'Revised synthetic expiry scope';
  const revisedDescription = 'Approved synthetic price-and-scope amendment for expiry proof.';
  const revisedChangeSummary = 'Approved synthetic scope increase';
  await client.query(
    `INSERT INTO public.users(
       id, firebase_uid, email, full_name, default_mode, date_of_birth, is_minor
     ) VALUES ($1, $2, $3, 'Independent Provider Approver', 'worker',
               DATE '1990-01-01', FALSE)`,
    [ids.providerUser, `firebase-${ids.providerUser}`, `${ids.providerUser}@example.invalid`]
  );
  await client.query(
    `INSERT INTO public.task_scope_versions(
       id, task_id, version, scope_hash, title, description, checklist,
       customer_total_cents, hustler_payout_cents, source, change_summary,
       created_by, supersedes_version_id, universal_contract_version, currency
     ) VALUES (
       $1, $2, 2, repeat('8', 64), $3, $4,
       '[]'::jsonb, $5, 900, 'APPROVED_CHANGE', $6, $7, $8, 1, $9
     )`,
    [
      ids.revisedScope,
      ids.task,
      revisedTitle,
      revisedDescription,
      revisedAmountCents,
      revisedChangeSummary,
      ids.user,
      ids.scope,
      currency,
    ]
  );
  await client.query(
    `INSERT INTO public.task_scope_change_proposals(
       id, task_id, base_version_id, proposed_by, proposer_role,
       observed_scope_summary, proposed_checklist, status, reviewed_by,
       reviewed_at, decision_reason, approved_version_id,
       universal_contract_version, proposal_version, change_order_kind,
       proposed_customer_total_cents, financial_adjustment_required,
       application_contract_version, proposed_title, proposed_description,
       proposed_provider_payout_cents, proposed_scope_sha256,
       idempotency_key, request_sha256
     ) VALUES (
       $1, $2, $3, $4, 'POSTER', $5,
       '[]'::jsonb, 'APPROVED', $4, clock_timestamp(), 'Synthetic approval',
       $6, 1, 1, 'PRICE_AND_SCOPE', $7, TRUE, 1, $8, $9, 900,
       repeat('8', 64), 'expiry-proof-change-order-0001', repeat('a', 64)
     )`,
    [
      ids.changeOrder,
      ids.task,
      ids.scope,
      ids.user,
      revisedChangeSummary,
      ids.revisedScope,
      revisedAmountCents,
      revisedTitle,
      revisedDescription,
    ]
  );
  await client.query(
    `INSERT INTO public.task_scope_change_approvals(
       id, proposal_id, approver_role, decision, actor_id,
       expected_proposal_version, reason, idempotency_key
     ) VALUES
       ($1, $3, 'CUSTOMER', 'APPROVED', $4, 1, 'Synthetic customer approval',
        'expiry-proof-customer-approval-0001'),
       ($2, $3, 'PROVIDER', 'APPROVED', $5, 1, 'Synthetic provider approval',
        'expiry-proof-provider-approval-0001')`,
    [ids.customerApproval, ids.providerApproval, ids.changeOrder, ids.user, ids.providerUser]
  );
  await client.query(
    `INSERT INTO public.task_financial_operations(
       operation_id, task_draft_id, task_id, eligibility_decision_id,
       scope_version_id, change_order_id, event_kind, provider_kind,
       external_reference, amount_cents, currency
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'ADJUSTMENT_AUTHORIZED', 'FAKE',
       'fake_adjust_0123456789abcdef01234567', $7, $8
     )`,
    [
      ids.adjustmentOperation,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.revisedScope,
      ids.changeOrder,
      revisedAmountCents,
      currency,
    ]
  );
  await client.query(
    `INSERT INTO public.task_financial_security_events(
       id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
       change_order_id, predecessor_event_id, event_kind, status, operation_id,
       idempotency_key, expected_version, provider_kind, external_reference,
       amount_cents, currency, evidence, recorded_by, occurred_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'ADJUSTMENT_AUTHORIZED', 'SUCCEEDED', $8,
       'expiry-proof-adjustment-0001', 3, 'FAKE',
       'fake_adjust_0123456789abcdef01234567', $9, $10,
       '{"providerState":"SUCCEEDED","providerOperationVersion":1}'::jsonb,
       $11, $12, $13
     )`,
    [
      ids.adjustmentEvent,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.revisedScope,
      ids.changeOrder,
      ids.securedEvent,
      ids.adjustmentOperation,
      revisedAmountCents,
      currency,
      ids.user,
      recordedAt,
      expiresAt,
    ]
  );
  await client.query(
    `UPDATE public.tasks
        SET active_scope_version_id = $1,
            scope_hash = repeat('8', 64),
            title = $2,
            description = $3,
            requirements = NULL,
            price = $4,
            hustler_payout_cents = 900,
            platform_margin_cents = 300,
            currency = $5
      WHERE id = $6`,
    [ids.revisedScope, revisedTitle, revisedDescription, revisedAmountCents, currency, ids.task]
  );
}

async function insertPreparedFromExpiredAuthorization(
  client: pg.Client,
  input: {
    readonly preparedCommandId: string;
    readonly operationId: string;
    readonly operationKind: 'SECURE' | 'REVERSAL';
    readonly eventKind: 'SECURED' | 'REVERSED';
    readonly idempotencyKey: string;
  }
): Promise<pg.QueryResult<{ operation_kind: string; prepared_at: Date }>> {
  return client.query<{ operation_kind: string; prepared_at: Date }>(
    `INSERT INTO public.universal_v1_prepared_financial_commands(
       prepared_command_id, operation_kind, event_kind, operation_id,
       provider_kind, idempotency_key, provider_expected_version,
       lifecycle_expected_version, provider_request_sha256, task_draft_id,
       task_id, eligibility_decision_id, scope_version_id,
       predecessor_event_id, related_operation_id, amount_cents, currency,
       recorded_by, request_identity_sha256, authority_context_sha256
     ) VALUES (
       $1, $2, $3, $4, 'FAKE', $5, 0, 2, repeat('2', 64), $6, $7, $8,
       $9, $10, $11, $12, $13, $14, repeat('3', 64), repeat('4', 64)
     ) RETURNING operation_kind, prepared_at`,
    [
      input.preparedCommandId,
      input.operationKind,
      input.eventKind,
      input.operationId,
      input.idempotencyKey,
      ids.draft,
      ids.task,
      ids.eligibility,
      ids.scope,
      ids.authorizeEvent,
      ids.authorizeOperation,
      amountCents,
      currency,
      ids.user,
    ]
  );
}

async function observeBridgeInTimeZone(
  timeZone: 'America/Los_Angeles' | 'Asia/Kathmandu',
  exerciseConsumers: boolean
): Promise<TimeZoneProof> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL TIME ZONE '${timeZone}'`);
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await seedBridgeAuthority(client);
    await client.query("SET LOCAL session_replication_role = 'origin'");

    const bridge = await client.query<BridgeObservation>(
      `INSERT INTO public.universal_v1_fake_financial_lifecycle_bridges(
         bridge_id, prepared_command_id, command_id, dispatch_attempt_id,
         outcome_fact_id, fake_operation_event_id,
         task_financial_security_event_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING provider_recorded_at, provider_expires_at,
         (SELECT raw.recorded_at
            FROM public.hxos_fake_financial_operation_events_v1 raw
           WHERE raw.event_id = fake_operation_event_id) AS raw_recorded_at,
         (SELECT raw.expires_at
            FROM public.hxos_fake_financial_operation_events_v1 raw
           WHERE raw.event_id = fake_operation_event_id) AS raw_expires_at,
         (SELECT lifecycle.occurred_at
            FROM public.task_financial_security_events lifecycle
           WHERE lifecycle.id = task_financial_security_event_id)
           AS lifecycle_occurred_at,
         (SELECT lifecycle.expires_at
            FROM public.task_financial_security_events lifecycle
           WHERE lifecycle.id = task_financial_security_event_id)
           AS lifecycle_expires_at,
         expiry_authority_sha256`,
      [
        ids.bridge,
        ids.prepared,
        ids.command,
        ids.dispatch,
        ids.outcome,
        ids.fakeEvent,
        ids.authorizeEvent,
      ]
    );

    let secureFailure: PgFailure | null = null;
    let addressFailure: PgFailure | null = null;
    let dispatchFailure: PgFailure | null = null;
    let amendmentFailure: PgFailure | null = null;
    let reversalAttemptedAt: Date | null = null;
    if (exerciseConsumers) {
      secureFailure = await captureSavepointFailure(client, 'expired_secure', () =>
        insertPreparedFromExpiredAuthorization(client, {
          preparedCommandId: ids.securePrepared,
          operationId: ids.secureOperation,
          operationKind: 'SECURE',
          eventKind: 'SECURED',
          idempotencyKey: 'expiry-proof-secure-0001',
        })
      );

      await client.query("SET LOCAL session_replication_role = 'replica'");
      await seedExpiredWorkOrder(client);
      await seedDispatchCommand(client, {
        operationKind: 'SECURE',
        eventKind: 'SECURED',
        operationId: ids.secureOperation,
        preparedCommandId: ids.securePrepared,
        commandId: ids.secureCommand,
        leaseId: ids.secureLease,
        predecessorEventId: ids.authorizeEvent,
        predecessorOperationId: ids.authorizeOperation,
        lifecycleExpectedVersion: 2,
        idempotencyKey: 'expiry-proof-secure-dispatch-0001',
        requestSha256: '2'.repeat(64),
      });
      await seedDispatchCommand(client, {
        operationKind: 'REVERSAL',
        eventKind: 'REVERSED',
        operationId: ids.reversalOperation,
        preparedCommandId: ids.reversalPrepared,
        commandId: ids.reversalCommand,
        leaseId: ids.reversalLease,
        predecessorEventId: ids.securedEvent,
        predecessorOperationId: ids.securedOperation,
        lifecycleExpectedVersion: 3,
        idempotencyKey: 'expiry-proof-reversal-dispatch-0001',
        requestSha256: '6'.repeat(64),
      });
      await client.query("SET LOCAL session_replication_role = 'origin'");

      dispatchFailure = await captureSavepointFailure(client, 'spoofed_dispatch_time', () =>
        client.query(
          `INSERT INTO public.financial_provider_command_dispatch_attempts(
             dispatch_attempt_id, command_id, recovery_lease_id, attempt_number,
             request_sha256, outcome_timeout_seconds, attempted_at,
             outcome_deadline_at
           ) VALUES (
             $1, $2, $3, 1, repeat('2', 64), 60,
             TIMESTAMPTZ '2019-01-01 00:00:00Z',
             TIMESTAMPTZ '2019-01-01 00:01:00Z'
           )`,
          [ids.secureAttempt, ids.secureCommand, ids.secureLease]
        )
      );
      const reversalDispatch = await client.query<{ attempted_at: Date }>(
        `INSERT INTO public.financial_provider_command_dispatch_attempts(
           dispatch_attempt_id, command_id, recovery_lease_id, attempt_number,
           request_sha256, outcome_timeout_seconds, attempted_at,
           outcome_deadline_at
         ) VALUES (
           $1, $2, $3, 1, repeat('6', 64), 60,
           TIMESTAMPTZ '2019-01-01 00:00:00Z',
           TIMESTAMPTZ '2019-01-01 00:01:00Z'
         ) RETURNING attempted_at`,
        [ids.reversalAttempt, ids.reversalCommand, ids.reversalLease]
      );
      reversalAttemptedAt = reversalDispatch.rows[0]?.attempted_at ?? null;

      addressFailure = await captureSavepointFailure(
        client,
        'expired_exact_work_order_address',
        () =>
          client.query(
            `INSERT INTO public.task_location_access_log(task_id, worker_id, access_reason)
           VALUES ($1, $2, 'EXACT_ADDRESS_RELEASE')`,
            [ids.task, ids.user]
          )
      );

      await client.query("SET LOCAL session_replication_role = 'replica'");
      await seedExpiredAmendmentAuthority(client);
      await client.query("SET LOCAL session_replication_role = 'origin'");
      const amendmentAuthority = await client.query<{
        work_order_id: string | null;
        proposal_status: string | null;
        proposal_contract: number | null;
        approved_scope_id: string | null;
        active_scope_id: string | null;
        scope_source: string | null;
        scope_contract: number | null;
        customer_approvals: number;
        provider_approvals: number;
      }>(
        `SELECT work_order.id AS work_order_id,
                proposal.status AS proposal_status,
                proposal.universal_contract_version::integer AS proposal_contract,
                proposal.approved_version_id AS approved_scope_id,
                task.active_scope_version_id AS active_scope_id,
                scope.source AS scope_source,
                scope.universal_contract_version::integer AS scope_contract,
                count(*) FILTER (
                  WHERE approval.approver_role = 'CUSTOMER'
                    AND approval.decision = 'APPROVED'
                )::integer AS customer_approvals,
                count(*) FILTER (
                  WHERE approval.approver_role = 'PROVIDER'
                    AND approval.decision = 'APPROVED'
                )::integer AS provider_approvals
           FROM public.task_work_orders work_order
           JOIN public.tasks task ON task.id = work_order.task_id
           JOIN public.task_scope_change_proposals proposal ON proposal.id = $2
           JOIN public.task_scope_versions scope ON scope.id = $3
           LEFT JOIN public.task_scope_change_approvals approval
             ON approval.proposal_id = proposal.id
          WHERE work_order.id = $1
          GROUP BY work_order.id, proposal.status,
                   proposal.universal_contract_version,
                   proposal.approved_version_id, task.active_scope_version_id,
                   scope.source, scope.universal_contract_version`,
        [ids.workOrder, ids.changeOrder, ids.revisedScope]
      );
      const amendmentAuthorityRow = amendmentAuthority.rows[0];
      if (
        amendmentAuthorityRow?.work_order_id !== ids.workOrder ||
        amendmentAuthorityRow.proposal_status !== 'APPROVED' ||
        amendmentAuthorityRow.proposal_contract !== 1 ||
        amendmentAuthorityRow.approved_scope_id !== ids.revisedScope ||
        amendmentAuthorityRow.active_scope_id !== ids.revisedScope ||
        amendmentAuthorityRow.scope_source !== 'APPROVED_CHANGE' ||
        amendmentAuthorityRow.scope_contract !== 1 ||
        amendmentAuthorityRow.customer_approvals !== 1 ||
        amendmentAuthorityRow.provider_approvals !== 1
      ) {
        throw new Error(
          `EXPIRY_PROOF_AMENDMENT_AUTHORITY_INVALID:${JSON.stringify(amendmentAuthorityRow)}`
        );
      }
      amendmentFailure = await captureSavepointFailure(client, 'expired_amendment', () =>
        client.query(
          `INSERT INTO public.task_work_order_amendments(
             id, work_order_id, amendment_version, change_order_id,
             scope_version_id, adjustment_event_id, idempotency_key,
             materialized_by, request_sha256, expected_financial_version
           ) VALUES (
             $1, $2, 1, $3, $4, $5, 'expiry-proof-amendment-0001', $6,
             public.universal_v1_change_amendment_request_sha256(
               $2, 1, NULL, $3, $4, $5, 2, $6,
               'expiry-proof-amendment-0001'
             ), 2
           )`,
          [
            ids.amendment,
            ids.workOrder,
            ids.changeOrder,
            ids.revisedScope,
            ids.adjustmentEvent,
            ids.user,
          ]
        )
      );
    }

    await client.query('ROLLBACK');
    return {
      bridge: bridge.rows[0]!,
      expectedDigest: canonicalExpiryDigest(),
      secureFailure,
      addressFailure,
      dispatchFailure,
      amendmentFailure,
      reversalAttemptedAt,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

describePg('Universal V1 financial-security expiry PostgreSQL authority', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    const schema = await pool.query<{
      server_version_num: string;
      core_function: string | null;
      fake_v9: string | null;
    }>(
      `SELECT current_setting('server_version_num') AS server_version_num,
              to_regprocedure(
                'public.universal_v1_financial_security_is_current_v1(timestamp with time zone,timestamp with time zone)'
              )::text AS core_function,
              to_regclass('public.hxos_fake_financial_schema_evidence_v9')::text
                AS fake_v9`
    );
    expect(Number(schema.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);
    expect(schema.rows[0]?.core_function).not.toBeNull();
    expect(schema.rows[0]?.fake_v9).toBe('hxos_fake_financial_schema_evidence_v9');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('uses strict greater-than semantics at the exact expiry boundary', async () => {
    const result = await pool.query<{
      at_equality: boolean;
      one_microsecond_before: boolean;
      one_microsecond_after: boolean;
      null_expiry: boolean;
    }>(
      `SELECT
         public.universal_v1_financial_security_is_current_v1($1, $1)
           AS at_equality,
         public.universal_v1_financial_security_is_current_v1(
           $1, $1::timestamptz - INTERVAL '1 microsecond'
         ) AS one_microsecond_before,
         public.universal_v1_financial_security_is_current_v1(
           $1, $1::timestamptz + INTERVAL '1 microsecond'
         ) AS one_microsecond_after,
         public.universal_v1_financial_security_is_current_v1(
           NULL::timestamptz, $1
         ) AS null_expiry`,
      [expiresAt]
    );

    expect(result.rows[0]).toEqual({
      at_equality: false,
      one_microsecond_before: true,
      one_microsecond_after: false,
      null_expiry: false,
    });
  });

  it('enforces success-only fake-provider expiry and null for failed results', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    const operationId = randomUUID();
    const eventId = randomUUID();
    const reference = `fake_authorize_${operationId.replaceAll('-', '').slice(0, 24)}`;
    await client.connect();
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO public.hxos_fake_financial_operations_v1(
           operation_id, operation_kind, identity_sha256, external_reference,
           amount_cents, currency
         ) VALUES ($1, 'AUTHORIZE', repeat('a', 64), $2, 1000, 'usd')`,
        [operationId, reference]
      );
      const missingSuccessExpiry = await captureSavepointFailure(
        client,
        'missing_success_expiry',
        () =>
          client.query(
            `INSERT INTO public.hxos_fake_financial_operation_events_v1(
               event_id, operation_id, operation_kind, event_version, state,
               scenario, amount_cents, currency, external_reference,
               idempotency_key, identity_sha256, request_sha256,
               response_sha256, retryable, recorded_at, expires_at
             ) VALUES (
               $1, $2, 'AUTHORIZE', 1, 'SUCCEEDED', 'SUCCESS', 1000, 'usd',
               $3, 'expiry-constraint-success-0001', repeat('a', 64),
               repeat('b', 64), repeat('c', 64), FALSE, $4, NULL
             )`,
            [eventId, operationId, reference, recordedAt]
          )
      );
      const failedResultWithExpiry = await captureSavepointFailure(
        client,
        'failed_result_with_expiry',
        () =>
          client.query(
            `INSERT INTO public.hxos_fake_financial_operation_events_v1(
               event_id, operation_id, operation_kind, event_version, state,
               scenario, amount_cents, currency, external_reference,
               idempotency_key, identity_sha256, request_sha256,
               response_sha256, retryable, recorded_at, expires_at
             ) VALUES (
               $1, $2, 'AUTHORIZE', 1, 'DECLINED', 'DECLINE', 1000, 'usd',
               $3, 'expiry-constraint-decline-0001', repeat('a', 64),
               repeat('b', 64), repeat('c', 64), FALSE, $4, $5
             )`,
            [eventId, operationId, reference, recordedAt, expiresAt]
          )
      );

      expect(missingSuccessExpiry).toMatchObject({
        code: '23514',
        constraint: 'hxos_fake_financial_event_expiry_v9_chk',
      });
      expect(failedResultWithExpiry).toMatchObject({
        code: '23514',
        constraint: 'hxos_fake_financial_event_expiry_v9_chk',
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('binds exact provider time and expiry with one TimeZone-invariant digest', async () => {
    const losAngeles = await observeBridgeInTimeZone('America/Los_Angeles', true);
    const kathmandu = await observeBridgeInTimeZone('Asia/Kathmandu', false);

    for (const proof of [losAngeles, kathmandu]) {
      expect(proof.bridge.provider_recorded_at.toISOString()).toBe(recordedAt);
      expect(proof.bridge.raw_recorded_at.toISOString()).toBe(recordedAt);
      expect(proof.bridge.lifecycle_occurred_at.toISOString()).toBe(recordedAt);
      expect(proof.bridge.provider_expires_at.toISOString()).toBe(expiresAt);
      expect(proof.bridge.raw_expires_at.toISOString()).toBe(expiresAt);
      expect(proof.bridge.lifecycle_expires_at.toISOString()).toBe(expiresAt);
      expect(proof.bridge.expiry_authority_sha256).toBe(proof.expectedDigest);
    }
    expect(losAngeles.bridge.expiry_authority_sha256).toBe(
      kathmandu.bridge.expiry_authority_sha256
    );

    expect(losAngeles.secureFailure).toMatchObject({ code: 'P0001' });
    expect(losAngeles.secureFailure?.message).toContain('HXUV1-FSE-EXP-3');
    expect(losAngeles.dispatchFailure).toMatchObject({ code: 'P0001' });
    expect(losAngeles.dispatchFailure?.message).toContain('HXUV1-FSE-EXP-4');
    expect(losAngeles.addressFailure).toMatchObject({ code: 'P0001' });
    expect(losAngeles.addressFailure?.message).toContain('HXUV1-FSE-EXP-5');
    expect(losAngeles.amendmentFailure).toMatchObject({ code: 'P0001' });
    expect(losAngeles.amendmentFailure?.message).toContain('HXUV1-FSE-EXP-2');
    expect(losAngeles.reversalAttemptedAt).not.toBeNull();
    expect(losAngeles.reversalAttemptedAt!.getTime()).toBeGreaterThan(Date.parse(expiresAt));
  });

  it('carries one millisecond provider observation through the real repository, application, lifecycle, and bridge path', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    const fixture = applicationAuthorityFixture();
    const commands = applicationFinancialCommands(fixture);
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await seedApplicationAuthority(client, fixture);
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      const role = await client.query<{ role: string }>(
        `SELECT current_setting('session_replication_role') AS role`
      );
      expect(role.rows[0]?.role).toBe('origin');

      const { service } = fakeFinancialHarness(clientDatabase(client));
      const preparation = await service.executeFinancialEvent(commands.preparation);
      const authorization = await service.executeFinancialEvent({
        ...commands.authorization,
        predecessorEventId: preparation.id,
      });
      expect(authorization.status).toBe('SUCCEEDED');
      expect(authorization.expiresAt).not.toBeNull();

      const bridge = await client.query<{
        fake_operation_event_id: string;
        task_financial_security_event_id: string;
        provider_recorded_at: Date;
        provider_expires_at: Date;
        raw_recorded_at: Date;
        raw_expires_at: Date;
        lifecycle_occurred_at: Date;
        lifecycle_expires_at: Date;
        recorded_submillisecond: string;
        expiry_submillisecond: string;
        expiry_authority_sha256: string;
      }>(
        `SELECT bridge.fake_operation_event_id,
                bridge.task_financial_security_event_id,
                bridge.provider_recorded_at,
                bridge.provider_expires_at,
                raw.recorded_at AS raw_recorded_at,
                raw.expires_at AS raw_expires_at,
                lifecycle.occurred_at AS lifecycle_occurred_at,
                lifecycle.expires_at AS lifecycle_expires_at,
                mod(
                  (extract(epoch FROM raw.recorded_at) * 1000000)::BIGINT,
                  1000
                )::TEXT AS recorded_submillisecond,
                mod(
                  (extract(epoch FROM raw.expires_at) * 1000000)::BIGINT,
                  1000
                )::TEXT AS expiry_submillisecond,
                bridge.expiry_authority_sha256
           FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
           JOIN public.hxos_fake_financial_operation_events_v1 raw
             ON raw.event_id = bridge.fake_operation_event_id
           JOIN public.task_financial_security_events lifecycle
             ON lifecycle.id = bridge.task_financial_security_event_id
          WHERE lifecycle.id = $1`,
        [authorization.id]
      );
      const observation = bridge.rows[0]!;
      const exactRecordedAt = observation.raw_recorded_at.toISOString();
      const exactExpiresAt = observation.raw_expires_at.toISOString();
      const expectedDigest = sha256(
        `${observation.fake_operation_event_id}:` +
          `${observation.task_financial_security_event_id}:` +
          `${epochMicroseconds(exactRecordedAt)}:${epochMicroseconds(exactExpiresAt)}`
      );

      expect(authorization.occurredAt).toBe(exactRecordedAt);
      expect(authorization.expiresAt).toBe(exactExpiresAt);
      expect(observation.provider_recorded_at.toISOString()).toBe(exactRecordedAt);
      expect(observation.lifecycle_occurred_at.toISOString()).toBe(exactRecordedAt);
      expect(observation.provider_expires_at.toISOString()).toBe(exactExpiresAt);
      expect(observation.lifecycle_expires_at.toISOString()).toBe(exactExpiresAt);
      expect(Date.parse(exactExpiresAt) - Date.parse(exactRecordedAt)).toBe(15 * 60 * 1000);
      expect(observation.recorded_submillisecond).toBe('0');
      expect(observation.expiry_submillisecond).toBe('0');
      expect(observation.expiry_authority_sha256).toBe(expectedDigest);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('compensates a raw-only pre-v9 null-expiry success without an UNKNOWN loop or new positive authority', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    const fixture = applicationAuthorityFixture();
    const commands = applicationFinancialCommands(fixture);
    const migrationSql = await readFile(
      new URL(
        '../../database/migrations/20261010_universal_v1_fake_financial_expiry_v9.sql',
        import.meta.url
      ),
      'utf8'
    );
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await seedApplicationAuthority(client, fixture);
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      const database = clientDatabase(client);
      const { fakeEvents, provider, service } = fakeFinancialHarness(database, {
        leaseDurationSeconds: 2,
        outcomeTimeoutSeconds: 1,
        recoveryDelaySeconds: 1,
      });
      const preparation = await service.executeFinancialEvent(commands.preparation);
      const providerRequest = {
        operationId: commands.authorization.operationId,
        idempotencyKey: commands.authorization.idempotencyKey,
        expectedVersion: commands.authorization.providerExpectedVersion,
        amountCents: commands.authorization.amountCents,
        currency: commands.authorization.currency,
        relatedOperationId: commands.authorization.relatedOperationId,
        paymentMethodReference: commands.authorization.paymentMethodReference!,
      };
      await provider.authorize(providerRequest);
      const raw = await client.query<{ event_id: string }>(
        `SELECT event_id
           FROM public.hxos_fake_financial_operation_events_v1
          WHERE idempotency_key = $1`,
        [commands.authorization.idempotencyKey]
      );
      const rawEventId = raw.rows[0]!.event_id;

      await client.query(
        `ALTER TABLE public.hxos_fake_financial_operation_events_v1
           DROP CONSTRAINT hxos_fake_financial_event_expiry_v9_chk`
      );
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE public.hxos_fake_financial_operation_events_v1
            SET expires_at = NULL
          WHERE event_id = $1`,
        [rawEventId]
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);

      await client.query(migrationSql);
      const disposition = await client.query<{
        disposition: string;
        recovery_state: string;
        recovery_terminal: boolean;
        recovery_retryable: boolean;
        authority_sha256: string;
        constraint_validated: boolean;
      }>(
        `SELECT legacy.disposition, legacy.recovery_state,
                legacy.recovery_terminal, legacy.recovery_retryable,
                legacy.authority_sha256,
                constraint_row.convalidated AS constraint_validated
           FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 legacy
           JOIN pg_catalog.pg_constraint constraint_row
             ON constraint_row.conname = 'hxos_fake_financial_event_expiry_v9_chk'
            AND constraint_row.conrelid =
                'public.hxos_fake_financial_operation_events_v1'::regclass
          WHERE legacy.fake_operation_event_id = $1`,
        [rawEventId]
      );
      expect(disposition.rows[0]).toMatchObject({
        disposition: 'LEGACY_EXPIRY_UNPROVEN',
        recovery_state: 'COMPENSATION_REQUIRED',
        recovery_terminal: false,
        recovery_retryable: true,
        constraint_validated: false,
      });
      expect(disposition.rows[0]?.authority_sha256).toMatch(/^[0-9a-f]{64}$/u);

      const recoverable = await fakeEvents.findByIdempotencyKey(
        commands.authorization.idempotencyKey
      );
      expect(recoverable).toMatchObject({
        eventId: rawEventId,
        state: 'SUCCEEDED',
        expiresAt: null,
        expiryDisposition: 'LEGACY_EXPIRY_UNPROVEN',
      });

      const applicationCommand = {
        ...commands.authorization,
        predecessorEventId: preparation.id,
      };
      const preCompensationFailure = await captureFailure(() =>
        service.executeFinancialEvent(applicationCommand)
      );
      const terminalGuardMessage =
        'HXUV1-FSE-V9-17: raw-only legacy success cannot acquire a contradictory terminal outcome';
      expect(preCompensationFailure.message).toBe(terminalGuardMessage);

      const failedBeforeCompensation = await captureSavepointFailure(
        client,
        'legacy_failed_before_compensation',
        () =>
          insertRawOnlyLegacyTerminalOutcome(
            client,
            commands.authorization.idempotencyKey,
            'expiry-proof-legacy-failed-before-0001',
            'FAILED'
          )
      );
      const observedBeforeCompensation = await captureSavepointFailure(
        client,
        'legacy_observed_before_compensation',
        () =>
          insertRawOnlyLegacyTerminalOutcome(
            client,
            commands.authorization.idempotencyKey,
            'expiry-proof-legacy-observed-terminal-0001',
            'OUTCOME_OBSERVED'
          )
      );
      expect(failedBeforeCompensation).toMatchObject({
        code: 'P0001',
        message: terminalGuardMessage,
      });
      expect(observedBeforeCompensation).toMatchObject({
        code: 'P0001',
        message: terminalGuardMessage,
      });
      const preCompensationOutcomes = await client.query<{ outcomes: number }>(
        `SELECT COUNT(*)::INTEGER AS outcomes
           FROM public.financial_provider_command_outcome_facts outcome
           JOIN public.financial_provider_command_journal command
             ON command.command_id = outcome.command_id
          WHERE command.idempotency_key = $1`,
        [commands.authorization.idempotencyKey]
      );
      expect(preCompensationOutcomes.rows[0]?.outcomes).toBe(0);

      const compensationIdempotencyKey = `legacy-expiry-compensation:v9:${rawEventId}`;
      const compensationRepository = new PostgresLegacyFakeFinancialExpiryCompensationRepository(
        database
      );
      const candidates = await compensationRepository.findRequired(50);
      const candidate = candidates.find((entry) => entry.sourceEventId === rawEventId);
      expect(candidate).toMatchObject({
        sourceEventId: rawEventId,
        sourceOperationId: commands.authorization.operationId,
        sourceOperationKind: 'AUTHORIZE',
        amountCents,
        currency: currency.toLowerCase(),
      });
      if (!candidate) throw new Error('Expected exact raw-only compensation candidate');
      const scopedRepository = {
        findRequired: async () => [candidate],
        prepareCommand: (sourceEventId: string, providerRequestSha256: string) =>
          compensationRepository.prepareCommand(sourceEventId, providerRequestSha256),
        recordDispatchAttempt: (commandId: string) =>
          compensationRepository.recordDispatchAttempt(commandId),
        recordCompensation: (
          sourceEventId: string,
          compensationEventId: string,
          commandId: string,
          dispatchAttemptId: string
        ) =>
          compensationRepository.recordCompensation(
            sourceEventId,
            compensationEventId,
            commandId,
            dispatchAttemptId
          ),
      };
      let authorizationChecks = 0;
      const worker = () =>
        new LegacyFakeFinancialExpiryCompensationWorker(
          scopedRepository,
          provider,
          fakeEvents,
          () => {
            authorizationChecks += 1;
          }
        );
      const concurrentRuns = await Promise.all([worker().runOnce(1), worker().runOnce(1)]);
      expect(concurrentRuns.reduce((sum, run) => sum + run.attempted, 0)).toBe(2);
      expect(concurrentRuns.reduce((sum, run) => sum + run.compensated, 0)).toBe(1);
      expect(concurrentRuns.reduce((sum, run) => sum + run.replayed, 0)).toBe(1);
      expect(authorizationChecks).toBe(4);
      expect(
        (await compensationRepository.findRequired(50)).some(
          (entry) => entry.sourceEventId === rawEventId
        )
      ).toBe(false);
      const closure = await client.query<{
        source_operation_kind: string;
        compensation_operation_kind: string;
        compensation_provider_state: string;
        compensation_idempotency_key: string;
        compensation_command_id: string;
        dispatch_attempt_id: string;
        outcome_fact_id: string;
        attempted_at: Date;
        compensation_recorded_at: Date;
        compensation_events: number;
        compensation_commands: number;
        compensation_attempts: number;
        compensation_outcomes: number;
        compensation_terminals: number;
        effective_terminal: boolean;
        effective_retryable: boolean;
        authority_sha256: string;
      }>(
        `SELECT disposition.operation_kind AS source_operation_kind,
                compensation.compensation_operation_kind,
                compensation.compensation_provider_state,
                compensation.compensation_idempotency_key,
                compensation.compensation_command_id,
                compensation.dispatch_attempt_id,
                compensation.outcome_fact_id,
                attempt.attempted_at,
                provider_event.recorded_at AS compensation_recorded_at,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_operation_events_v1 event
                  WHERE event.idempotency_key = $2) AS compensation_events,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 staged
                  WHERE staged.source_fake_operation_event_id = $1)
                  AS compensation_commands,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 staged
                  WHERE staged.command_id = compensation.compensation_command_id)
                  AS compensation_attempts,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9 staged
                  WHERE staged.command_id = compensation.compensation_command_id)
                  AS compensation_outcomes,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 staged
                  WHERE staged.source_fake_operation_event_id = $1)
                  AS compensation_terminals,
                (
                  disposition.recovery_terminal
                  OR compensation.source_fake_operation_event_id IS NOT NULL
                ) AS effective_terminal,
                (
                  disposition.recovery_retryable
                  AND compensation.source_fake_operation_event_id IS NULL
                ) AS effective_retryable,
                compensation.authority_sha256
           FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 disposition
           JOIN public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
             ON compensation.source_fake_operation_event_id =
                disposition.fake_operation_event_id
           JOIN public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 attempt
             ON attempt.dispatch_attempt_id = compensation.dispatch_attempt_id
           JOIN public.hxos_fake_financial_operation_events_v1 provider_event
             ON provider_event.event_id = compensation.compensation_fake_operation_event_id
          WHERE disposition.fake_operation_event_id = $1`,
        [rawEventId, compensationIdempotencyKey]
      );
      expect(closure.rows[0]).toMatchObject({
        source_operation_kind: 'AUTHORIZE',
        compensation_operation_kind: 'VOID',
        compensation_provider_state: 'VOIDED',
        compensation_idempotency_key: compensationIdempotencyKey,
        compensation_events: 1,
        compensation_commands: 1,
        compensation_attempts: 1,
        compensation_outcomes: 1,
        compensation_terminals: 1,
        effective_terminal: true,
        effective_retryable: false,
      });
      expect(closure.rows[0]!.compensation_recorded_at.getTime()).toBeGreaterThanOrEqual(
        closure.rows[0]!.attempted_at.getTime()
      );
      expect(closure.rows[0]?.compensation_command_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
      expect(closure.rows[0]?.dispatch_attempt_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
      expect(closure.rows[0]?.outcome_fact_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
      expect(closure.rows[0]?.authority_sha256).toMatch(/^[0-9a-f]{64}$/u);

      const failedAfterCompensation = await captureSavepointFailure(
        client,
        'legacy_failed_after_compensation',
        () =>
          insertRawOnlyLegacyTerminalOutcome(
            client,
            commands.authorization.idempotencyKey,
            'expiry-proof-legacy-failed-after-0001',
            'FAILED'
          )
      );
      expect(failedAfterCompensation).toMatchObject({
        code: 'P0001',
        message: terminalGuardMessage,
      });
      await insertRawOnlyLegacyTerminalOutcome(
        client,
        commands.authorization.idempotencyKey,
        'expiry-proof-legacy-observed-terminal-0001',
        'OUTCOME_OBSERVED'
      );
      const terminalOutcomes = await client.query<{
        terminal_outcomes: number;
        observed_outcomes: number;
        failed_outcomes: number;
        effect_certainty: string;
        retryable: boolean;
      }>(
        `SELECT COUNT(*)::INTEGER AS terminal_outcomes,
                COUNT(*) FILTER (
                  WHERE outcome.outcome_kind = 'OUTCOME_OBSERVED'
                )::INTEGER AS observed_outcomes,
                COUNT(*) FILTER (
                  WHERE outcome.outcome_kind = 'FAILED'
                )::INTEGER AS failed_outcomes,
                MIN(outcome.effect_certainty) AS effect_certainty,
                BOOL_OR(outcome.retryable) AS retryable
           FROM public.financial_provider_command_outcome_facts outcome
           JOIN public.financial_provider_command_journal command
             ON command.command_id = outcome.command_id
          WHERE command.idempotency_key = $1
            AND NOT outcome.retryable`,
        [commands.authorization.idempotencyKey]
      );
      expect(terminalOutcomes.rows[0]).toEqual({
        terminal_outcomes: 1,
        observed_outcomes: 1,
        failed_outcomes: 0,
        effect_certainty: 'CONFIRMED_EFFECT',
        retryable: false,
      });

      await client.query(`SELECT pg_sleep(2.1)`);
      const convergedFailure = await captureFailure(() =>
        service.executeFinancialEvent(applicationCommand)
      );
      const replayFailure = await captureFailure(() =>
        service.executeFinancialEvent(applicationCommand)
      );
      expect(convergedFailure.message).toBe('UNIVERSAL_FINANCE_LIFECYCLE_EXPIRY_INVALID');
      expect(replayFailure.message).toBe(convergedFailure.message);

      const recovery = await client.query<{
        outcomes: number;
        observed: number;
        unknown: number;
        retryable: number;
        positive_lifecycle_facts: number;
        positive_bridges: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::INTEGER
              FROM public.financial_provider_command_outcome_facts outcome
              JOIN public.financial_provider_command_journal command
                ON command.command_id = outcome.command_id
             WHERE command.idempotency_key = $1) AS outcomes,
           (SELECT COUNT(*)::INTEGER
              FROM public.financial_provider_command_outcome_facts outcome
              JOIN public.financial_provider_command_journal command
                ON command.command_id = outcome.command_id
             WHERE command.idempotency_key = $1
               AND outcome.outcome_kind = 'OUTCOME_OBSERVED') AS observed,
           (SELECT COUNT(*)::INTEGER
              FROM public.financial_provider_command_outcome_facts outcome
              JOIN public.financial_provider_command_journal command
                ON command.command_id = outcome.command_id
             WHERE command.idempotency_key = $1
               AND outcome.outcome_kind = 'OUTCOME_UNKNOWN') AS unknown,
           (SELECT COUNT(*)::INTEGER
              FROM public.financial_provider_command_outcome_facts outcome
              JOIN public.financial_provider_command_journal command
                ON command.command_id = outcome.command_id
             WHERE command.idempotency_key = $1
               AND outcome.retryable) AS retryable,
           (SELECT COUNT(*)::INTEGER
              FROM public.task_financial_security_events lifecycle
             WHERE lifecycle.idempotency_key = $1
               AND lifecycle.event_kind = 'AUTHORIZED') AS positive_lifecycle_facts,
           (SELECT COUNT(*)::INTEGER
              FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
              JOIN public.task_financial_security_events lifecycle
                ON lifecycle.id = bridge.task_financial_security_event_id
             WHERE lifecycle.idempotency_key = $1) AS positive_bridges`,
        [commands.authorization.idempotencyKey]
      );
      expect(recovery.rows[0]).toEqual({
        outcomes: 1,
        observed: 1,
        unknown: 0,
        retryable: 0,
        positive_lifecycle_facts: 0,
        positive_bridges: 0,
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('compensates a bridged pre-v9 null-expiry success when provider time mismatches', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    const migrationSql = await readFile(
      new URL(
        '../../database/migrations/20261010_universal_v1_fake_financial_expiry_v9.sql',
        import.meta.url
      ),
      'utf8'
    );
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await seedHistoricalNullExpiryBridge(client, true);
      await client.query(migrationSql);
      const replay = await client.query<{
        raw_recorded_at: Date;
        lifecycle_occurred_at: Date;
        raw_expires_at: Date | null;
        lifecycle_expires_at: Date | null;
        provider_recorded_at: Date | null;
        provider_expires_at: Date | null;
        disposition: string;
        recovery_state: string;
        recovery_terminal: boolean;
        recovery_retryable: boolean;
        authority_sha256: string;
        observed_outcomes: number;
        unknown_outcomes: number;
        lifecycle_facts: number;
        lifecycle_bridges: number;
        compensations: number;
      }>(
        `SELECT raw.recorded_at AS raw_recorded_at,
                lifecycle.occurred_at AS lifecycle_occurred_at,
                raw.expires_at AS raw_expires_at,
                lifecycle.expires_at AS lifecycle_expires_at,
                bridge.provider_recorded_at,
                bridge.provider_expires_at,
                disposition.disposition,
                disposition.recovery_state,
                disposition.recovery_terminal,
                disposition.recovery_retryable,
                disposition.authority_sha256,
                (SELECT COUNT(*)::INTEGER
                   FROM public.financial_provider_command_outcome_facts outcome
                  WHERE outcome.command_id = $4
                    AND outcome.outcome_kind = 'OUTCOME_OBSERVED') AS observed_outcomes,
                (SELECT COUNT(*)::INTEGER
                   FROM public.financial_provider_command_outcome_facts outcome
                  WHERE outcome.command_id = $4
                    AND outcome.outcome_kind = 'OUTCOME_UNKNOWN') AS unknown_outcomes,
                (SELECT COUNT(*)::INTEGER
                   FROM public.task_financial_security_events fact
                  WHERE fact.idempotency_key = 'expiry-proof-authorize-0001')
                  AS lifecycle_facts,
                (SELECT COUNT(*)::INTEGER
                   FROM public.universal_v1_fake_financial_lifecycle_bridges existing
                  WHERE existing.fake_operation_event_id = $1) AS lifecycle_bridges,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
                  WHERE compensation.source_fake_operation_event_id = $1) AS compensations
           FROM public.hxos_fake_financial_operation_events_v1 raw
           JOIN public.universal_v1_fake_financial_lifecycle_bridges bridge
             ON bridge.fake_operation_event_id = raw.event_id
           JOIN public.task_financial_security_events lifecycle
             ON lifecycle.id = bridge.task_financial_security_event_id
           JOIN public.hxos_fake_financial_legacy_expiry_dispositions_v9 disposition
             ON disposition.fake_operation_event_id = raw.event_id
          WHERE raw.event_id = $1
            AND lifecycle.id = $2
            AND bridge.bridge_id = $3`,
        [ids.fakeEvent, ids.authorizeEvent, ids.bridge, ids.command]
      );
      const observation = replay.rows[0]!;
      expect(observation.raw_recorded_at.toISOString()).toBe(recordedAt);
      expect(observation.lifecycle_occurred_at.toISOString()).toBe('2020-01-01T00:00:00.124Z');
      expect(observation.lifecycle_occurred_at.toISOString()).not.toBe(
        observation.raw_recorded_at.toISOString()
      );
      expect(observation).toMatchObject({
        raw_expires_at: null,
        lifecycle_expires_at: null,
        provider_recorded_at: null,
        provider_expires_at: null,
        disposition: 'LEGACY_EXPIRY_UNPROVEN',
        recovery_state: 'COMPENSATION_REQUIRED',
        recovery_terminal: false,
        recovery_retryable: true,
        observed_outcomes: 1,
        unknown_outcomes: 0,
        lifecycle_facts: 1,
        lifecycle_bridges: 1,
        compensations: 0,
      });
      expect(observation.authority_sha256).toMatch(/^[0-9a-f]{64}$/u);

      const database = clientDatabase(client);
      const fakeEvents = new PostgresFakeFinancialOperationRepository(database);
      const compensationRepository = new PostgresLegacyFakeFinancialExpiryCompensationRepository(
        database
      );
      const candidate = (await compensationRepository.findRequired(50)).find(
        (entry) => entry.sourceEventId === ids.fakeEvent
      );
      expect(candidate).toMatchObject({
        sourceEventId: ids.fakeEvent,
        sourceOperationId: ids.authorizeOperation,
        sourceOperationKind: 'AUTHORIZE',
        amountCents,
        currency: currency.toLowerCase(),
      });
      if (!candidate) throw new Error('Expected mismatched-time compensation candidate');
      const scopedRepository = {
        findRequired: async () => [candidate],
        prepareCommand: (sourceEventId: string, providerRequestSha256: string) =>
          compensationRepository.prepareCommand(sourceEventId, providerRequestSha256),
        recordDispatchAttempt: (commandId: string) =>
          compensationRepository.recordDispatchAttempt(commandId),
        recordCompensation: (
          sourceEventId: string,
          compensationEventId: string,
          commandId: string,
          dispatchAttemptId: string
        ) =>
          compensationRepository.recordCompensation(
            sourceEventId,
            compensationEventId,
            commandId,
            dispatchAttemptId
          ),
      };
      let authorizationChecks = 0;
      const worker = new LegacyFakeFinancialExpiryCompensationWorker(
        scopedRepository,
        new FakeFinancialProvider(fakeEvents),
        fakeEvents,
        () => {
          authorizationChecks += 1;
        }
      );
      expect(await worker.runOnce(1)).toEqual({ attempted: 1, compensated: 1, replayed: 0 });
      expect(authorizationChecks).toBe(2);
      expect(
        (await compensationRepository.findRequired(50)).some(
          (entry) => entry.sourceEventId === ids.fakeEvent
        )
      ).toBe(false);

      const closure = await client.query<{
        compensation_operation_kind: string;
        compensation_provider_state: string;
        compensation_idempotency_key: string;
        attempted_at: Date;
        compensation_recorded_at: Date;
        compensations: number;
        lifecycle_facts: number;
        lifecycle_bridges: number;
      }>(
        `SELECT compensation.compensation_operation_kind,
                compensation.compensation_provider_state,
                compensation.compensation_idempotency_key,
                attempt.attempted_at,
                provider_event.recorded_at AS compensation_recorded_at,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 existing
                  WHERE existing.source_fake_operation_event_id = $1) AS compensations,
                (SELECT COUNT(*)::INTEGER
                   FROM public.task_financial_security_events fact
                  WHERE fact.idempotency_key = 'expiry-proof-authorize-0001')
                  AS lifecycle_facts,
                (SELECT COUNT(*)::INTEGER
                   FROM public.universal_v1_fake_financial_lifecycle_bridges existing
                  WHERE existing.fake_operation_event_id = $1) AS lifecycle_bridges
           FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
           JOIN public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 attempt
             ON attempt.dispatch_attempt_id = compensation.dispatch_attempt_id
           JOIN public.hxos_fake_financial_operation_events_v1 provider_event
             ON provider_event.event_id = compensation.compensation_fake_operation_event_id
          WHERE compensation.source_fake_operation_event_id = $1`,
        [ids.fakeEvent]
      );
      expect(closure.rows[0]).toMatchObject({
        compensation_operation_kind: 'VOID',
        compensation_provider_state: 'VOIDED',
        compensation_idempotency_key: `legacy-expiry-compensation:v9:${ids.fakeEvent}`,
        compensations: 1,
        lifecycle_facts: 1,
        lifecycle_bridges: 1,
      });
      expect(closure.rows[0]!.compensation_recorded_at.getTime()).toBeGreaterThanOrEqual(
        closure.rows[0]!.attempted_at.getTime()
      );
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('keeps an exact-time bridged pre-v9 null-expiry success replay-only', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    const migrationSql = await readFile(
      new URL(
        '../../database/migrations/20261010_universal_v1_fake_financial_expiry_v9.sql',
        import.meta.url
      ),
      'utf8'
    );
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await seedHistoricalNullExpiryBridge(client, false);
      await client.query(migrationSql);
      const replay = await client.query<{
        raw_recorded_at: Date;
        lifecycle_occurred_at: Date;
        raw_expires_at: Date | null;
        lifecycle_expires_at: Date | null;
        provider_recorded_at: Date | null;
        provider_expires_at: Date | null;
        disposition: string;
        recovery_state: string;
        recovery_terminal: boolean;
        recovery_retryable: boolean;
        authority_sha256: string;
        lifecycle_facts: number;
        lifecycle_bridges: number;
        compensations: number;
      }>(
        `SELECT raw.recorded_at AS raw_recorded_at,
                lifecycle.occurred_at AS lifecycle_occurred_at,
                raw.expires_at AS raw_expires_at,
                lifecycle.expires_at AS lifecycle_expires_at,
                bridge.provider_recorded_at,
                bridge.provider_expires_at,
                disposition.disposition,
                disposition.recovery_state,
                disposition.recovery_terminal,
                disposition.recovery_retryable,
                disposition.authority_sha256,
                (SELECT COUNT(*)::INTEGER
                   FROM public.task_financial_security_events fact
                  WHERE fact.idempotency_key = 'expiry-proof-authorize-0001')
                  AS lifecycle_facts,
                (SELECT COUNT(*)::INTEGER
                   FROM public.universal_v1_fake_financial_lifecycle_bridges existing
                  WHERE existing.fake_operation_event_id = $1) AS lifecycle_bridges,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
                  WHERE compensation.source_fake_operation_event_id = $1) AS compensations
           FROM public.hxos_fake_financial_operation_events_v1 raw
           JOIN public.universal_v1_fake_financial_lifecycle_bridges bridge
             ON bridge.fake_operation_event_id = raw.event_id
           JOIN public.task_financial_security_events lifecycle
             ON lifecycle.id = bridge.task_financial_security_event_id
           JOIN public.hxos_fake_financial_legacy_expiry_dispositions_v9 disposition
             ON disposition.fake_operation_event_id = raw.event_id
          WHERE raw.event_id = $1
            AND lifecycle.id = $2
            AND bridge.bridge_id = $3`,
        [ids.fakeEvent, ids.authorizeEvent, ids.bridge]
      );
      const observation = replay.rows[0]!;
      expect(observation.raw_recorded_at.toISOString()).toBe(recordedAt);
      expect(observation.lifecycle_occurred_at.toISOString()).toBe(recordedAt);
      expect(observation).toMatchObject({
        raw_expires_at: null,
        lifecycle_expires_at: null,
        provider_recorded_at: null,
        provider_expires_at: null,
        disposition: 'LEGACY_EXPIRY_UNPROVEN',
        recovery_state: 'EXACT_REPLAY_ONLY',
        recovery_terminal: true,
        recovery_retryable: false,
        lifecycle_facts: 1,
        lifecycle_bridges: 1,
        compensations: 0,
      });
      expect(observation.authority_sha256).toMatch(/^[0-9a-f]{64}$/u);

      const database = clientDatabase(client);
      const compensationRepository = new PostgresLegacyFakeFinancialExpiryCompensationRepository(
        database
      );
      expect(
        (await compensationRepository.findRequired(50)).some(
          (entry) => entry.sourceEventId === ids.fakeEvent
        )
      ).toBe(false);
      const legacyReplay = await new PostgresFakeFinancialOperationRepository(
        database
      ).findByIdempotencyKey('expiry-proof-authorize-0001');
      expect(legacyReplay).toMatchObject({
        eventId: ids.fakeEvent,
        state: 'SUCCEEDED',
        recordedAt,
        expiresAt: null,
        expiryDisposition: 'LEGACY_EXPIRY_UNPROVEN',
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
