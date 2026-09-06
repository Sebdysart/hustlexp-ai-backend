import { PostgresUniversalV1PreparedFinancialCommandAuthority } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalFinancialProviderRequestJson } from '../../src/services/payment/FinancialProviderRequestCanonicalization.js';
import {
  encodeFakeFinancialDurableRequest,
  FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS,
} from '../../src/services/payment/FakeFinancialDurableRequest.js';
import { PostgresFinancialProviderCommandJournal } from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  FakeFinancialProvider,
  type FakeFinancialRepositoryCommand,
  type StoredFakeFinancialOperation,
  PostgresFakeFinancialOperationRepository,
  resultFromExactStoredFakeFinancialOperation,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  FAKE_FINANCIAL_SCENARIO_VALUES,
  fakeFinancialScenarioSupportsOperation,
} from '../../src/services/payment/FakeFinancialScenarioPolicy.js';
import type { Database } from '../../src/db.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client, type Pool, type QueryResult } from 'pg';
import { Queue } from 'bullmq';
import { PostgresFakeFinancialAdmittedRequestRepository } from '../../src/jobs/fake-financial-admitted-request.js';
import { decodeFakeFinancialMaterializationRow } from '../../src/jobs/fake-financial-materialization.js';
import { decodeFakeFinancialProgressRow } from '../../src/jobs/fake-financial-progress.js';
import type { QueryFn } from '../../src/database-contracts.js';
import { createFakeFinancialOutboxTransport } from '../../src/jobs/queues.js';
import {
  FakeFinancialOutboxPublisher,
  PostgresFakeFinancialOutboxRepository,
} from '../../src/jobs/fake-financial-outbox-publisher.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAcceptedEstimateFixture } from '../helpers/universal-v1-accepted-estimate-fixture.js';
import { createClaimedTaskDraftFixture } from '../helpers/universal-v1-claimed-task-draft-fixture.js';
import {
  createPreparedWorkOrderFixture,
  createSyntheticActorAttestation,
} from '../helpers/universal-v1-prepared-work-order-fixture.js';
import { deterministicUuid } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { createUniversalV1DisposableDatabase } from '../helpers/universal-v1-disposable-database.js';
import { provisionUniversalV1SyntheticRoles } from '../helpers/universal-v1-synthetic-role-provisioning.js';
import {
  FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS,
  fakeFinancialBootstrapMetadataColumns,
  FAKE_FINANCIAL_OUTBOX_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS,
} from '../../src/jobs/fake-financial-outbox-role-plans.js';
import { WORK_ORDER_FINANCIAL_READ_RELATIONS } from '../../src/jobs/work-order-command-role-authority.js';

const fileName = '20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);
const migrationSha256 = createHash('sha256').update(migration, 'utf8').digest('hex');
const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
const hostileAclRole = `hx_v13_acl_${randomUUID().replaceAll('-', '')}`;
const migrationName = '20261016_universal_v1_fake_financial_command_outbox_authority_v13';
const normalizedGuardIdentities = [
  'public.enforce_universal_v1_financial_command_preparation()',
  'public.validate_universal_v1_fake_terminal_prepared_command()',
] as const;
let sealedGuardDefinitions: { identity: string; definition: string }[] = [];
const legacyProjectionRequest = {
  operationId: randomUUID().toUpperCase(),
  idempotencyKey: 'projection-upgrade:' + randomUUID(),
  expectedVersion: 0,
  customerId: 'synthetic-legacy',
};
let legacyProjectionEvent: StoredFakeFinancialOperation;
let legacyProjectionRepository: PostgresFakeFinancialOperationRepository;
let executionDependencyGuardDefinitions: { identity: string; definition: string }[] = [];
const v13Relations = [
  'hx_authority.fake_financial_exact_requests_v13',
  'hx_authority.fake_financial_command_outbox_requests_v13',
  'hx_authority.fake_financial_outbox_publish_claims_v13',
  'hx_authority.fake_financial_outbox_publish_outcomes_v13',
  'hx_authority.fake_financial_outbox_dispositions_v13',
  'hx_authority.fake_financial_publish_exhaustions_v13',
  'hx_authority.fake_financial_dispatch_admissions_v13',
  'hx_authority.fake_financial_job_validations_v13',
  'hx_authority.fake_financial_webhook_inert_evidence_v13',
  'hx_authority.fake_financial_webhook_rejection_receipts_v13',
  'public.hxos_fake_financial_schema_evidence_v13',
] as const;
const v13Functions = [
  'hx_authority.read_fake_financial_terminal_observation_v13(uuid,uuid,uuid)',
  'hx_authority.derive_fake_financial_projection_v13(text,text)',
  'hx_authority.derive_fake_financial_projection_v13(text,text,smallint)',
  'hx_authority.assert_fake_financial_execution_domain_v13(uuid,text)',
  'public.hxos_execute_admitted_fake_financial_request_v13(uuid,uuid)',
  'public.hxos_read_admitted_fake_financial_request_v13(uuid,uuid)',
  'public.hxos_request_fake_financial_command_v13(text,text)',
  'hx_authority.parse_fake_financial_request_v13(text,text)',
  'hx_authority.parse_fake_financial_identity_v13(text)',
  'hx_authority.mark_fake_financial_request_transaction_v13()',
  'hx_authority.validate_fake_financial_exact_request_v13()',
  'hx_authority.require_fake_financial_exact_request_v13()',
  'public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()',
  ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
  'public.hxos_claim_fake_financial_outbox_v13(uuid,integer)',
  'public.hxos_record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)',
  'hx_authority.fake_financial_job_digest_v13(text[])',
  'hx_authority.reject_fake_financial_outbox_mutation_v13()',
  'hx_authority.assert_fake_financial_outbox_target_v13(uuid,text,text,text)',
  'hx_authority.validate_fake_financial_outbox_request_v13()',
  'hx_authority.capture_fake_financial_outbox_request_v13()',
  'hx_authority.validate_fake_financial_outbox_disposition_v13()',
  'hx_authority.validate_fake_financial_publish_claim_v13()',
  'hx_authority.assert_fake_financial_publish_open_v13(uuid)',
  'hx_authority.validate_fake_financial_publish_exhaustion_v13()',
  'hx_authority.claim_fake_financial_outbox_v13(uuid,integer)',
  'hx_authority.validate_fake_financial_publish_outcome_v13()',
  'hx_authority.record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)',
  'hx_authority.validate_fake_financial_dispatch_admission_v13()',
  'hx_authority.validate_fake_financial_job_validation_v13()',
  'hx_authority.record_fake_financial_job_dispatch_evidence_v13(uuid,text,text,uuid,integer,integer,integer)',
  'hx_authority.validate_fake_financial_webhook_rejection_v13()',
  'hx_authority.record_fake_financial_webhook_rejection_v13(uuid,text,text,text,text,text)',
  'hx_authority.validate_fake_financial_webhook_inert_v13()',
  'hx_authority.capture_fake_financial_webhook_inert_v13()',
] as const;

interface TargetRow {
  authority_version: number;
  target_authority_id: string;
  target_database_name: string;
  environment: 'local' | 'preview' | 'staging';
  release_manifest_sha256: string;
}

interface QueuedCommand {
  commandId: string;
  outboxRequestId: string;
  publishClaimId: string | null;
  bullmqJobId: string;
  jobAuthoritySha256: string;
}

interface DispatchEvidence {
  jobValidationId: string;
  workerInstanceId: string;
  recoveryLeaseId: string;
  dispatchAttemptId: string;
}

interface PublishClaim {
  bullmq_job_id: string;
  claim_number: number;
  job_authority_sha256: string;
  outbox_request_id: string;
  publish_claim_id: string;
}

let target: TargetRow;
let db: Pool;
let fixture: Awaited<ReturnType<typeof createUniversalV1DisposableDatabase>> | undefined;

async function currentTarget(): Promise<TargetRow> {
  const result = await db.query<TargetRow>(
    `SELECT target.authority_version,
            target.target_authority_id,
            target.target_database_name,
            target.environment,
            target.release_manifest_sha256
       FROM hx_authority.universal_v1_work_order_target_authority_facts target
      WHERE NOT EXISTS (
        SELECT 1
          FROM hx_authority.universal_v1_work_order_target_authority_facts successor
         WHERE successor.supersedes_target_authority_id = target.target_authority_id
      )`
  );
  if (result.rows.length > 1) throw new Error('V13_TEST_MULTIPLE_TARGET_TIPS');
  const existing = result.rows[0];
  if (existing) return existing;

  const inserted = await db.query<TargetRow>(
    `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts (
       authority_version,
       target_database_name,
       environment,
       release_manifest_sha256,
       activation_request_sha256
     ) VALUES (
       1,
       current_database(),
       'local',
       $1,
       $2
     )
     RETURNING authority_version, target_authority_id, target_database_name, environment,
               release_manifest_sha256`,
    [`sha256:${'b'.repeat(64)}`, createHash('sha256').update(randomUUID()).digest('hex')]
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('V13_TEST_TARGET_INSERT_INCOMPLETE');
  return row;
}

async function installFreshFoundation(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inventory = await client.query(
      'SELECT to_regclass(name) AS relation FROM unnest($1::text[]) names(name)',
      [v13Relations]
    );
    expect(inventory.rows.every((row) => row.relation === null)).toBe(true);
    await client.query(migration);
    await client.query(
      `INSERT INTO public.hxos_fake_financial_schema_evidence_v13
      (migration_name,migration_sql_sha256) VALUES ($1,$2)`,
      [migrationName, migrationSha256]
    );
    await client.query('INSERT INTO public.applied_migrations(name,sha256) VALUES ($1,$2)', [
      migrationName,
      migrationSha256,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function taskDraftFixtureDatabase(queryable: Pick<Pool, 'query'>): Database {
  const query: QueryFn = async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    const result = await queryable.query(sql, params);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  };
  const transaction = async <T>(callback: (query: QueryFn) => Promise<T>) => {
    // Alternate clients here are already owned transactions used to prove
    // uncommitted request boundaries. Never commit their surrounding work.
    if (queryable !== db) return callback(query);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(
        async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          const reply = await client.query(sql, params);
          return { rows: reply.rows as Row[], rowCount: reply.rowCount ?? 0 };
        }
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return { query, readQuery: query, transaction, serializableTransaction: transaction } as Database;
}
type FinancialTaskFixture = Awaited<ReturnType<typeof createAcceptedEstimateFixture>>;
async function prepareQueuedCommand(
  queryable: Pick<Pool, 'query'> = db,
  task?: FinancialTaskFixture,
  witnessKey?: string,
  authentication?: { database: Database; attester: Pick<Client, 'query'>; attesterRole: string }
) {
  const owner =
    task ??
    (await createClaimedTaskDraftFixture(
      taskDraftFixtureDatabase(queryable),
      queryable,
      'financial-preparation'
    ));
  const actorId = owner.posterUserId;
  const taskDraftId = owner.draftId;
  const operationId = witnessKey ? deterministicUuid(witnessKey, 'prepare') : randomUUID();
  const idempotencyKey = witnessKey ? witnessKey + ':prep' : 'fake-outbox:' + randomUUID();
  const canonicalRequest = canonicalFinancialProviderRequestJson({
    operationId,
    idempotencyKey,
    expectedVersion: 0,
    customerId: actorId,
  });
  const providerRequestSha256 = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  // Adversarial setup uses an owner-backed synthetic attester; the positive
  // monetary journey explicitly supplies restricted API/attester connections.
  const database = authentication?.database ?? taskDraftFixtureDatabase(queryable);
  const handle = await createSyntheticActorAttestation(
    queryable,
    database,
    authentication?.attester ?? queryable,
    authentication?.attesterRole ?? 'hx_ci_runner',
    target.release_manifest_sha256,
    actorId
  );
  const receipt = await new PostgresUniversalV1PreparedFinancialCommandAuthority(database).prepare(
    {
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId,
      providerKind: 'FAKE',
      idempotencyKey,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 0,
      providerRequestSha256,
      taskDraftId,
      recordedBy: actorId,
      taskId: task?.taskId ?? null,
      eligibilityDecisionId: task?.eligibilityDecisionId ?? null,
      scopeVersionId: task?.scopeVersionId ?? null,
      changeOrderId: null,
      predecessorEventId: null,
      completionFactId: null,
      relatedOperationId: null,
      amountCents: null,
      currency: null,
    },
    handle
  );
  const preparedRow = {
    prepared_command_id: receipt.preparedCommandId,
    authority_context_sha256: receipt.authorityContextSha256,
  };

  const canonicalIdentity = JSON.stringify({
    schemaVersion: 1,
    operationKind: 'PREPARE_PAYMENT_METHOD',
    operationId,
    providerKind: 'FAKE',
    idempotencyKey,
    providerExpectedVersion: 0,
    requestSha256: providerRequestSha256,
    evidence: {
      preparedFinancialCommandId: preparedRow.prepared_command_id,
      preparedAuthoritySha256: preparedRow.authority_context_sha256,
      taskDraftId,
      taskId: task?.taskId ?? null,
      workOrderId: null,
      relatedOperationId: null,
      amountCents: null,
      currency: null,
    },
    actor: { actorId, actorKind: 'PARTICIPANT' },
    release: {
      manifestDigest: target.release_manifest_sha256,
      releaseId: 'v13.test.' + randomUUID(),
      revision: 'd'.repeat(40),
      environment: target.environment,
      authenticationStatus: 'VERIFIED',
    },
  });
  return {
    canonicalRequest,
    canonicalIdentity,
    preparedCommandId: preparedRow.prepared_command_id,
    idempotencyKey,
  };
}

async function retireRequestValidationFixture(commandId: string): Promise<void> {
  const claim = await db.query(
    'SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,300)',
    [randomUUID()]
  );
  expect(claim.rows[0]?.command_id).toBe(commandId);
  await db.query(
    `SELECT public.hxos_record_fake_financial_publish_outcome_v13(
    $1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_TRANSPORT_FAILURE',NULL)`,
    [claim.rows[0]!.publish_claim_id]
  );
}

async function createQueuedCommand(
  claimLeaseSeconds: number | null = 300,
  queryable: Pick<Pool, 'query'> = db,
  task?: FinancialTaskFixture,
  preparedOverride?: Awaited<ReturnType<typeof prepareQueuedCommand>>
): Promise<QueuedCommand> {
  const prepared = preparedOverride ?? (await prepareQueuedCommand(queryable, task));
  const requested = await queryable.query<{ command_id: string }>(
    'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
    [prepared.canonicalRequest, prepared.canonicalIdentity]
  );
  const commandId = requested.rows[0]?.command_id;
  if (!commandId) throw new Error('V13_TEST_REQUESTED_INSERT_INCOMPLETE');
  const outbox = await queryable.query<{
    outbox_request_id: string;
    bullmq_job_id: string;
    job_authority_sha256: string;
  }>(
    `SELECT outbox_request_id,
            bullmq_job_id,
            btrim(job_authority_sha256) AS job_authority_sha256
       FROM hx_authority.fake_financial_command_outbox_requests_v13
      WHERE command_id=$1`,
    [commandId]
  );
  const outboxRow = outbox.rows[0];
  if (!outboxRow) throw new Error('V13_TEST_OUTBOX_CAPTURE_INCOMPLETE');
  if (claimLeaseSeconds === null) {
    return {
      commandId,
      outboxRequestId: outboxRow.outbox_request_id,
      publishClaimId: null,
      bullmqJobId: outboxRow.bullmq_job_id,
      jobAuthoritySha256: outboxRow.job_authority_sha256,
    };
  }
  const claim = await queryable.query<PublishClaim>(
    `SELECT *
       FROM hx_authority.claim_fake_financial_outbox_v13($1,$2)`,
    [randomUUID(), claimLeaseSeconds]
  );
  expect(claim.rowCount).toBe(1);
  const claimRow = claim.rows[0];
  if (!claimRow) throw new Error('V13_TEST_PUBLISH_CLAIM_INCOMPLETE');
  expect(claimRow).toMatchObject({
    bullmq_job_id: outboxRow.bullmq_job_id,
    claim_number: 1,
    job_authority_sha256: outboxRow.job_authority_sha256,
    outbox_request_id: outboxRow.outbox_request_id,
  });
  return {
    commandId,
    outboxRequestId: outboxRow.outbox_request_id,
    publishClaimId: claimRow.publish_claim_id,
    bullmqJobId: outboxRow.bullmq_job_id,
    jobAuthoritySha256: outboxRow.job_authority_sha256,
  };
}

async function recordDispatch(
  command: QueuedCommand,
  bullmqAttemptNumber = 0,
  queryable: Pick<Pool, 'query'> = db,
  leaseSeconds = 30,
  outcomeTimeoutSeconds = 10
): Promise<DispatchEvidence> {
  const workerInstanceId = randomUUID();
  const result = await queryable.query<{
    job_validation_id: string;
    recovery_lease_id: string;
    dispatch_attempt_id: string;
  }>(
    `SELECT *
       FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13(
         $1,$2,$3,$4,$5,$6,$7
       )`,
    [
      command.outboxRequestId,
      command.bullmqJobId,
      command.jobAuthoritySha256,
      workerInstanceId,
      bullmqAttemptNumber,
      leaseSeconds,
      outcomeTimeoutSeconds,
    ]
  );
  expect(result.rowCount).toBe(1);
  const row = result.rows[0];
  if (!row) throw new Error('V13_TEST_DISPATCH_EVIDENCE_INCOMPLETE');
  return {
    jobValidationId: row.job_validation_id,
    workerInstanceId,
    recoveryLeaseId: row.recovery_lease_id,
    dispatchAttemptId: row.dispatch_attempt_id,
  };
}

async function evidenceCounts(commandId: string): Promise<{
  admissions: number;
  leases: number;
  attempts: number;
  validations: number;
}> {
  const result = await db.query<{
    admissions: number;
    leases: number;
    attempts: number;
    validations: number;
  }>(
    `SELECT
       (SELECT count(*)::int
          FROM hx_authority.fake_financial_dispatch_admissions_v13 admission
         WHERE admission.command_id=$1) AS admissions,
       (SELECT count(*)::int
          FROM public.financial_provider_command_recovery_leases lease
         WHERE lease.command_id=$1) AS leases,
       (SELECT count(*)::int
          FROM public.financial_provider_command_dispatch_attempts attempt
         WHERE attempt.command_id=$1) AS attempts,
       (SELECT count(*)::int
          FROM hx_authority.fake_financial_job_validations_v13 validation
         WHERE validation.command_id=$1) AS validations`,
    [commandId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('V13_TEST_EVIDENCE_COUNT_INCOMPLETE');
  return row;
}

describePg('Universal V1 fake-financial command outbox authority v13 PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await createUniversalV1DisposableDatabase({
      throughFinancialMigration: '20261015_universal_v1_work_order_bootstrap_seal_v1',
    });
    db = fixture.pool;
    const legacyDatabase = {
      query: db.query.bind(db),
      transaction: async <T>(callback: (query: QueryFn) => Promise<T>) => {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const query: QueryFn = async <R>(sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
          };
          const result = await callback(query);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    } as unknown as Database;
    legacyProjectionRepository = new PostgresFakeFinancialOperationRepository(legacyDatabase);
    await new FakeFinancialProvider(legacyProjectionRepository).preparePaymentMethod(
      legacyProjectionRequest
    );
    legacyProjectionEvent = (await legacyProjectionRepository.findByIdempotencyKey(
      legacyProjectionRequest.idempotencyKey
    ))!;
    expect(legacyProjectionEvent.projectionContractVersion).toBe(1);
    expect(
      (
        await db.query(
          "SELECT to_jsonb(raw) ? 'projection_contract_version' AS present FROM public.hxos_fake_financial_operation_events_v1 raw WHERE event_id=$1",
          [legacyProjectionEvent.eventId]
        )
      ).rows
    ).toEqual([{ present: false }]);
    sealedGuardDefinitions = (
      await db.query<{ identity: string; definition: string }>(
        `SELECT identity,pg_get_functiondef(to_regprocedure(identity)) AS definition
       FROM unnest($1::text[]) identities(identity) ORDER BY identity`,
        [[...normalizedGuardIdentities]]
      )
    ).rows;
    executionDependencyGuardDefinitions = (
      await db.query<{ identity: string; definition: string }>(
        `SELECT identity,pg_get_functiondef(to_regprocedure(identity)) AS definition
        FROM unnest($1::text[]) identities(identity) ORDER BY identity`,
        [
          [
            'public.validate_universal_v1_fake_terminal_lifecycle_intent()',
            'public.validate_universal_v1_fake_provider_account_fact()',
            'public.validate_fake_financial_legacy_expiry_compensation_v9()',
            'public.validate_fake_financial_legacy_expiry_disposition_v9()',
            'public.validate_fake_financial_legacy_expiry_noncompensable_v10()',
          ],
        ]
      )
    ).rows;
  }, 120_000);
  afterAll(async () => {
    await fixture?.close();
  });

  describe('migration predecessor enforcement', () => {
    const expectNoV13Installation = async (): Promise<void> => {
      const relations = await db.query(
        'SELECT to_regclass(name) AS object FROM unnest($1::text[]) names(name)',
        [v13Relations]
      );
      const functions = await db.query(
        'SELECT to_regprocedure(name) AS object FROM unnest($1::text[]) names(name)',
        [v13Functions]
      );
      expect([...relations.rows, ...functions.rows].every((row) => row.object === null)).toBe(true);
      expect(
        (await db.query('SELECT * FROM public.applied_migrations WHERE name=$1', [migrationName]))
          .rowCount
      ).toBe(0);
    };

    it('removes hostile global and schema default ACLs from every new authority object', async () => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE ROLE "${hostileAclRole}" NOLOGIN`);
        for (const scope of ['', 'IN SCHEMA public', 'IN SCHEMA hx_authority']) {
          await client.query(
            `ALTER DEFAULT PRIVILEGES ${scope} GRANT ALL ON TABLES TO "${hostileAclRole}"`
          );
          await client.query(
            `ALTER DEFAULT PRIVILEGES ${scope} GRANT ALL ON FUNCTIONS TO "${hostileAclRole}"`
          );
        }
        await client.query(migration);
        const acl = await client.query(
          `WITH objects AS (
          SELECT relation.relowner AS owner, relation.relacl AS acl, 'r'::"char" AS kind
          FROM pg_catalog.pg_class relation WHERE relation.oid IN
            (SELECT to_regclass(name) FROM unnest($1::text[]) names(name))
          UNION ALL
          SELECT function.proowner, function.proacl, 'f'::"char"
          FROM pg_catalog.pg_proc function WHERE function.oid IN
            (SELECT to_regprocedure(name) FROM unnest($2::text[]) names(name))
        ) SELECT (SELECT count(*)::integer FROM objects) AS object_count,
          count(*)::integer AS non_owner_grants
          FROM objects CROSS JOIN LATERAL
            pg_catalog.aclexplode(COALESCE(acl, pg_catalog.acldefault(kind,owner))) privilege
          WHERE privilege.grantee <> owner`,
          [v13Relations, v13Functions]
        );
        expect(acl.rows).toEqual([
          {
            object_count: v13Relations.length + v13Functions.length,
            non_owner_grants: 0,
          },
        ]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await expectNoV13Installation();
      expect(
        (await db.query('SELECT to_regrole($1) AS role', [hostileAclRole])).rows[0]!.role
      ).toBeNull();
    });

    it('rejects inherited object-owner authority and rolls back the entire installation', async () => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE ROLE "${hostileAclRole}" NOLOGIN`);
        await client.query(`GRANT hx_ci_runner TO "${hostileAclRole}"`);
        await expect(client.query(migration)).rejects.toThrow(
          /object owner.*membership|owner membership/iu
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await expectNoV13Installation();
      expect(
        (await db.query('SELECT to_regrole($1) AS role', [hostileAclRole])).rows[0]!.role
      ).toBeNull();
    });

    it('restores predecessor guards and removes all v13 evidence on a late installation failure', async () => {
      const guardSql = `SELECT pg_get_functiondef(
        'public.assert_financial_provider_command_recovery_lease()'::regprocedure) AS definition`;
      const previousGuard = (await db.query(guardSql)).rows;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration);
        await client.query(
          `INSERT INTO public.hxos_fake_financial_schema_evidence_v13
          (migration_name,migration_sql_sha256) VALUES ($1,$2)`,
          [migrationName, migrationSha256]
        );
        await client.query('INSERT INTO public.applied_migrations(name,sha256) VALUES ($1,$2)', [
          migrationName,
          migrationSha256,
        ]);
        await expect(client.query("SELECT 'SYNTHETIC_INSTALL_FAILURE'::integer")).rejects.toThrow(
          /invalid input syntax/u
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await expectNoV13Installation();
      expect((await db.query(guardSql)).rows).toEqual(previousGuard);
    });

    it.each(
      [
        '20261014_universal_v1_work_order_command_ports_v1',
        '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
        '20261015_universal_v1_work_order_bootstrap_seal_v1',
      ].flatMap((name) =>
        ['missing', 'wrong', 'null', 'duplicate'].map((state) => ({ name, state }))
      )
    )('rejects $state hash for $name without installing v13', async ({ name, state }) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        if (state === 'missing') {
          await client.query('DELETE FROM public.applied_migrations WHERE name=$1', [name]);
        } else if (state === 'duplicate') {
          // Hostile schema drift is confined to this transaction and rolled back.
          await client.query(
            'ALTER TABLE public.applied_migrations DROP CONSTRAINT applied_migrations_pkey'
          );
          await client.query(
            'INSERT INTO public.applied_migrations(name,sha256) SELECT name,sha256 FROM public.applied_migrations WHERE name=$1',
            [name]
          );
        } else {
          await client.query('UPDATE public.applied_migrations SET sha256=$2 WHERE name=$1', [
            name,
            state === 'null' ? null : 'f'.repeat(64),
          ]);
        }
        await expect(client.query(migration)).rejects.toThrow(
          /exact applied predecessor hash is absent/u
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      const inventory = await db.query(
        'SELECT to_regclass(name) AS relation FROM unnest($1::text[]) names(name)',
        [v13Relations]
      );
      expect(inventory.rows.every((row) => row.relation === null)).toBe(true);
      expect(
        (await db.query('SELECT * FROM public.applied_migrations WHERE name=$1', [migrationName]))
          .rowCount
      ).toBe(0);
    });
  });

  describe('installed runtime authority', () => {
    beforeAll(async () => {
      await installFreshFoundation();
      const sealing = await db.query<{
        admission_owner_only: boolean;
        lease_guard_security_invoker: boolean;
        worker_owner_only: boolean;
        worker_security_definer: boolean;
      }>(
        `SELECT
         worker.prosecdef AS worker_security_definer,
         lease_guard.prosecdef IS FALSE AS lease_guard_security_invoker,
         NOT EXISTS (
           SELECT 1
             FROM pg_catalog.aclexplode(COALESCE(
               worker.proacl,
               pg_catalog.acldefault('f', worker.proowner)
             )) privilege
            WHERE privilege.grantee <> worker.proowner
         ) AS worker_owner_only,
         NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_class admission_relation
             CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
               admission_relation.relacl,
               pg_catalog.acldefault('r', admission_relation.relowner)
             )) privilege
            WHERE admission_relation.oid = pg_catalog.to_regclass(
              'hx_authority.fake_financial_dispatch_admissions_v13'
            )
              AND privilege.grantee <> admission_relation.relowner
         ) AS admission_owner_only
       FROM pg_catalog.pg_proc worker
       CROSS JOIN pg_catalog.pg_proc lease_guard
      WHERE worker.oid = pg_catalog.to_regprocedure(
              'hx_authority.record_fake_financial_job_dispatch_evidence_v13(uuid,text,text,uuid,integer,integer,integer)'
            )
        AND lease_guard.oid = pg_catalog.to_regprocedure(
              'public.assert_financial_provider_command_recovery_lease()'
            )`
      );
      expect(sealing.rows).toEqual([
        {
          admission_owner_only: true,
          lease_guard_security_invoker: true,
          worker_owner_only: true,
          worker_security_definer: true,
        },
      ]);
      target = await currentTarget();
      expect(target.target_database_name).toBe(
        (await db.query<{ database_name: string }>('SELECT current_database() AS database_name'))
          .rows[0]?.database_name
      );
    });

    it.each(
      [
        '20261014_universal_v1_work_order_command_ports_v1',
        '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
        '20261015_universal_v1_work_order_bootstrap_seal_v1',
        migrationName,
      ].flatMap((name) =>
        ['missing', 'wrong', 'null', 'duplicate'].map((state) => ({ name, state }))
      )
    )('refuses runtime authority with $state ledger hash for $name', async ({ name, state }) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        if (state === 'missing') {
          await client.query('DELETE FROM public.applied_migrations WHERE name=$1', [name]);
        } else if (state === 'duplicate') {
          // Restore the primary key and the original rows together on rollback.
          await client.query(
            'ALTER TABLE public.applied_migrations DROP CONSTRAINT applied_migrations_pkey'
          );
          await client.query(
            'INSERT INTO public.applied_migrations(name,sha256) SELECT name,sha256 FROM public.applied_migrations WHERE name=$1',
            [name]
          );
        } else {
          await client.query('UPDATE public.applied_migrations SET sha256=$2 WHERE name=$1', [
            name,
            state === 'null' ? null : 'f'.repeat(64),
          ]);
        }
        for (const [sql, values] of [
          ['SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,30)', [randomUUID()]],
          [
            'SELECT * FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()',
            [],
          ],
        ] as const) {
          await client.query('SAVEPOINT authority_check');
          await expect(client.query(sql, [...values])).rejects.toThrow(
            /exact applied predecessor drifted|exact sealed predecessor\/v13 migration evidence is absent|exact runtime migration ledger drifted/u
          );
          await client.query('ROLLBACK TO SAVEPOINT authority_check');
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(
        (await db.query('SELECT * FROM hx_authority.fake_financial_outbox_publish_claims_v13'))
          .rowCount
      ).toBe(0);
    });

    it('preserves actual pre-column raw events as exact immutable projection contract 1 after v13 installation', async () => {
      const event = (await legacyProjectionRepository.findByIdempotencyKey(
        legacyProjectionRequest.idempotencyKey
      ))!;
      expect(event).toEqual(legacyProjectionEvent);
      expect(
        (
          await db.query(
            'SELECT projection_contract_version FROM public.hxos_fake_financial_operation_events_v1 WHERE event_id=$1',
            [event.eventId]
          )
        ).rows
      ).toEqual([{ projection_contract_version: 1 }]);
      const exact = encodeFakeFinancialDurableRequest(
        'PREPARE_PAYMENT_METHOD',
        legacyProjectionRequest
      );
      expect(
        resultFromExactStoredFakeFinancialOperation(
          event,
          'PREPARE_PAYMENT_METHOD',
          legacyProjectionRequest,
          exact.providerRequestSha256
        ).state
      ).toBe('SUCCEEDED');
      for (const version of [null, 0, 3])
        await expect(
          db.query('SELECT hx_authority.derive_fake_financial_projection_v13($1,$2,$3::smallint)', [
            'PREPARE_PAYMENT_METHOD',
            exact.canonicalRequestJson,
            version,
          ])
        ).rejects.toThrow('CONTRACT_VERSION_INVALID');
    });

    it('commits exact request bytes and outbox with REQUESTED after separately committed PREPARED', async () => {
      const prepared = await prepareQueuedCommand();
      const first = await db.query(
        'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
        [prepared.canonicalRequest, prepared.canonicalIdentity]
      );
      const row = first.rows[0]!;
      expect(row.idempotency_replayed).toBe(false);
      const facts = await db.query(
        `SELECT exact_request.canonical_provider_request,
        exact_request.provider_request_sha256::text AS provider_request_sha256,
        journal.requested_transaction_id = exact_request.recorded_transaction_id AS same_transaction,
        outbox.command_id AS outbox_command_id
        FROM public.financial_provider_command_journal journal
        JOIN hx_authority.fake_financial_exact_requests_v13 exact_request USING(command_id)
        JOIN hx_authority.fake_financial_command_outbox_requests_v13 outbox USING(command_id)
        WHERE journal.command_id=$1`,
        [row.command_id]
      );
      expect(facts.rows).toEqual([
        {
          canonical_provider_request: prepared.canonicalRequest,
          provider_request_sha256: createHash('sha256')
            .update(prepared.canonicalRequest)
            .digest('hex'),
          same_transaction: true,
          outbox_command_id: row.command_id,
        },
      ]);
      const replay = await db.query(
        'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
        [prepared.canonicalRequest, prepared.canonicalIdentity]
      );
      expect(replay.rows).toEqual([{ ...row, idempotency_replayed: true }]);
      for (const sql of [
        'UPDATE hx_authority.fake_financial_exact_requests_v13 SET recorded_at=clock_timestamp() WHERE command_id=$1',
        'DELETE FROM hx_authority.fake_financial_exact_requests_v13 WHERE command_id=$1',
      ])
        await expect(db.query(sql, [row.command_id])).rejects.toThrow('append-only');
      await expect(
        db.query('TRUNCATE hx_authority.fake_financial_exact_requests_v13')
      ).rejects.toThrow('append-only');
      await expect(
        db.query(
          `INSERT INTO hx_authority.fake_financial_exact_requests_v13
        SELECT * FROM hx_authority.fake_financial_exact_requests_v13 WHERE command_id=$1`,
          [row.command_id]
        )
      ).rejects.toThrow('SAME_TRANSACTION_REQUIRED');
      await retireRequestValidationFixture(row.command_id);
    });

    it('serializes concurrent exact submissions to one durable request and outbox identity', async () => {
      const prepared = await prepareQueuedCommand();
      const submissions = await Promise.all(
        Array.from({ length: 4 }, () =>
          db.query('SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)', [
            prepared.canonicalRequest,
            prepared.canonicalIdentity,
          ])
        )
      );
      const rows = submissions.map((result) => result.rows[0]!);
      expect(new Set(rows.map((row) => row.command_id)).size).toBe(1);
      expect(rows.filter((row) => !row.idempotency_replayed)).toHaveLength(1);
      expect(rows.filter((row) => row.idempotency_replayed)).toHaveLength(3);
      await retireRequestValidationFixture(rows[0]!.command_id);
    });

    it.each(['idempotency', 'operation-version'] as const)(
      'rejects a changed %s identity without another command',
      async (conflict) => {
        const prepared = await prepareQueuedCommand();
        const committed = await db.query(
          'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
          [prepared.canonicalRequest, prepared.canonicalIdentity]
        );
        const request = JSON.parse(prepared.canonicalRequest) as Record<string, unknown>;
        const identity = JSON.parse(prepared.canonicalIdentity);
        if (conflict === 'idempotency') request.customerId = randomUUID();
        else request.idempotencyKey = identity.idempotencyKey = 'different:' + randomUUID();
        const changed = canonicalFinancialProviderRequestJson(request);
        identity.requestSha256 = createHash('sha256').update(changed).digest('hex');
        await expect(
          db.query('SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)', [
            changed,
            JSON.stringify(identity),
          ])
        ).rejects.toThrow(
          conflict === 'idempotency' ? 'IDEMPOTENCY_CONFLICT' : 'OPERATION_VERSION_CONFLICT'
        );
        expect(
          (
            await db.query(
              'SELECT command_id FROM public.financial_provider_command_journal WHERE prepared_financial_command_id=$1',
              [prepared.preparedCommandId]
            )
          ).rowCount
        ).toBe(1);
        await retireRequestValidationFixture(committed.rows[0]!.command_id);
      }
    );

    it.each(['duplicate', 'extra-field', 'wrong-hash', 'identity-order'] as const)(
      'rejects %s before a REQUESTED or outbox commit',
      async (variant) => {
        const prepared = await prepareQueuedCommand();
        let request = prepared.canonicalRequest;
        let identity = prepared.canonicalIdentity;
        if (variant === 'duplicate') request = request.replace('{', '{"customerId":"other",');
        if (variant === 'extra-field')
          request = canonicalFinancialProviderRequestJson({
            ...JSON.parse(request),
            actorId: randomUUID(),
          });
        if (variant === 'wrong-hash') {
          const changed = JSON.parse(identity);
          changed.requestSha256 = 'f'.repeat(64);
          identity = JSON.stringify(changed);
        }
        if (variant === 'identity-order')
          identity = canonicalFinancialProviderRequestJson(JSON.parse(identity));
        await expect(
          db.query('SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)', [
            request,
            identity,
          ])
        ).rejects.toThrow('HXUV1-FINREQ-13-');
        expect(
          (
            await db.query(
              'SELECT command_id FROM public.financial_provider_command_journal WHERE prepared_financial_command_id=$1',
              [prepared.preparedCommandId]
            )
          ).rowCount
        ).toBe(0);
        expect(
          (
            await db.query(
              'SELECT outbox_request_id FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE prepared_command_id=$1',
              [prepared.preparedCommandId]
            )
          ).rowCount
        ).toBe(0);
      }
    );

    it.each([
      'actor-case',
      'actor-braces',
      'prepared-id-braces',
      'padded-hash',
      'padded-revision',
    ] as const)(
      'rejects non-encoder identity spelling %s without reserving the command',
      async (variant) => {
        const prepared = await prepareQueuedCommand();
        const identity = JSON.parse(prepared.canonicalIdentity);
        if (variant === 'actor-case') identity.actor.actorId = identity.actor.actorId.toUpperCase();
        if (variant === 'actor-braces') identity.actor.actorId = '{' + identity.actor.actorId + '}';
        if (variant === 'prepared-id-braces')
          identity.evidence.preparedFinancialCommandId =
            '{' + identity.evidence.preparedFinancialCommandId + '}';
        if (variant === 'padded-hash') identity.evidence.preparedAuthoritySha256 += ' ';
        if (variant === 'padded-revision') identity.release.revision += ' ';
        await expect(
          db.query('SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)', [
            prepared.canonicalRequest,
            JSON.stringify(identity),
          ])
        ).rejects.toThrow('COMMAND_IDENTITY_INVALID');
        expect(
          (
            await db.query(
              'SELECT command_id FROM public.financial_provider_command_journal WHERE prepared_financial_command_id=$1',
              [prepared.preparedCommandId]
            )
          ).rowCount
        ).toBe(0);
      }
    );

    it.each(FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS)(
      'reads exact application bytes for the %s request contract',
      async (kind) => {
        const operationId = randomUUID();
        const relatedOperationId = randomUUID();
        const common = {
          operationId,
          idempotencyKey: 'request-parity:' + randomUUID(),
          expectedVersion: 0,
          scenario: 'SUCCESS',
        };
        const extras: Record<string, Record<string, unknown>> = {
          AUTHORIZE: { paymentMethodReference: 'fake-method-reference' },
          SECURE: { authorizationOperationId: relatedOperationId },
          ADJUST: { scopeVersionId: randomUUID(), changeOrderId: randomUUID() },
          REFUND: { originalAmountCents: 9007199254740991 },
          PAYOUT: { providerAccountReference: 'fake-provider-account-reference' },
        };
        const request =
          kind === 'PREPARE_PAYMENT_METHOD'
            ? { ...common, customerId: 'fake-customer' }
            : {
                ...common,
                amountCents: 9007199254740991,
                currency: 'usd',
                relatedOperationId,
                ...extras[kind],
              };
        const encoded = encodeFakeFinancialDurableRequest(kind, request);
        const readback = await db.query(
          'SELECT hx_authority.parse_fake_financial_request_v13($1,$2) AS request',
          [kind, encoded.canonicalRequestJson]
        );
        expect(readback.rows).toEqual([{ request }]);
      }
    );

    it.each(
      FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS.flatMap((kind) =>
        ([1, 2] as const).map((projectionContractVersion) => ({ kind, projectionContractVersion }))
      )
    )(
      'derives exact projection contract $projectionContractVersion for $kind',
      async ({ kind, projectionContractVersion }) => {
        const methods = {
          PREPARE_PAYMENT_METHOD: 'preparePaymentMethod',
          AUTHORIZE: 'authorize',
          SECURE: 'secure',
          VOID: 'void',
          ADJUST: 'adjust',
          CAPTURE: 'capture',
          REFUND: 'refund',
          REVERSAL: 'reverse',
          SETTLE: 'settle',
          FUND: 'fund',
          PROVIDER_RELEASE: 'releaseProvider',
          PAYOUT: 'payout',
          OBSERVE_BANK_SETTLEMENT: 'observeBankSettlement',
        } as const;
        for (const scenario of [
          undefined,
          ...FAKE_FINANCIAL_SCENARIO_VALUES.filter((value) =>
            fakeFinancialScenarioSupportsOperation(value, kind)
          ),
        ]) {
          for (const expectedVersion of [0, 1]) {
            const relatedOperationId = randomUUID().toUpperCase();
            const common = {
              operationId: randomUUID().toUpperCase(),
              idempotencyKey: 'projection-parity:' + randomUUID(),
              expectedVersion,
              ...(scenario === undefined ? {} : { scenario }),
            };
            const extras: Record<string, Record<string, unknown>> = {
              AUTHORIZE: { paymentMethodReference: 'fake-😀-é-\u000bx' },
              SECURE: { authorizationOperationId: relatedOperationId },
              ADJUST: { scopeVersionId: randomUUID(), changeOrderId: randomUUID() },
              REFUND: { originalAmountCents: 9007199254740991 },
              PAYOUT: { providerAccountReference: 'fake-account-😀-é' },
            };
            const request =
              kind === 'PREPARE_PAYMENT_METHOD'
                ? { ...common, customerId: 'fake-😀-é-\u000bx' }
                : {
                    ...common,
                    amountCents: 9007199254740991,
                    currency: 'usd',
                    relatedOperationId,
                    ...extras[kind],
                  };
            const encoded = encodeFakeFinancialDurableRequest(kind, request);
            let captured: FakeFinancialRepositoryCommand | undefined;
            const provider = new FakeFinancialProvider(
              {
                execute: async (command) => {
                  captured = command;
                  throw Error('PROJECTION_CAPTURED');
                },
                findByIdempotencyKey: async () => null,
              },
              projectionContractVersion
            );
            await expect(provider[methods[kind]](request as never)).rejects.toThrow(
              'PROJECTION_CAPTURED'
            );
            const derived = await db.query(
              'SELECT hx_authority.derive_fake_financial_projection_v13($1,$2,$3::smallint) AS projection',
              [kind, encoded.canonicalRequestJson, projectionContractVersion]
            );
            expect(derived.rows).toEqual([{ projection: captured }]);
            if (projectionContractVersion === 1) {
              const legacy = await db.query(
                'SELECT hx_authority.derive_fake_financial_projection_v13($1,$2) AS projection',
                [kind, encoded.canonicalRequestJson]
              );
              const { projectionContractVersion: _version, ...unversioned } = captured!;
              expect(legacy.rows).toEqual([{ projection: unversioned }]);
            } else {
              expect(captured!.retryable).toBe(
                ['PENDING', 'RETRYABLE_FAILURE'].includes(captured!.state)
              );
              if (
                scenario === 'RETRY' &&
                expectedVersion === 1 &&
                ['VOID', 'REFUND', 'REVERSAL'].includes(kind)
              )
                expect(captured!.state).toBe(
                  (
                    { VOID: 'VOIDED', REFUND: 'REFUNDED', REVERSAL: 'REVERSED' } as Record<
                      string,
                      string
                    >
                  )[kind]
                );
              const legacy = await db.query(
                'SELECT hx_authority.derive_fake_financial_projection_v13($1,$2) AS projection',
                [kind, encoded.canonicalRequestJson]
              );
              expect(captured!.responseSha256).not.toBe(legacy.rows[0]!.projection.responseSha256);
              for (const key of [
                'identitySha256',
                'requestSha256',
                'providerRequestSha256',
              ] as const)
                expect(captured![key]).toBe(legacy.rows[0]!.projection[key]);
            }
          }
        }
      }
    );

    it('matches JavaScript reference validation and exact bytes for PostgreSQL Unicode strings', async () => {
      for (const customerId of ['vvv', '😀', 'é', '\u000bx\u000b', '\u00a0x\ufeff']) {
        const request = {
          customerId,
          operationId: randomUUID(),
          idempotencyKey: 'sql-parity:' + randomUUID(),
          expectedVersion: 0,
        };
        const encoded = encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', request);
        expect(
          (
            await db.query(
              'SELECT hx_authority.parse_fake_financial_request_v13($1,$2) AS request',
              ['PREPARE_PAYMENT_METHOD', encoded.canonicalRequestJson]
            )
          ).rows
        ).toEqual([{ request }]);
      }
      for (const customerId of [
        '\u0000',
        '\u000b',
        '\u00a0',
        '\u1680',
        '\u2000\u200a',
        '\u2028\u2029',
        '\u202f\u205f\u3000\ufeff',
      ]) {
        const request = {
          customerId,
          operationId: randomUUID(),
          idempotencyKey: 'sql-parity:' + randomUUID(),
          expectedVersion: 0,
        };
        expect(() =>
          encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', request)
        ).toThrow();
        await expect(
          db.query('SELECT hx_authority.parse_fake_financial_request_v13($1,$2)', [
            'PREPARE_PAYMENT_METHOD',
            canonicalFinancialProviderRequestJson(request),
          ])
        ).rejects.toThrow();
      }
    });

    it('rolls back legacy direct REQUESTED insertion lacking its exact request at commit', async () => {
      const prepared = await prepareQueuedCommand();
      const identity = JSON.parse(prepared.canonicalIdentity);
      const commandId = randomUUID();
      await expect(
        db.query(
          `SELECT * FROM public.hxos_record_financial_provider_command_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [
            commandId,
            identity.operationKind,
            identity.operationId,
            identity.providerKind,
            identity.idempotencyKey,
            identity.providerExpectedVersion,
            identity.requestSha256,
            createHash('sha256').update(prepared.canonicalIdentity).digest('hex'),
            identity.evidence.preparedFinancialCommandId,
            identity.evidence.preparedAuthoritySha256,
            identity.evidence.taskDraftId,
            null,
            null,
            null,
            null,
            null,
            identity.actor.actorId,
            identity.actor.actorKind,
            identity.release.manifestDigest,
            identity.release.releaseId,
            identity.release.revision,
            identity.release.environment,
            identity.release.authenticationStatus,
          ]
        )
      ).rejects.toThrow('EXACT_REQUEST_REQUIRED');
      expect(
        (
          await db.query(
            'SELECT command_id FROM public.financial_provider_command_journal WHERE command_id=$1',
            [commandId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await db.query(
            'SELECT command_id FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$1',
            [commandId]
          )
        ).rowCount
      ).toBe(0);
    });

    it('preserves complete sealed compensation and reversal guards while replacing four legacy hash calls', async () => {
      expect(sealedGuardDefinitions).toHaveLength(2);
      const preparation = sealedGuardDefinitions[0]!.definition;
      expect(preparation).toContain(
        'pre-Work-Order finance requires current eligibility or one exact compensation claim'
      );
      expect(preparation).toMatch(
        /IF NEW\.operation_kind IN \([^)]*'REVERSAL'[^)]*\) AND work_order\.id IS NULL/u
      );
      for (const before of sealedGuardDefinitions) {
        expect([...before.definition.matchAll(/(?<![\w.])digest\(/gu)]).toHaveLength(2);
        const after = await db.query<{ definition: string }>(
          'SELECT pg_get_functiondef(to_regprocedure($1)) AS definition',
          [before.identity]
        );
        expect(after.rows[0]!.definition).toBe(
          before.definition
            .replaceAll(/(?<![\w.])digest\(/gu, 'public.hxos_universal_v1_sha256_bytes_v1(')
            .replace(
              ' LANGUAGE plpgsql\nAS $function$',
              " LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'public'\nAS $function$"
            )
        );
      }
    });

    it('preserves all five complete execution and outcome dependency guards with only fixed-path SHA substitution', async () => {
      expect(executionDependencyGuardDefinitions).toHaveLength(5);
      for (const before of executionDependencyGuardDefinitions) {
        expect(before.definition).toMatch(/\bdigest\s*\(/u);
        const after = await db.query<{ definition: string }>(
          'SELECT pg_get_functiondef(to_regprocedure($1)) AS definition',
          [before.identity]
        );
        // The additive v13 copies use CRLF; the original bodies use LF.
        // Exact installed bytes are separately pinned by the catalog digest.
        expect(after.rows[0]!.definition.replaceAll('\r\n', '\n')).toBe(
          before.definition
            .replaceAll('\r\n', '\n')
            .replaceAll(/\b(?:public\.)?digest\s*\(/gu, 'public.hxos_universal_v1_sha256_bytes_v1(')
            .replace(
              ' LANGUAGE plpgsql\nAS $function$',
              " LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'public'\nAS $function$"
            )
        );
      }
    });

    it('reads the complete four-migration authority in a read-only repeatable-read snapshot', async () => {
      const client = await db.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query(
          'LOCK TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1 IN ACCESS SHARE MODE'
        );
        const result = await client.query(`SELECT * FROM
          public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()`);
        expect(result.rows).toEqual([
          {
            session_database_role: 'hx_ci_runner',
            target_authority_id: target.target_authority_id,
            authority_version: target.authority_version,
            target_database_name: target.target_database_name,
            environment: target.environment,
            release_manifest_sha256: target.release_manifest_sha256,
            ordinal146_sql_sha256:
              '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4',
            v12_sql_sha256: '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5',
            seal_sql_sha256: 'c69825589193885d0f6a3b93930880998e95e1c5cd44bb9b5999cb457192b2bd',
            v13_sql_sha256: migrationSha256,
            fake_financial_operations_relation: 'public.hxos_fake_financial_operations_v1',
            fake_financial_operation_events_relation:
              'public.hxos_fake_financial_operation_events_v1',
          },
        ]);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('requires outer COMMIT after a released publication savepoint before restoration', async () => {
      const command = await createQueuedCommand();
      const client = await db.connect();
      const args = [command.outboxRequestId, command.bullmqJobId, command.jobAuthoritySha256];
      const read = 'SELECT * FROM public.hxos_read_fake_financial_restoration_v13($1,$2,$3)';
      try {
        await expect(client.query(read, args)).rejects.toThrow('COMMITTED_CONFIRMATION_REQUIRED');
        await client.query('BEGIN');
        await client.query('SAVEPOINT publication');
        await client.query(
          "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)",
          [command.publishClaimId, command.bullmqJobId, command.jobAuthoritySha256]
        );
        await client.query('RELEASE SAVEPOINT publication');
        await client.query('SAVEPOINT refusal');
        await expect(client.query(read, args)).rejects.toThrow('COMMITTED_CONFIRMATION_REQUIRED');
        await client.query('ROLLBACK TO SAVEPOINT refusal');
        await client.query('COMMIT');
        const restored = (await client.query(read, args)).rows[0];
        expect(restored).toMatchObject({
          outbox_request_id: command.outboxRequestId,
          command_id: command.commandId,
          bullmq_job_id: command.bullmqJobId,
        });
        expect(restored).not.toHaveProperty('publish_claim_id');
        await expect(
          client.query(read, [command.outboxRequestId, 'wrong', command.jobAuthoritySha256])
        ).rejects.toThrow();
        await recordDispatch(command);
        await expect(client.query(read, args)).rejects.toThrow(
          'UNADMITTED_OR_FENCED_REQUEST_REQUIRED'
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
    it('cannot restore a publication rolled back to a savepoint or held by a terminal outcome', async () => {
      const command = await createQueuedCommand();
      const client = await db.connect();
      const args = [command.outboxRequestId, command.bullmqJobId, command.jobAuthoritySha256];
      try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT publication');
        await client.query(
          "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)",
          [command.publishClaimId, command.bullmqJobId, command.jobAuthoritySha256]
        );
        await client.query('ROLLBACK TO SAVEPOINT publication');
        await client.query('COMMIT');
        await expect(
          client.query(
            'SELECT * FROM public.hxos_read_fake_financial_restoration_v13($1,$2,$3)',
            args
          )
        ).rejects.toThrow('COMMITTED_CONFIRMATION_REQUIRED');
        await client.query(
          "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_HOLD',NULL)",
          [command.publishClaimId]
        );
        await expect(
          client.query(
            'SELECT * FROM public.hxos_read_fake_financial_restoration_v13($1,$2,$3)',
            args
          )
        ).rejects.toThrow();
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
    it('scans committed IDs with strict keyset pagination and exposes publication holds without granting dispatch', async () => {
      let cursor: string | null = null;
      const found: Array<{
        outbox_request_id: string;
        command_id: string;
        publication_held: boolean;
      }> = [];
      for (let page = 0; page < 200; page++) {
        const rows: typeof found = (
          await db.query('SELECT * FROM public.hxos_scan_fake_financial_recovery_v13($1,2)', [
            cursor,
          ])
        ).rows;
        for (const row of rows) {
          if (cursor) expect(row.outbox_request_id > cursor).toBe(true);
          cursor = row.outbox_request_id;
          found.push(row);
        }
        if (rows.length < 2) break;
      }
      expect(found.length).toBeGreaterThan(1);
      expect(new Set(found.map((r) => r.outbox_request_id)).size).toBe(found.length);
      expect(found.some((r) => r.publication_held)).toBe(true);
      await expect(
        db.query('SELECT * FROM public.hxos_scan_fake_financial_recovery_v13(NULL,101)')
      ).rejects.toThrow('INPUT_OR_ISOLATION_INVALID');
    });
    it('recovers one expired publisher lease with the same job identity and rejects forged Redis with zero dispatch writes', async () => {
      const command = await createQueuedCommand(1);
      const before = await evidenceCounts(command.commandId);
      await expect(
        db.query(
          `SELECT *
           FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13(
             $1,$2,$3,$4,0,30,10
           )`,
          [
            command.outboxRequestId,
            `hx-fake-fin-${'0'.repeat(32)}-${'0'.repeat(64)}`,
            '0'.repeat(64),
            randomUUID(),
          ]
        )
      ).rejects.toThrow(/forged, stale, or unpublished Redis job rejected/iu);
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(before);

      await db.query('SELECT pg_sleep(1.1)');
      const competingClaims = await Promise.all([
        db.query<PublishClaim>(
          `SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,30)`,
          [randomUUID()]
        ),
        db.query<PublishClaim>(
          `SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,30)`,
          [randomUUID()]
        ),
      ]);
      expect(competingClaims.map((result) => result.rowCount).sort()).toEqual([0, 1]);
      const recoveredClaim = competingClaims.flatMap((result) => result.rows)[0];
      expect(recoveredClaim).toMatchObject({
        bullmq_job_id: command.bullmqJobId,
        claim_number: 2,
        job_authority_sha256: command.jobAuthoritySha256,
        outbox_request_id: command.outboxRequestId,
      });
      if (!recoveredClaim) throw new Error('V13_TEST_RECOVERED_PUBLISH_CLAIM_INCOMPLETE');
      await expect(
        db.query(
          `SELECT hx_authority.record_fake_financial_publish_outcome_v13(
           $1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL
         )`,
          [
            recoveredClaim.publish_claim_id,
            recoveredClaim.bullmq_job_id,
            recoveredClaim.job_authority_sha256,
          ]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        db.query(`SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,30)`, [
          randomUUID(),
        ])
      ).resolves.toMatchObject({ rowCount: 0 });
    });

    it('rolls back REQUESTED and its captured outbox together before either becomes externally visible', async () => {
      const client = await db.connect();
      let command!: QueuedCommand;
      try {
        await client.query('BEGIN');
        command = await createQueuedCommand(null, client);
        for (const relation of [
          'public.financial_provider_command_journal',
          'hx_authority.fake_financial_command_outbox_requests_v13',
        ]) {
          expect(
            (
              await client.query(`SELECT * FROM ${relation} WHERE command_id=$1`, [
                command.commandId,
              ])
            ).rowCount
          ).toBe(1);
          expect(
            (await db.query(`SELECT * FROM ${relation} WHERE command_id=$1`, [command.commandId]))
              .rowCount
          ).toBe(0);
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      for (const relation of [
        'public.financial_provider_command_journal',
        'hx_authority.fake_financial_command_outbox_requests_v13',
      ])
        expect(
          (await db.query(`SELECT * FROM ${relation} WHERE command_id=$1`, [command.commandId]))
            .rowCount
        ).toBe(0);
    });

    it('admits exactly one concurrent worker replay and denies terminal publisher outcomes', async () => {
      const command = await createQueuedCommand();
      const outcomes = await Promise.allSettled([recordDispatch(command), recordDispatch(command)]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await evidenceCounts(command.commandId)).toMatchObject({
        admissions: 1,
        leases: 1,
        attempts: 1,
        validations: 1,
      });
      const held = await createQueuedCommand();
      await db.query(
        `SELECT hx_authority.record_fake_financial_publish_outcome_v13(
      $1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_TRANSPORT_FAILURE',NULL)`,
        [held.publishClaimId]
      );
      const before = await evidenceCounts(held.commandId);
      await expect(recordDispatch(held)).rejects.toThrow(/publication is terminally held/u);
      expect(await evidenceCounts(held.commandId)).toEqual(before);
    });

    it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
      'rejects a worker with a stale %s snapshot after a terminal hold commits',
      async (isolation) => {
        const command = await createQueuedCommand();
        const before = await evidenceCounts(command.commandId);
        const staleWorker = await db.connect();
        try {
          await staleWorker.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await staleWorker.query(
            'SELECT count(*) FROM hx_authority.fake_financial_outbox_publish_outcomes_v13'
          );
          await db.query(
            `SELECT hx_authority.record_fake_financial_publish_outcome_v13(
          $1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_TRANSPORT_FAILURE',NULL)`,
            [command.publishClaimId]
          );
          await expect(recordDispatch(command, 0, staleWorker)).rejects.toThrow(
            /publication requires READ COMMITTED|publication is terminally held/u
          );
        } finally {
          await staleWorker.query('ROLLBACK');
          staleWorker.release();
        }
        expect(await evidenceCounts(command.commandId)).toEqual(before);
      }
    );

    it('sees a terminal hold committed while a READ COMMITTED worker waits for the publisher lock', async () => {
      const command = await createQueuedCommand();
      const before = await evidenceCounts(command.commandId);
      const publisher = await db.connect();
      const worker = await db.connect();
      let dispatch: Promise<PromiseSettledResult<DispatchEvidence>[]> | undefined;
      try {
        await publisher.query('BEGIN');
        await publisher.query(
          `SELECT hx_authority.record_fake_financial_publish_outcome_v13(
        $1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_TRANSPORT_FAILURE',NULL)`,
          [command.publishClaimId]
        );
        await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const pid = (await worker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        dispatch = Promise.allSettled([recordDispatch(command, 0, worker)]);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const locks = await db.query(
            `SELECT 1 FROM pg_catalog.pg_locks
          WHERE pid=$1 AND locktype='advisory' AND NOT granted`,
            [pid]
          );
          if (locks.rowCount === 1) {
            waiting = true;
            break;
          }
          await db.query('SELECT pg_sleep(0.01)');
        }
        expect(waiting).toBe(true);
        await publisher.query('COMMIT');
        const result = (await dispatch)[0]!;
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(String(result.reason)).toMatch(/publication is terminally held/u);
      } finally {
        await publisher.query('ROLLBACK');
        if (dispatch) await dispatch;
        await worker.query('ROLLBACK');
        publisher.release();
        worker.release();
      }
      expect(await evidenceCounts(command.commandId)).toEqual(before);
    });

    it('keeps serializable business REQUESTED capture atomic while rejecting transport mutation', async () => {
      // PREPARED is separately authenticated and committed at READ COMMITTED;
      // REQUESTED and its outbox entry retain the business transaction boundary.
      const prepared = await prepareQueuedCommand();
      const client = await db.connect();
      let command!: QueuedCommand;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        command = await createQueuedCommand(null, client, undefined, prepared);
        expect(
          (
            await client.query(
              `SELECT * FROM hx_authority.fake_financial_command_outbox_requests_v13
        WHERE outbox_request_id=$1`,
              [command.outboxRequestId]
            )
          ).rowCount
        ).toBe(1);
        await expect(
          client.query('SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,30)', [
            randomUUID(),
          ])
        ).rejects.toThrow(/publication requires READ COMMITTED/u);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(
        (
          await db.query(
            `SELECT * FROM hx_authority.fake_financial_command_outbox_requests_v13
      WHERE outbox_request_id=$1`,
            [command.outboxRequestId]
          )
        ).rowCount
      ).toBe(0);
    });

    it('sealed admission rejects legacy direct initial and NULL-outcome DISPATCH with zero writes', async () => {
      const command = await createQueuedCommand();
      const beforeInitial = await evidenceCounts(command.commandId);
      await expect(
        db.query(
          `INSERT INTO public.financial_provider_command_recovery_leases (
           command_id,
           recovery_action,
           lease_owner_id,
           lease_duration_seconds,
           expires_at
         ) VALUES (
           $1,
           'DISPATCH',
           $2,
           30,
           clock_timestamp() + interval '30 seconds'
         )`,
          [command.commandId, randomUUID()]
        )
      ).rejects.toThrow(/DISPATCH requires one same-transaction sealed v13 admission/iu);
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(beforeInitial);

      await recordDispatch(command);
      const before = await evidenceCounts(command.commandId);
      await expect(
        db.query(
          `INSERT INTO public.financial_provider_command_recovery_leases (
           command_id,
           recovery_action,
           lease_owner_id,
           lease_duration_seconds,
           expires_at
         ) VALUES (
           $1,
           'DISPATCH',
           $2,
           30,
           clock_timestamp() + interval '30 seconds'
         )`,
          [command.commandId, randomUUID()]
        )
      ).rejects.toThrow(/DISPATCH requires one same-transaction sealed v13 admission/iu);
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(before);
    });

    it('rejects an exact BullMQ replay after DISPATCH_ATTEMPTED with zero writes', async () => {
      const command = await createQueuedCommand();
      await recordDispatch(command);
      const before = await evidenceCounts(command.commandId);
      await expect(
        db.query(
          `SELECT *
           FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13(
             $1,$2,$3,$4,1,30,10
           )`,
          [command.outboxRequestId, command.bullmqJobId, command.jobAuthoritySha256, randomUUID()]
        )
      ).rejects.toThrow(/Redis replay lacks a due confirmed-no-effect outcome/iu);
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(before);
    });

    it('allows redispatch only after an explicit due retryable FAILED CONFIRMED_NO_EFFECT outcome', async () => {
      const command = await createQueuedCommand();
      const dispatch = await recordDispatch(command);
      await db.query(
        `INSERT INTO public.financial_provider_command_outcome_facts (
         command_id,
         dispatch_attempt_id,
         recovery_lease_id,
         outcome_kind,
         observation_idempotency_key,
         effect_certainty,
         retryable,
         failure_code,
         recovery_delay_seconds,
         recovery_not_before
       ) VALUES (
         $1,
         $2,
         $3,
         'FAILED',
         $4,
         'CONFIRMED_NO_EFFECT',
         TRUE,
         'FAKE_PROVIDER_CONFIRMED_NO_EFFECT',
         2,
         clock_timestamp() + interval '2 seconds'
       )`,
        [
          command.commandId,
          dispatch.dispatchAttemptId,
          dispatch.recoveryLeaseId,
          `v13-outcome:${randomUUID()}`,
        ]
      );
      const beforeDue = await evidenceCounts(command.commandId);
      await expect(recordDispatch(command, 1)).rejects.toThrow(
        /Redis replay lacks a due confirmed-no-effect outcome/iu
      );
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(beforeDue);

      await db.query('SELECT pg_sleep(2.1)');
      await expect(
        db.query(
          `INSERT INTO public.financial_provider_command_recovery_leases (
           command_id,
           recovery_action,
           lease_owner_id,
           lease_duration_seconds,
           expires_at
         ) VALUES ($1,'DISPATCH',$2,30,clock_timestamp() + interval '30 seconds')`,
          [command.commandId, randomUUID()]
        )
      ).rejects.toThrow(/DISPATCH requires one same-transaction sealed v13 admission/iu);
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(beforeDue);

      await expect(recordDispatch(command, 1)).resolves.toEqual(
        expect.objectContaining({
          dispatchAttemptId: expect.any(String),
          recoveryLeaseId: expect.any(String),
        })
      );
      await expect(evidenceCounts(command.commandId)).resolves.toEqual({
        ...beforeDue,
        admissions: beforeDue.admissions + 1,
        leases: beforeDue.leases + 1,
        attempts: beforeDue.attempts + 1,
        validations: beforeDue.validations + 1,
      });
    });

    it('records publisher exhaustion without starving later work or reopening dispatch', async () => {
      const command = await createQueuedCommand(1);
      let finalClaimId = command.publishClaimId!;
      // Exercise the actual database clock and each sealed claim; no trigger,
      // timestamp, lease bound, or replay guard is bypassed for this fixture.
      for (let claimNumber = 2; claimNumber <= 64; claimNumber += 1) {
        await db.query('SELECT pg_sleep(1.05)');
        const claimed = await db.query<PublishClaim>(
          'SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,1)',
          [randomUUID()]
        );
        expect(claimed.rows).toHaveLength(1);
        expect(claimed.rows[0]).toMatchObject({
          outbox_request_id: command.outboxRequestId,
          bullmq_job_id: command.bullmqJobId,
          claim_number: claimNumber,
        });
        finalClaimId = claimed.rows[0]!.publish_claim_id;
      }
      await expect(
        db.query(
          `INSERT INTO hx_authority.fake_financial_publish_exhaustions_v13
      (outbox_request_id,final_publish_claim_id,exhaustion_identity_sha256)
      VALUES ($1,$2,$3)`,
          [command.outboxRequestId, finalClaimId, '0'.repeat(64)]
        )
      ).rejects.toThrow(/exact due final publisher claim/u);
      // Delivery may have occurred even when its publisher acknowledgement was lost.
      // Retain that prior dispatch history for reconciliation after the hold.
      await recordDispatch(command);
      const priorDispatch = await evidenceCounts(command.commandId);
      const healthy = await createQueuedCommand(null);
      await db.query('SELECT pg_sleep(1.05)');
      const competing = await Promise.all(
        [1, 2].map(() =>
          db.query<PublishClaim>(
            'SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,300)',
            [randomUUID()]
          )
        )
      );
      expect(competing.map((result) => result.rowCount).sort()).toEqual([0, 1]);
      expect(competing.flatMap((result) => result.rows)).toEqual([
        expect.objectContaining({ outbox_request_id: healthy.outboxRequestId, claim_number: 1 }),
      ]);
      const exhausted = await db.query(
        `SELECT final_publish_claim_id,final_claim_number,reason,
      reconciliation_required,dispatch_authorized,provider_execution_capability,
      positive_money_capability,production_capability
      FROM hx_authority.fake_financial_publish_exhaustions_v13 WHERE outbox_request_id=$1`,
        [command.outboxRequestId]
      );
      expect(exhausted.rows).toEqual([
        {
          final_publish_claim_id: finalClaimId,
          final_claim_number: 64,
          reason: 'PUBLISH_RETRY_EXHAUSTED',
          reconciliation_required: true,
          dispatch_authorized: false,
          provider_execution_capability: false,
          positive_money_capability: false,
          production_capability: false,
        },
      ]);
      await expect(recordDispatch(command, 1)).rejects.toThrow(/publication is terminally held/u);
      await expect(evidenceCounts(command.commandId)).resolves.toEqual(priorDispatch);
      await expect(
        db.query(
          `SELECT hx_authority.record_fake_financial_publish_outcome_v13(
      $1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)`,
          [finalClaimId, command.bullmqJobId, command.jobAuthoritySha256]
        )
      ).rejects.toThrow(/publication is terminally held/u);
      expect(
        (
          await db.query(
            `SELECT count(*)::integer AS count
      FROM hx_authority.fake_financial_outbox_publish_claims_v13 WHERE outbox_request_id=$1`,
            [command.outboxRequestId]
          )
        ).rows
      ).toEqual([{ count: 64 }]);
      for (const sql of [
        'UPDATE hx_authority.fake_financial_publish_exhaustions_v13 SET reason=reason',
        'DELETE FROM hx_authority.fake_financial_publish_exhaustions_v13',
        'TRUNCATE hx_authority.fake_financial_publish_exhaustions_v13',
      ])
        await expect(db.query(sql)).rejects.toThrow();
      expect(
        (
          await db.query(
            `SELECT count(*)::integer AS count
      FROM hx_authority.fake_financial_publish_exhaustions_v13 WHERE outbox_request_id=$1`,
            [command.outboxRequestId]
          )
        ).rows
      ).toEqual([{ count: 1 }]);
    }, 120_000);

    describe('committed admitted-request readback', () => {
      const read = (receipt: DispatchEvidence, client: Pick<Pool, 'query'> = db) =>
        client.query('SELECT * FROM public.hxos_read_admitted_fake_financial_request_v13($1,$2)', [
          receipt.jobValidationId,
          receipt.workerInstanceId,
        ]);

      it('reads exact bytes after admission commits without adding provider or lifecycle facts', async () => {
        const command = await createQueuedCommand();
        const admission = await recordDispatch(command);
        const before = await evidenceCounts(command.commandId);
        const response = await read(admission);
        const exact = await db.query(
          'SELECT canonical_provider_request FROM hx_authority.fake_financial_exact_requests_v13 WHERE command_id=$1',
          [command.commandId]
        );
        expect(response.rowCount).toBe(1);
        expect(response.rows[0]).toMatchObject({
          command_id: command.commandId,
          outbox_request_id: command.outboxRequestId,
          job_validation_id: admission.jobValidationId,
          worker_instance_id: admission.workerInstanceId,
          dispatch_attempt_id: admission.dispatchAttemptId,
          recovery_lease_id: admission.recoveryLeaseId,
          canonical_provider_request: exact.rows[0]!.canonical_provider_request,
          payload_contract_version: 1,
          provider_execution_capability: false,
          positive_money_capability: false,
          production_capability: false,
          target_authority_id: target.target_authority_id,
        });
        expect(await evidenceCounts(command.commandId)).toEqual(before);
        expect(
          (
            await db.query(
              'SELECT count(*)::int AS count FROM public.financial_provider_command_outcome_facts WHERE command_id=$1',
              [command.commandId]
            )
          ).rows
        ).toEqual([{ count: 0 }]);
      });

      it('rejects admission and readback in the same transaction', async () => {
        const command = await createQueuedCommand();
        const before = await evidenceCounts(command.commandId);
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const admission = await recordDispatch(command, 0, client);
          await expect(read(admission, client)).rejects.toThrow('COMMITTED_ADMISSION_REQUIRED');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
        expect(await evidenceCounts(command.commandId)).toEqual(before);
      });

      it('rejects another worker and nonexistent validation IDs', async () => {
        const command = await createQueuedCommand();
        const admission = await recordDispatch(command);
        await expect(read({ ...admission, workerInstanceId: randomUUID() })).rejects.toThrow(
          'ADMISSION_NOT_FOUND'
        );
        await expect(read({ ...admission, jobValidationId: randomUUID() })).rejects.toThrow(
          'ADMISSION_NOT_FOUND'
        );
      });

      it('rejects a terminal publisher hold committed after admission', async () => {
        const command = await createQueuedCommand();
        const admission = await recordDispatch(command);
        await db.query(
          "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_HOLD',NULL)",
          [command.publishClaimId]
        );
        await expect(read(admission)).rejects.toThrow('publication is terminally held');
      });

      it('rejects an elapsed outcome deadline even while its lease remains live', async () => {
        const command = await createQueuedCommand();
        const admission = await recordDispatch(command, 0, db, 30, 1);
        await db.query('SELECT pg_sleep(1.05)');
        await expect(read(admission)).rejects.toThrow('EXECUTION_WINDOW_EXPIRED');
      });

      it.each(['OUTCOME_UNKNOWN', 'FAILED'] as const)(
        'rejects a %s observation committed after admission',
        async (kind) => {
          const command = await createQueuedCommand();
          const admission = await recordDispatch(command);
          await db.query(
            `INSERT INTO public.financial_provider_command_outcome_facts (
          command_id, dispatch_attempt_id, recovery_lease_id, outcome_kind,
          observation_idempotency_key, effect_certainty, retryable, failure_code,
          recovery_delay_seconds, recovery_not_before
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC_OBSERVATION',$8,$9)`,
            [
              command.commandId,
              admission.dispatchAttemptId,
              admission.recoveryLeaseId,
              kind,
              `admitted-outcome:${randomUUID()}`,
              kind === 'FAILED' ? 'CONFIRMED_NO_EFFECT' : 'UNKNOWN',
              kind !== 'FAILED',
              kind === 'FAILED' ? null : 30,
              kind === 'FAILED' ? null : new Date(Date.now() + 30_000),
            ]
          );
          await expect(read(admission)).rejects.toThrow('DISPATCH_NOT_OPEN');
        }
      );

      it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
        'refuses %s snapshots for admitted readback',
        async (isolation) => {
          const command = await createQueuedCommand();
          const admission = await recordDispatch(command);
          const client = await db.connect();
          try {
            await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
            await expect(read(admission, client)).rejects.toThrow(
              'publication requires READ COMMITTED'
            );
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        }
      );

      it('rejects a replaced target after admission', async () => {
        const command = await createQueuedCommand();
        const admission = await recordDispatch(command);
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts (
            authority_version, target_database_name, environment, release_manifest_sha256,
            activation_request_sha256, supersedes_target_authority_id
          ) VALUES ($1,current_database(),'local',$2,$3,$4)`,
            [
              target.authority_version + 1,
              `sha256:${'8'.repeat(64)}`,
              createHash('sha256').update(randomUUID()).digest('hex'),
              target.target_authority_id,
            ]
          );
          await expect(read(admission, client)).rejects.toThrow(/target|manifest/i);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });

      it('rechecks the outcome after waiting for the command recovery lock', async () => {
        const command = await createQueuedCommand();
        const admission = await recordDispatch(command);
        const observer = await db.connect();
        const worker = await db.connect();
        let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await observer.query('BEGIN');
          await observer.query(
            `INSERT INTO public.financial_provider_command_outcome_facts (
            command_id, dispatch_attempt_id, recovery_lease_id, outcome_kind,
            observation_idempotency_key, effect_certainty, retryable, failure_code
          ) VALUES ($1,$2,$3,'FAILED',$4,'CONFIRMED_NO_EFFECT',FALSE,'SYNTHETIC_OBSERVATION')`,
            [
              command.commandId,
              admission.dispatchAttemptId,
              admission.recoveryLeaseId,
              `admitted-outcome:${randomUUID()}`,
            ]
          );
          await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          pending = Promise.allSettled([read(admission, worker)]);
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const result = await db.query(
              "SELECT 1 FROM pg_catalog.pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
              [pid]
            );
            if (result.rowCount === 1) {
              waiting = true;
              break;
            }
            await db.query('SELECT pg_sleep(0.01)');
          }
          expect(waiting).toBe(true);
          await observer.query('COMMIT');
          const result = (await pending)[0]!;
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected')
            expect(String(result.reason)).toContain('DISPATCH_NOT_OPEN');
        } finally {
          await observer.query('ROLLBACK');
          if (pending) await pending;
          await worker.query('ROLLBACK');
          observer.release();
          worker.release();
        }
      });
    });

    it('refuses recovery evidence for a request not yet committed by its caller', async () => {
      const client = await db.connect();
      let commandId: string | undefined;
      try {
        await client.query('BEGIN');
        const command = await createQueuedCommand(null, client);
        commandId = command.commandId;
        const previousId = (BigInt('0x' + command.outboxRequestId.replaceAll('-', '')) - 1n)
          .toString(16)
          .padStart(32, '0')
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
        const scanned = await client.query(
          'SELECT * FROM public.hxos_scan_fake_financial_recovery_v13($1,1)',
          [previousId]
        );
        expect(scanned.rows.some((row) => row.command_id === command.commandId)).toBe(false);
        await expect(
          client.query(
            'SELECT * FROM public.hxos_read_fake_financial_recovery_evidence_v13($1,$2,$3)',
            [command.outboxRequestId, command.bullmqJobId, command.jobAuthoritySha256]
          )
        ).rejects.toThrow('COMMITTED_REQUEST_REQUIRED');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(commandId).toBeDefined();
      for (const relation of [
        'public.financial_provider_command_journal',
        'hx_authority.fake_financial_exact_requests_v13',
        'hx_authority.fake_financial_command_outbox_requests_v13',
      ])
        expect(
          (
            await db.query(
              `SELECT count(*)::integer AS count FROM ${relation} WHERE command_id=$1`,
              [commandId]
            )
          ).rows
        ).toEqual([{ count: 0 }]);
    });

    it('uses distinct worker and API logins with sealed publisher ports and no direct v13 writes', async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
      const roles = Object.fromEntries(
        [
          'migration',
          'api',
          'worker',
          'attester',
          'command',
          'assertion',
          'finance',
          'telemetry',
        ].map((kind) => [kind, `hx_ci_${suffix}_${kind}`])
      );
      const password = `synthetic-v13-${randomUUID()}`;
      const created: string[] = [];
      const clients: Client[] = [];
      const quote = (name: string): string => {
        if (!/^hx_ci_[a-f0-9]{20}_[a-z]+$/u.test(name)) throw new Error('UNSAFE_SYNTHETIC_ROLE');
        return `"${name}"`;
      };
      const connectAs = async (name: string): Promise<Client> => {
        const url = new URL(fixture!.databaseUrl);
        url.username = name;
        url.password = password;
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        clients.push(client);
        return client;
      };
      const command = await createQueuedCommand(null);
      try {
        for (const [kind, name] of Object.entries(roles)) {
          const login = ['migration', 'api', 'worker', 'attester'].includes(kind);
          await db.query(`CREATE ROLE ${quote(name)} ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          created.push(name);
          await db.query(`GRANT USAGE ON SCHEMA public, hx_authority TO ${quote(name)}`);
        }
        for (const relation of v13Relations) {
          const owner =
            relation === 'public.hxos_fake_financial_schema_evidence_v13'
              ? roles.command!
              : roles.finance!;
          await db.query(`ALTER TABLE ${relation} OWNER TO ${quote(owner)}`);
        }
        for (const relation of WORK_ORDER_FINANCIAL_READ_RELATIONS) {
          await db.query(`ALTER TABLE ${relation} OWNER TO ${quote(roles.finance!)}`);
        }
        for (const identity of FAKE_FINANCIAL_OUTBOX_FUNCTIONS) {
          const owner =
            identity === FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION ||
            FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS.some((reader) => reader === identity)
              ? roles.command!
              : roles.finance!;
          await db.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(owner)}`);
        }
        await db.query(`GRANT SELECT(name,sha256) ON public.applied_migrations
          TO ${quote(roles.command!)}, ${quote(roles.finance!)}`);
        await db.query(`GRANT EXECUTE ON FUNCTION public.hxos_read_universal_v1_work_order_runtime_authority_v1()
          TO ${quote(roles.command!)}`);
        await db.query(`GRANT SELECT ON public.hxos_fake_financial_schema_evidence_v12,
          public.hxos_work_order_bootstrap_seal_evidence_v1, public.hxos_fake_financial_schema_evidence_v13,
          public.financial_provider_command_journal, public.financial_provider_command_outcome_facts
          TO ${quote(roles.finance!)}`);
        for (const relation of FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS) {
          await db.query(`GRANT SELECT(${fakeFinancialBootstrapMetadataColumns(relation).join(',')}) ON ${relation}
            TO ${quote(roles.command!)}`);
        }
        for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS)) {
          await db.query(
            `GRANT SELECT, UPDATE(${columns.join(',')}) ON ${relation} TO ${quote(roles.finance!)}`
          );
        }
        await db.query(`GRANT INSERT ON public.financial_provider_command_recovery_leases,
          public.financial_provider_command_dispatch_attempts TO ${quote(roles.finance!)}`);
        await db.query(`GRANT EXECUTE ON FUNCTION public.universal_v1_effective_financial_security_expiry_v1(uuid)
          TO ${quote(roles.finance!)}`);
        await db.query(`GRANT EXECUTE ON FUNCTION public.universal_v1_financial_security_is_current_v1(timestamptz,timestamptz)
          TO ${quote(roles.finance!)}`);
        for (const identity of FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS) {
          await db.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.worker!)}`);
        }
        for (const identity of FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS) {
          await db.query(
            `GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.api!)}, ${quote(roles.worker!)}`
          );
        }
        for (const kind of ['migration', 'api', 'worker', 'attester']) {
          await db.query(
            `GRANT EXECUTE ON FUNCTION ${FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION} TO ${quote(roles[kind]!)}`
          );
        }
        const provisioningClient = await db.connect();
        try {
          await provisionUniversalV1SyntheticRoles(
            provisioningClient,
            new URL(fixture!.databaseUrl).pathname.slice(1),
            {
              migrationRole: roles.migration!,
              apiRole: roles.api!,
              workerRole: roles.worker!,
              attesterRole: roles.attester!,
              commandOwnerRole: roles.command!,
              assertionOwnerRole: roles.assertion!,
              financeOwnerRole: roles.finance!,
              telemetryOwnerRole: roles.telemetry!,
            }
          );
        } finally {
          provisioningClient.release();
        }
        const worker = await connectAs(roles.worker!);
        const api = await connectAs(roles.api!);
        const recoverySql =
          'SELECT * FROM public.hxos_read_fake_financial_recovery_evidence_v13($1,$2,$3)';
        const recover = async (candidate: QueuedCommand) =>
          (
            await worker.query(recoverySql, [
              candidate.outboxRequestId,
              candidate.bullmqJobId,
              candidate.jobAuthoritySha256,
            ])
          ).rows[0]!;
        await expect(
          api.query(recoverySql, [
            command.outboxRequestId,
            command.bullmqJobId,
            command.jobAuthoritySha256,
          ])
        ).rejects.toThrow('permission denied');
        const progressSql = 'SELECT * FROM public.hxos_read_fake_financial_progress_v13($1,$2,$3)';
        const progressArgs = (candidate: QueuedCommand) => [
          candidate.outboxRequestId,
          candidate.bullmqJobId,
          candidate.jobAuthoritySha256,
        ];
        const progress = async (candidate: QueuedCommand) =>
          (await worker.query(progressSql, progressArgs(candidate))).rows[0]!;
        const publicProgressAssertion = async (candidate: Pick<QueuedCommand, 'commandId'>) => {
          const current = await currentTarget();
          const actor = (
            await db.query(
              'SELECT recorded_actor_id FROM public.financial_provider_command_journal WHERE command_id=$1',
              [candidate.commandId]
            )
          ).rows[0]!.recorded_actor_id;
          const attester = await connectAs(roles.attester!);
          try {
            const handle = await createSyntheticActorAttestation(
              db,
              taskDraftFixtureDatabase(api),
              attester,
              roles.attester!,
              current.release_manifest_sha256,
              actor
            );
            return await handle.issue({
              commandKind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
              commandPayload: { commandId: candidate.commandId },
            });
          } finally {
            await attester.end();
          }
        };
        const publicProgress = async (candidate: Pick<QueuedCommand, 'commandId'>) => {
          const assertion = await publicProgressAssertion(candidate);
          return (
            await api.query(
              'SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)',
              [assertion.actor_assertion_token, { commandId: candidate.commandId }]
            )
          ).rows[0]!.progress;
        };
        const decodeProgress = (row: unknown, candidate: QueuedCommand) =>
          decodeFakeFinancialProgressRow(
            row,
            {
              jobId: candidate.bullmqJobId,
              payload: {
                version: 1,
                kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
                outboxRequestId: candidate.outboxRequestId,
                commandId: candidate.commandId,
                jobAuthoritySha256: candidate.jobAuthoritySha256,
              },
            },
            {
              environment: 'local',
              databaseName: new URL(fixture!.databaseUrl).pathname.slice(1),
              targetDigest: 'synthetic-progress-reader',
              manifestDigest: 'sha256:' + 'a'.repeat(64),
            }
          );
        await expect(api.query(progressSql, progressArgs(command))).rejects.toThrow(
          'permission denied'
        );
        const initiallyEmpty = await progress(command);
        expect(initiallyEmpty.recorded_outcome).toBeNull();
        expect(decodeProgress(initiallyEmpty, command).kind).toBe('NO_COMMITTED_ADMISSION');
        const neverAdmitted = await recover(command);
        expect(neverAdmitted.admission_evidence).toBeNull();
        expect(neverAdmitted.provider_event).toBeNull();
        expect(neverAdmitted.request_evidence).toMatchObject({
          command_id: command.commandId,
          outbox_request_id: command.outboxRequestId,
        });
        for (const args of [
          [randomUUID(), command.bullmqJobId, command.jobAuthoritySha256],
          [command.outboxRequestId, `${command.bullmqJobId}-forged`, command.jobAuthoritySha256],
          [command.outboxRequestId, command.bullmqJobId, '0'.repeat(64)],
        ])
          await expect(worker.query(recoverySql, args)).rejects.toThrow('REQUEST_NOT_FOUND');
        expect((await worker.query('SELECT session_user::text AS role')).rows).toEqual([
          { role: roles.worker },
        ]);
        expect((await api.query('SELECT session_user::text AS role')).rows).toEqual([
          { role: roles.api },
        ]);
        for (const client of [worker, api]) {
          const read = await client.query(`SELECT session_database_role,v13_sql_sha256
            FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()`);
          expect(read.rows[0]!.v13_sql_sha256).toBe(migrationSha256);
          for (const relation of v13Relations) {
            await expect(client.query(`SELECT * FROM ${relation}`)).rejects.toThrow(
              /permission denied/u
            );
            await expect(client.query(`INSERT INTO ${relation} DEFAULT VALUES`)).rejects.toThrow(
              /permission denied/u
            );
          }
          await expect(
            client.query('SELECT * FROM hx_authority.claim_fake_financial_outbox_v13($1,30)', [
              randomUUID(),
            ])
          ).rejects.toThrow(/permission denied/u);
        }
        await expect(
          api.query('SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,30)', [
            randomUUID(),
          ])
        ).rejects.toThrow(/permission denied/u);
        const claim = await worker.query<PublishClaim>(
          'SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,300)',
          [randomUUID()]
        );
        expect(claim.rows[0]!.outbox_request_id).toBe(command.outboxRequestId);
        await worker.query(
          `SELECT public.hxos_record_fake_financial_publish_outcome_v13(
          $1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)`,
          [claim.rows[0]!.publish_claim_id, command.bullmqJobId, command.jobAuthoritySha256]
        );
        await expect(recordDispatch(command, 0, api)).rejects.toThrow(/permission denied/u);
        const admittedRepository = new PostgresFakeFinancialAdmittedRequestRepository({
          transaction: async (callback) => {
            await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            try {
              const query: QueryFn = async <T>(sql: string, params?: unknown[]) => {
                const response = await worker.query(sql, params);
                return { rows: response.rows as T[], rowCount: response.rowCount ?? 0 };
              };
              const result = await callback(query);
              await worker.query('COMMIT');
              return result;
            } catch (error) {
              await worker.query('ROLLBACK');
              throw error;
            }
          },
        });
        const admission = await admittedRepository.admit({
          jobId: command.bullmqJobId,
          workerInstanceId: randomUUID(),
          bullmqAttemptNumber: 0,
          leaseSeconds: 30,
          outcomeTimeoutSeconds: 10,
          payload: {
            version: 1,
            kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
            commandId: command.commandId,
            outboxRequestId: command.outboxRequestId,
            jobAuthoritySha256: command.jobAuthoritySha256,
          },
        });
        const admitted = await admittedRepository.read(admission);
        expect(admitted.durableRequest.operationKind).toBe('PREPARE_PAYMENT_METHOD');
        expect(admitted.evidence.provider_execution_capability).toBe(false);
        const admittedRecovery = await recover(command);
        expect(admittedRecovery.admission_evidence).toMatchObject({
          job_validation_id: admission.job_validation_id,
          worker_instance_id: admitted.evidence.worker_instance_id,
          provider_execution_capability: false,
          positive_money_capability: false,
          production_capability: false,
        });
        expect(admittedRecovery.provider_event).toBeNull();
        const executionSql =
          'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)';
        const executionArgs = [admission.job_validation_id, admitted.evidence.worker_instance_id];
        await expect(api.query(executionSql, executionArgs)).rejects.toThrow(/permission denied/u);
        const executed = await worker.query(executionSql, executionArgs);
        expect(executed.rowCount).toBe(1);
        expect(executed.rows[0]).toMatchObject({
          operation_kind: 'PREPARE_PAYMENT_METHOD',
          state: 'SUCCEEDED',
          event_version: 1,
          provider_request_sha256: admission.provider_request_sha256,
          admitted_job_validation_id: admission.job_validation_id,
          projection_contract_version: 2,
          idempotency_replayed: false,
        });
        const replayed = await worker.query(executionSql, executionArgs);
        expect(replayed.rows).toEqual([{ ...executed.rows[0], idempotency_replayed: true }]);
        expect((await recover(command)).provider_event).toMatchObject({
          projection_contract_version: 2,
          event_id: executed.rows[0]!.event_id,
          admitted_job_validation_id: admission.job_validation_id,
          idempotency_replayed: true,
          state: 'SUCCEEDED',
        });
        const concurrentWorker = await connectAs(roles.worker!);
        const concurrent = await Promise.all([
          worker.query(executionSql, executionArgs),
          concurrentWorker.query(executionSql, executionArgs),
        ]);
        for (const result of concurrent) expect(result.rows).toEqual(replayed.rows);
        await expect(worker.query(executionSql, [randomUUID(), executionArgs[1]])).rejects.toThrow(
          'ADMISSION_NOT_FOUND'
        );
        await expect(worker.query(executionSql, [executionArgs[0], randomUUID()])).rejects.toThrow(
          'ADMISSION_NOT_FOUND'
        );
        await expect(
          db.query(
            `UPDATE public.hxos_fake_financial_operation_events_v1
          SET admitted_job_validation_id=NULL WHERE event_id=$1`,
            [executed.rows[0]!.event_id]
          )
        ).rejects.toThrow(/append.only|immutable/i);

        await expect(
          db.query(
            'UPDATE public.hxos_fake_financial_operation_events_v1 SET projection_contract_version=1 WHERE event_id=$1',
            [executed.rows[0]!.event_id]
          )
        ).rejects.toThrow(/append.only|immutable/i);
        const rawCounts = async (operationId: string) =>
          (
            await db.query(
              `SELECT (SELECT count(*)::integer FROM public.hxos_fake_financial_operations_v1
             WHERE operation_id=$1) AS operations,
            (SELECT count(*)::integer FROM public.hxos_fake_financial_operation_events_v1
             WHERE operation_id=$1) AS events`,
              [operationId]
            )
          ).rows;
        const admittedRead = async (evidence: DispatchEvidence) =>
          (
            await worker.query(
              'SELECT * FROM public.hxos_read_admitted_fake_financial_request_v13($1,$2)',
              [evidence.jobValidationId, evidence.workerInstanceId]
            )
          ).rows[0]!;
        const blockedCommand = await createQueuedCommand();
        const blockedAdmission = await recordDispatch(blockedCommand, 0, worker, 30, 2);
        const blockedRead = await admittedRead(blockedAdmission);
        expect(await publicProgress(blockedCommand)).toMatchObject({
          progressState: 'PROCESSING',
          financialEvent: null,
        });
        const blocker = await db.connect();
        let waitingExecution: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            `SELECT pg_advisory_xact_lock(hashtext('fake-financial-operation'),hashtext($1))`,
            [blockedRead.operation_id]
          );
          const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          waitingExecution = Promise.allSettled([
            worker.query(executionSql, [
              blockedAdmission.jobValidationId,
              blockedAdmission.workerInstanceId,
            ]),
          ]);
          let waiting = false;
          for (let poll = 0; poll < 100; poll++) {
            const locks = await db.query(
              `SELECT 1 FROM pg_locks
              WHERE pid=$1 AND locktype='advisory' AND NOT granted`,
              [pid]
            );
            if (locks.rowCount === 1) {
              waiting = true;
              break;
            }
            await db.query('SELECT pg_sleep(0.01)');
          }
          expect(waiting).toBe(true);
          await blocker.query(
            "SELECT pg_sleep_until($1::timestamptz + interval '20 milliseconds')",
            [blockedRead.outcome_deadline_at]
          );
          await blocker.query('COMMIT');
          const outcome = (await waitingExecution)[0]!;
          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected')
            expect(String(outcome.reason)).toContain('EXECUTION_WINDOW_EXPIRED');
        } finally {
          await blocker.query('ROLLBACK');
          if (waitingExecution) await waitingExecution;
          blocker.release();
        }
        expect(await rawCounts(blockedRead.operation_id)).toEqual([{ operations: 0, events: 0 }]);
        const expiredWithoutEvent = await recover(blockedCommand);
        expect(await publicProgress(blockedCommand)).toMatchObject({
          progressState: 'RECOVERY_REQUIRED',
          financialEvent: null,
        });
        expect(expiredWithoutEvent.admission_evidence.job_validation_id).toBe(
          blockedAdmission.jobValidationId
        );
        expect(expiredWithoutEvent.provider_event).toBeNull();
        expect(
          (
            await db.query(
              `SELECT count(*)::integer AS count
          FROM public.financial_provider_command_outcome_facts WHERE command_id=$1`,
              [blockedCommand.commandId]
            )
          ).rows
        ).toEqual([{ count: 0 }]);

        const heldCommand = await createQueuedCommand();
        const heldAdmission = await recordDispatch(heldCommand, 0, worker);
        const heldRead = await admittedRead(heldAdmission);
        await worker.query(
          `SELECT public.hxos_record_fake_financial_publish_outcome_v13(
          $1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_EXECUTION_HOLD',NULL)`,
          [heldCommand.publishClaimId]
        );
        await expect(
          worker.query(executionSql, [
            heldAdmission.jobValidationId,
            heldAdmission.workerInstanceId,
          ])
        ).rejects.toThrow('publication is terminally held');
        expect(await rawCounts(heldRead.operation_id)).toEqual([{ operations: 0, events: 0 }]);
        expect((await recover(heldCommand)).provider_event).toBeNull();

        const recoveryCommand = await createQueuedCommand();
        await worker.query('BEGIN');
        try {
          await recordDispatch(recoveryCommand, 0, worker);
          await expect(recover(recoveryCommand)).rejects.toThrow('COMMITTED_ADMISSION_REQUIRED');
        } finally {
          await worker.query('ROLLBACK');
        }
        expect((await recover(recoveryCommand)).admission_evidence).toBeNull();
        const recoveryAdmission = await recordDispatch(recoveryCommand, 0, worker, 5, 3);
        const recoveryRead = await admittedRead(recoveryAdmission);
        const recoveryExecutionArgs = [
          recoveryAdmission.jobValidationId,
          recoveryAdmission.workerInstanceId,
        ];
        await worker.query('BEGIN');
        try {
          await worker.query(executionSql, recoveryExecutionArgs);
          await expect(recover(recoveryCommand)).rejects.toThrow('COMMITTED_EVENT_REQUIRED');
        } finally {
          await worker.query('ROLLBACK');
        }
        expect(await rawCounts(recoveryRead.operation_id)).toEqual([{ operations: 0, events: 0 }]);
        const committedExecution = (await worker.query(executionSql, recoveryExecutionArgs))
          .rows[0]!;
        await worker.query(
          `SELECT public.hxos_record_fake_financial_publish_outcome_v13(
          $1,'TERMINAL_FAILURE',NULL,NULL,'SYNTHETIC_RECOVERY_HOLD',NULL)`,
          [recoveryCommand.publishClaimId]
        );
        await db.query("SELECT pg_sleep_until($1::timestamptz + interval '20 milliseconds')", [
          recoveryRead.lease_expires_at,
        ]);
        await expect(worker.query(executionSql, recoveryExecutionArgs)).rejects.toThrow(
          'publication is terminally held'
        );
        const recoveredExpiredEvent = await recover(recoveryCommand);
        expect(recoveredExpiredEvent.provider_event).toMatchObject({
          event_id: committedExecution.event_id,
          state: 'SUCCEEDED',
        });
        expect(await rawCounts(recoveryRead.operation_id)).toEqual([{ operations: 1, events: 1 }]);

        const outcomeSql = 'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)';
        const leaseSql =
          'SELECT * FROM public.hxos_acquire_fake_financial_reconcile_lease_v13($1,$2,$3,$4)';
        const unknownCommand = await createQueuedCommand();
        const unknownAdmission = await recordDispatch(unknownCommand, 0, worker, 30, 10);
        const unknownArgs = [
          unknownAdmission.jobValidationId,
          unknownAdmission.workerInstanceId,
          unknownAdmission.recoveryLeaseId,
        ];
        await expect(api.query(outcomeSql, unknownArgs)).rejects.toThrow('permission denied');
        await expect(api.query(leaseSql, [...unknownArgs, 30])).rejects.toThrow(
          'permission denied'
        );
        for (const args of [
          [randomUUID(), unknownArgs[1], unknownArgs[2]],
          [unknownArgs[0], randomUUID(), unknownArgs[2]],
          [unknownArgs[0], unknownArgs[1], randomUUID()],
        ])
          await expect(worker.query(outcomeSql, args)).rejects.toThrow(
            /ADMISSION_NOT_FOUND|LEASE_BINDING_MISMATCH/u
          );
        expect((await progress(unknownCommand)).recorded_outcome).toBeNull();
        const unknown = (await worker.query(outcomeSql, unknownArgs)).rows[0]!;
        const unknownProgress = await progress(unknownCommand);
        expect(await publicProgress(unknownCommand)).toMatchObject({
          progressState: 'RECOVERY_REQUIRED',
          financialEvent: null,
        });
        expect(unknownProgress.recorded_outcome).toEqual({
          ...unknown,
          idempotency_replayed: true,
        });
        expect(
          decodeProgress(unknownProgress, unknownCommand).recordedOutcome?.outcome.outcome_kind
        ).toBe('OUTCOME_UNKNOWN');
        expect(unknown.outcome_fact).toMatchObject({
          command_id: unknownCommand.commandId,
          dispatch_attempt_id: unknownAdmission.dispatchAttemptId,
          recovery_lease_id: unknownAdmission.recoveryLeaseId,
          outcome_kind: 'OUTCOME_UNKNOWN',
          provider_result_sha256: null,
          provider_state: null,
          provider_result_version: null,
          amount_cents: null,
          currency: null,
          external_reference_sha256: null,
          effect_certainty: 'UNKNOWN',
          retryable: true,
          failure_code: 'FAKE_EVENT_NOT_OBSERVED',
          recovery_delay_seconds: 1,
        });
        expect((await worker.query(outcomeSql, unknownArgs)).rows).toEqual([
          { ...unknown, idempotency_replayed: true },
        ]);
        await expect(worker.query(executionSql, unknownArgs.slice(0, 2))).rejects.toThrow(
          'HXUV1-FINREAD-13-DISPATCH_NOT_OPEN'
        );
        const reconcileOwner = randomUUID();
        const reconcileId = randomUUID();
        const reconcileArgs = [unknownAdmission.jobValidationId, reconcileOwner, reconcileId, 1];
        await expect(worker.query(leaseSql, reconcileArgs)).rejects.toThrow(/due|recovery time/i);
        await db.query('SELECT pg_sleep_until($1::timestamptz)', [
          unknown.outcome_fact.recovery_not_before,
        ]);
        const acquiredResults = await Promise.all([
          worker.query(leaseSql, reconcileArgs),
          concurrentWorker.query(leaseSql, reconcileArgs),
        ]);
        expect(
          acquiredResults.map((result) => result.rows[0]!.idempotency_replayed).sort()
        ).toEqual([false, true]);
        const acquired = acquiredResults.find(
          (result) => result.rows[0]!.idempotency_replayed === false
        )!.rows[0]!;
        expect(acquired.recovery_lease).toMatchObject({
          recovery_lease_id: reconcileId,
          command_id: unknownCommand.commandId,
          recovery_action: 'RECONCILE',
          lease_owner_id: reconcileOwner,
          lease_duration_seconds: 1,
          admitted_job_validation_id: unknownAdmission.jobValidationId,
        });
        for (const args of [
          [unknownAdmission.jobValidationId, randomUUID(), reconcileId, 1],
          [unknownAdmission.jobValidationId, reconcileOwner, reconcileId, 2],
          [
            unknownAdmission.jobValidationId,
            unknownAdmission.workerInstanceId,
            unknownAdmission.recoveryLeaseId,
            30,
          ],
          [recoveryAdmission.jobValidationId, reconcileOwner, reconcileId, 1],
        ])
          await expect(worker.query(leaseSql, args)).rejects.toThrow('LEASE_REPLAY_CONFLICT');
        for (const duration of [null, 0, 901])
          await expect(
            worker.query(leaseSql, [
              unknownAdmission.jobValidationId,
              reconcileOwner,
              randomUUID(),
              duration,
            ])
          ).rejects.toThrow('LEASE_INPUT_INVALID');
        await db.query('SELECT pg_sleep_until($1::timestamptz)', [
          acquired.recovery_lease.expires_at,
        ]);
        await expect(worker.query(leaseSql, reconcileArgs)).resolves.toMatchObject({
          rows: [{ ...acquired, idempotency_replayed: true }],
        });
        await expect(worker.query(outcomeSql, reconcileArgs.slice(0, 3))).rejects.toThrow(
          'recovery lease expired'
        );
        // A fresh lease can observe again, retaining the original dispatch.
        const nextLeaseArgs = [unknownAdmission.jobValidationId, reconcileOwner, randomUUID(), 30];
        await worker.query(leaseSql, nextLeaseArgs);
        const reconciledUnknown = (await worker.query(outcomeSql, nextLeaseArgs.slice(0, 3)))
          .rows[0]!;
        expect(reconciledUnknown.outcome_fact).toMatchObject({
          outcome_kind: 'OUTCOME_UNKNOWN',
          effect_certainty: 'UNKNOWN',
          retryable: true,
          dispatch_attempt_id: unknownAdmission.dispatchAttemptId,
          recovery_lease_id: nextLeaseArgs[2],
        });
        expect((await evidenceCounts(unknownCommand.commandId)).attempts).toBe(1);

        // The raw-operation lock delays outcome recording past a live lease's
        // expiry. The existing trigger must evaluate clock time after the wait.
        const expiryLeaseArgs = [blockedAdmission.jobValidationId, randomUUID(), randomUUID(), 1];
        const expiryLease = (await worker.query(leaseSql, expiryLeaseArgs)).rows[0]!;
        const outcomeBlocker = await db.connect();
        let waitingOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
          await outcomeBlocker.query('BEGIN');
          await outcomeBlocker.query(
            "SELECT pg_advisory_xact_lock(hashtext('fake-financial-operation'),hashtext($1))",
            [blockedRead.operation_id]
          );
          const outcomePid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          waitingOutcome = Promise.allSettled([
            worker.query(outcomeSql, expiryLeaseArgs.slice(0, 3)),
          ]);
          let waiting = false;
          for (let poll = 0; poll < 100; poll++) {
            if (
              (
                await db.query(
                  "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                  [outcomePid]
                )
              ).rowCount === 1
            ) {
              waiting = true;
              break;
            }
            await db.query('SELECT pg_sleep(0.01)');
          }
          expect(waiting).toBe(true);
          await outcomeBlocker.query('SELECT pg_sleep_until($1::timestamptz)', [
            expiryLease.recovery_lease.expires_at,
          ]);
          await outcomeBlocker.query('COMMIT');
          const result = (await waitingOutcome)[0]!;
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected')
            expect(String(result.reason)).toContain('recovery lease expired');
        } finally {
          await outcomeBlocker.query('ROLLBACK');
          if (waitingOutcome) await waitingOutcome;
          outcomeBlocker.release();
        }
        expect(
          (
            await db.query(
              'SELECT count(*)::integer AS count FROM public.financial_provider_command_outcome_facts WHERE command_id=$1',
              [blockedCommand.commandId]
            )
          ).rows
        ).toEqual([{ count: 0 }]);

        // An expired, empty dispatch becomes one immutable fence. A released
        // savepoint is insufficient for either transport restoration or admission.
        const fenceArgs = [blockedAdmission.jobValidationId, randomUUID(), randomUUID(), 30];
        await worker.query(leaseSql, fenceArgs);
        await worker.query('BEGIN');
        let abandonedFence: any;
        try {
          await worker.query('SAVEPOINT fence');
          abandonedFence = (await worker.query(outcomeSql, fenceArgs.slice(0, 3))).rows[0];
          await worker.query('RELEASE SAVEPOINT fence');
          expect(abandonedFence.outcome_fact).toMatchObject({
            outcome_kind: 'FAILED',
            effect_certainty: 'CONFIRMED_NO_EFFECT',
            retryable: true,
            failure_code: 'FAKE_ADMISSION_FENCED_NO_EFFECT',
          });
          await worker.query('SAVEPOINT restore_refusal');
          await expect(
            worker.query(
              'SELECT * FROM public.hxos_read_fake_financial_restoration_v13($1,$2,$3)',
              [
                blockedCommand.outboxRequestId,
                blockedCommand.bullmqJobId,
                blockedCommand.jobAuthoritySha256,
              ]
            )
          ).rejects.toThrow('COMMITTED_OUTCOME_REQUIRED');
          await worker.query('ROLLBACK TO SAVEPOINT restore_refusal');
          await worker.query('SELECT pg_sleep_until($1::timestamptz)', [
            abandonedFence.outcome_fact.recovery_not_before,
          ]);
          await worker.query('SAVEPOINT admission_refusal');
          await expect(recordDispatch(blockedCommand, 1, worker)).rejects.toThrow(
            'PRIOR_COMMITTED_FENCE_REQUIRED'
          );
          await worker.query('ROLLBACK TO SAVEPOINT admission_refusal');
          await worker.query('COMMIT');
        } finally {
          await worker.query('ROLLBACK');
        }
        expect(
          decodeProgress(await progress(blockedCommand), blockedCommand).recordedOutcome?.outcome
            .outcome_kind
        ).toBe('FAILED');
        await expect(
          worker.query(leaseSql, [blockedAdmission.jobValidationId, randomUUID(), randomUUID(), 30])
        ).rejects.toThrow('DISPATCH_ALREADY_FENCED');
        await expect(worker.query(outcomeSql, expiryLeaseArgs.slice(0, 3))).rejects.toThrow(
          'DISPATCH_ALREADY_FENCED'
        );
        await expect(
          worker.query(executionSql, [
            blockedAdmission.jobValidationId,
            blockedAdmission.workerInstanceId,
          ])
        ).rejects.toThrow(/DISPATCH_NOT_OPEN|EXECUTION_WINDOW_EXPIRED/);
        const retryAdmission = await recordDispatch(blockedCommand, 1, worker);
        await worker.query(executionSql, [
          retryAdmission.jobValidationId,
          retryAdmission.workerInstanceId,
        ]);
        expect(await rawCounts(blockedRead.operation_id)).toEqual([{ operations: 1, events: 1 }]);
        expect((await worker.query(outcomeSql, fenceArgs.slice(0, 3))).rows).toEqual([
          { ...abandonedFence, idempotency_replayed: true },
        ]);
        expect((await evidenceCounts(blockedCommand.commandId)).attempts).toBe(2);

        // A concurrent writer keeps the same command lock until its transaction
        // commits or rolls back. Reconciliation must observe the actual result.
        for (const disposition of ['COMMIT', 'ROLLBACK'] as const) {
          const racing = await createQueuedCommand();
          const admission = await recordDispatch(racing, 0, worker, 3, 2);
          const read = await admittedRead(admission);
          const args = [admission.jobValidationId, randomUUID(), randomUUID(), 30];
          let waiting: Promise<PromiseSettledResult<QueryResult>[]> | undefined;
          await worker.query('BEGIN');
          try {
            await worker.query(executionSql, [
              admission.jobValidationId,
              admission.workerInstanceId,
            ]);
            const pid = (await concurrentWorker.query('SELECT pg_backend_pid() AS pid')).rows[0]
              .pid;
            waiting = Promise.allSettled([concurrentWorker.query(leaseSql, args)]);
            await vi.waitFor(async () =>
              expect(
                (
                  await db.query(
                    "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                    [pid]
                  )
                ).rowCount
              ).toBe(1)
            );
            await db.query('SELECT pg_sleep_until($1::timestamptz)', [read.lease_expires_at]);
            await worker.query(disposition);
            const acquired = (await waiting)[0];
            if (acquired.status === 'rejected') throw acquired.reason;
            const observed = (await concurrentWorker.query(outcomeSql, args.slice(0, 3))).rows[0];
            expect(observed.outcome_fact.outcome_kind).toBe(
              disposition === 'COMMIT' ? 'OUTCOME_OBSERVED' : 'FAILED'
            );
            expect(observed.outcome_fact.effect_certainty).toBe(
              disposition === 'COMMIT' ? 'CONFIRMED_EFFECT' : 'CONFIRMED_NO_EFFECT'
            );
            expect(await rawCounts(read.operation_id)).toEqual([
              {
                operations: disposition === 'COMMIT' ? 1 : 0,
                events: disposition === 'COMMIT' ? 1 : 0,
              },
            ]);
          } finally {
            await worker.query('ROLLBACK');
            if (waiting) await waiting;
          }
        }

        // Deliberately corrupt owner fixture: operation without an event cannot
        // prove no effect, even after the dispatch window expires.
        const orphan = await createQueuedCommand();
        const orphanAdmission = await recordDispatch(orphan, 0, worker, 3, 2);
        const orphanRead = await admittedRead(orphanAdmission);
        await db.query(
          `INSERT INTO public.hxos_fake_financial_operations_v1(operation_id,operation_kind,identity_sha256,external_reference)
          VALUES($1,$2,$3,$4)`,
          [
            orphanRead.operation_id,
            orphanRead.operation_kind,
            'a'.repeat(64),
            'fake_orphan_' + randomUUID().replaceAll('-', '').slice(0, 24),
          ]
        );
        await db.query('SELECT pg_sleep_until($1::timestamptz)', [orphanRead.outcome_deadline_at]);
        const orphanArgs = [orphanAdmission.jobValidationId, randomUUID(), randomUUID(), 30];
        await worker.query(leaseSql, orphanArgs);
        expect(
          (await worker.query(outcomeSql, orphanArgs.slice(0, 3))).rows[0].outcome_fact
        ).toMatchObject({
          outcome_kind: 'OUTCOME_UNKNOWN',
          effect_certainty: 'UNKNOWN',
          failure_code: 'FAKE_EVENT_NOT_OBSERVED',
        });
        await expect(recordDispatch(orphan, 1, worker)).rejects.toThrow();

        // PREPARED/admission is not authority to execute after the customer is revoked.
        for (const changed of ["account_status='SUSPENDED'", 'is_banned=TRUE', 'is_minor=TRUE']) {
          const revoked = await createQueuedCommand();
          const admitted = await recordDispatch(revoked, 0, worker, 30, 20);
          await db.query(
            `UPDATE public.users SET ${changed} WHERE id=(
            SELECT prepared.recorded_by FROM public.universal_v1_prepared_financial_commands prepared
            JOIN public.financial_provider_command_journal requested
              ON requested.prepared_financial_command_id=prepared.prepared_command_id
            WHERE requested.command_id=$1)`,
            [revoked.commandId]
          );
          await expect(
            worker.query(executionSql, [admitted.jobValidationId, admitted.workerInstanceId])
          ).rejects.toThrow('CUSTOMER_AUTHORITY_REVOKED');
          expect(
            (
              await db.query(
                `SELECT count(*)::integer AS count
            FROM public.hxos_fake_financial_operation_events_v1 event
            WHERE event.admitted_job_validation_id=$1`,
                [admitted.jobValidationId]
              )
            ).rows
          ).toEqual([{ count: 0 }]);
          expect((await recover(revoked)).provider_event).toBeNull();
        }

        const outcomeCommand = await createQueuedCommand();
        const outcomeAdmission = await recordDispatch(outcomeCommand, 0, worker, 3, 2);
        const outcomeArgs = [
          outcomeAdmission.jobValidationId,
          outcomeAdmission.workerInstanceId,
          outcomeAdmission.recoveryLeaseId,
        ];
        await worker.query('BEGIN');
        try {
          await worker.query(executionSql, outcomeArgs.slice(0, 2));
          await expect(worker.query(outcomeSql, outcomeArgs)).rejects.toThrow(
            'COMMITTED_EVENT_REQUIRED'
          );
        } finally {
          await worker.query('ROLLBACK');
        }
        const rawOutcome = (await worker.query(executionSql, outcomeArgs.slice(0, 2))).rows[0]!;
        // A progress read must not adopt its own uncommitted outcome.
        await worker.query('BEGIN');
        try {
          await worker.query(outcomeSql, outcomeArgs);
          await expect(worker.query(progressSql, progressArgs(outcomeCommand))).rejects.toThrow(
            'COMMITTED_OUTCOME_REQUIRED'
          );
        } finally {
          await worker.query('ROLLBACK');
        }
        // The first transaction commits but its response is deliberately discarded.
        await worker.query('BEGIN');
        await worker.query(outcomeSql, outcomeArgs);
        await worker.query('COMMIT');
        const observedOutcome = (await worker.query(outcomeSql, outcomeArgs)).rows[0]!;
        const terminalProgress = await progress(outcomeCommand);
        expect(terminalProgress.recorded_outcome).toEqual(observedOutcome);
        expect(
          decodeProgress(terminalProgress, outcomeCommand).recordedOutcome?.outcome.outcome_fact_id
        ).toBe(observedOutcome.outcome_fact.outcome_fact_id);
        expect(observedOutcome).toMatchObject({
          idempotency_replayed: true,
          outcome_fact: {
            command_id: outcomeCommand.commandId,
            dispatch_attempt_id: outcomeAdmission.dispatchAttemptId,
            outcome_kind: 'OUTCOME_OBSERVED',
            provider_state: 'SUCCEEDED',
            provider_result_version: 1,
            amount_cents: null,
            currency: null,
            effect_certainty: 'CONFIRMED_EFFECT',
            retryable: false,
            failure_code: null,
            recovery_delay_seconds: null,
            recovery_not_before: null,
            external_reference_sha256: createHash('sha256')
              .update(rawOutcome.external_reference)
              .digest('hex'),
          },
        });
        const materializeSql =
          'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)';
        expect(Object.keys(observedOutcome.outcome_fact)).toHaveLength(19);
        expect(observedOutcome.outcome_fact).not.toHaveProperty('recording_transaction_id');
        await expect(
          api.query(materializeSql, [
            outcomeAdmission.jobValidationId,
            observedOutcome.outcome_fact.outcome_fact_id,
          ])
        ).rejects.toThrow(/permission denied/u);
        const fixtureQuery: QueryFn = async <Row = Record<string, unknown>>(
          sql: string,
          params?: unknown[]
        ) => {
          const result = await db.query(sql, params);
          return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
        };
        const fixtureTransaction = async <T>(
          callback: (query: QueryFn) => Promise<T>,
          serializable = false
        ): Promise<T> => {
          const connection = await db.connect();
          try {
            await connection.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
            const result = await callback(
              async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                const reply = await connection.query(sql, params);
                return { rows: reply.rows as Row[], rowCount: reply.rowCount ?? 0 };
              }
            );
            await connection.query('COMMIT');
            return result;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            connection.release();
          }
        };
        const fixtureDatabase = {
          query: fixtureQuery,
          readQuery: fixtureQuery,
          transaction: fixtureTransaction,
          serializableTransaction: <T>(callback: (query: QueryFn) => Promise<T>) =>
            fixtureTransaction(callback, true),
        } as Database;
        const decodeMaterialization = (
          row: unknown,
          queued: QueuedCommand,
          admissionId: string,
          outcomeId: string
        ) =>
          decodeFakeFinancialMaterializationRow(
            row,
            {
              jobId: queued.bullmqJobId,
              payload: {
                version: 1,
                kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
                commandId: queued.commandId,
                outboxRequestId: queued.outboxRequestId,
                jobAuthoritySha256: queued.jobAuthoritySha256,
              },
              jobValidationId: admissionId,
              outcomeFactId: outcomeId,
            },
            {
              environment: 'local',
              databaseName: new URL(fixture!.databaseUrl).pathname.slice(1),
              targetDigest: 'synthetic-receipt-reader',
              manifestDigest: `sha256:${'a'.repeat(64)}`,
            }
          );
        {
          // Every revocation occurs after an immutable PREPARED/request/admission.
          // Failure must leave both raw tables empty for that exact operation.
          const assertNoRawEffect = async (candidate: QueuedCommand) => {
            expect(
              (
                await db.query(
                  `SELECT
            (SELECT count(*)::integer FROM public.hxos_fake_financial_operations_v1 operation
              JOIN public.financial_provider_command_journal request USING(operation_id)
              WHERE request.command_id=$1) AS operations,
            (SELECT count(*)::integer FROM public.hxos_fake_financial_operation_events_v1 event
              JOIN public.financial_provider_command_journal request USING(operation_id)
              WHERE request.command_id=$1) AS events,
            (SELECT count(*)::integer FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
              WHERE bridge.command_id=$1) AS bridges`,
                  [candidate.commandId]
                )
              ).rows
            ).toEqual([{ operations: 0, events: 0, bridges: 0 }]);
            expect((await recover(candidate)).provider_event).toBeNull();
          };
          for (const change of [
            {
              sql: "UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1",
              reason: 'PROVIDER_AUTHORITY_REVOKED',
            },
            {
              sql: 'UPDATE public.users SET is_banned=TRUE WHERE id=$1',
              reason: 'PROVIDER_AUTHORITY_REVOKED',
            },
            {
              sql: 'UPDATE public.users SET trust_hold=TRUE,trust_hold_until=NULL WHERE id=$1',
              reason: 'PROVIDER_AUTHORITY_REVOKED',
            },
            {
              sql: "UPDATE public.capability_profiles SET provider_class='VERIFIED_TRADE_BUSINESS' WHERE user_id=$1",
              reason: 'PROVIDER_AUTHORITY_REVOKED',
            },
          ]) {
            const lane = await createAcceptedEstimateFixture(
              fixtureDatabase,
              db,
              'provider-revoke'
            );
            const candidate = await createQueuedCommand(300, db, lane);
            const admitted = await recordDispatch(candidate, 0, worker, 30, 20);
            await db.query(change.sql, [lane.providerUserId]);
            await expect(
              worker.query(executionSql, [admitted.jobValidationId, admitted.workerInstanceId])
            ).rejects.toThrow(change.reason);
            await assertNoRawEffect(candidate);
          }
          const blockedLane = await createAcceptedEstimateFixture(
            fixtureDatabase,
            db,
            'domain-lock'
          );
          const blockedCandidate = await createQueuedCommand(300, db, blockedLane);
          const blockedAdmission = await recordDispatch(blockedCandidate, 0, worker, 30, 20);
          const domainBlocker = await db.connect();
          try {
            await domainBlocker.query('BEGIN');
            await domainBlocker.query('SELECT 1 FROM public.users WHERE id=$1 FOR UPDATE', [
              blockedLane.providerUserId,
            ]);
            await expect(
              worker.query(executionSql, [
                blockedAdmission.jobValidationId,
                blockedAdmission.workerInstanceId,
              ])
            ).rejects.toThrow(/could not obtain lock/u);
            await domainBlocker.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
              blockedLane.providerUserId,
            ]);
            await domainBlocker.query('COMMIT');
            await expect(
              worker.query(executionSql, [
                blockedAdmission.jobValidationId,
                blockedAdmission.workerInstanceId,
              ])
            ).rejects.toThrow('PROVIDER_AUTHORITY_REVOKED');
          } finally {
            await domainBlocker.query('ROLLBACK');
            domainBlocker.release();
          }
          await assertNoRawEffect(blockedCandidate);

          const reviseEligibility = async (
            lane: FinancialTaskFixture,
            lifetimeSeconds: number | null = null
          ) => {
            const inserted = await db.query(
              `INSERT INTO public.task_provider_eligibility_decisions
              SELECT (pg_catalog.jsonb_populate_record(NULL::public.task_provider_eligibility_decisions,
                pg_catalog.to_jsonb(source) || pg_catalog.jsonb_build_object(
                  'id',gen_random_uuid(),'decision_version',source.decision_version+1,
                  'supersedes_decision_id',source.id,'idempotency_key',$2::text,
                  'evaluated_at',clock_timestamp(),
                  'valid_until',CASE WHEN $3::integer IS NULL THEN source.valid_until
                    ELSE clock_timestamp()+make_interval(secs=>$3) END))).*
              FROM public.task_provider_eligibility_decisions source WHERE source.id=$1 RETURNING id`,
              [lane.eligibilityDecisionId, 'domain-revision:' + randomUUID(), lifetimeSeconds]
            );
            return inserted.rows[0]!.id as string;
          };
          const supersededLane = await createAcceptedEstimateFixture(
            fixtureDatabase,
            db,
            'eligibility-successor'
          );
          const supersededCandidate = await createQueuedCommand(300, db, supersededLane);
          const supersededAdmission = await recordDispatch(supersededCandidate, 0, worker, 30, 20);
          await reviseEligibility(supersededLane);
          await expect(
            worker.query(executionSql, [
              supersededAdmission.jobValidationId,
              supersededAdmission.workerInstanceId,
            ])
          ).rejects.toThrow('ELIGIBILITY_AUTHORITY_REVOKED');
          await assertNoRawEffect(supersededCandidate);
          const expiredLane = await createAcceptedEstimateFixture(
            fixtureDatabase,
            db,
            'eligibility-expiry'
          );
          expiredLane.eligibilityDecisionId = await reviseEligibility(expiredLane, 1);
          const expiredCandidate = await createQueuedCommand(300, db, expiredLane);
          const expiredAdmission = await recordDispatch(expiredCandidate, 0, worker, 30, 20);
          await db.query(
            'SELECT pg_sleep_until(valid_until) FROM public.task_provider_eligibility_decisions WHERE id=$1',
            [expiredLane.eligibilityDecisionId]
          );
          await expect(
            worker.query(executionSql, [
              expiredAdmission.jobValidationId,
              expiredAdmission.workerInstanceId,
            ])
          ).rejects.toThrow('ELIGIBILITY_AUTHORITY_REVOKED');
          await assertNoRawEffect(expiredCandidate);
          const incidentLane = await createAcceptedEstimateFixture(
            fixtureDatabase,
            db,
            'incident-revoke'
          );
          const incidentCandidate = await createQueuedCommand(300, db, incidentLane);
          const incidentAdmission = await recordDispatch(incidentCandidate, 0, worker, 30, 20);
          await db.query(
            `INSERT INTO public.task_safety_incidents(task_id,reporter_user_id,category,
            urgency,description,contact_permission,idempotency_key) VALUES($1,$2,'other','standard',
            'Synthetic authority revocation incident','do_not_contact',$3)`,
            [incidentLane.taskId, incidentLane.posterUserId, randomUUID()]
          );
          await expect(
            worker.query(executionSql, [
              incidentAdmission.jobValidationId,
              incidentAdmission.workerInstanceId,
            ])
          ).rejects.toThrow('TASK_AUTHORITY_REVOKED');
          await assertNoRawEffect(incidentCandidate);

          const apiQuery: QueryFn = async <Row = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
          ) => {
            try {
              const result = await api.query(sql, params);
              return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
            } catch (error) {
              console.error('Synthetic Phase A API command failed:', (error as Error).message);
              throw error;
            }
          };
          const apiTransaction = async <T>(
            callback: (query: QueryFn) => Promise<T>,
            serializable = false
          ) => {
            await api.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
            try {
              const result = await callback(apiQuery);
              await api.query('COMMIT');
              return result;
            } catch (error) {
              await api.query('ROLLBACK');
              throw error;
            }
          };
          const apiDatabase = {
            query: apiQuery,
            readQuery: apiQuery,
            transaction: apiTransaction,
            serializableTransaction: <T>(callback: (query: QueryFn) => Promise<T>) =>
              apiTransaction(callback, true),
          } as Database;
          const attester = await connectAs(roles.attester!);
          for (const phaseScenario of ['SUCCESS', 'AUTHORIZE_CANCEL', 'SECURE_CANCEL'] as const) {
            const phaseFixture = await createPreparedWorkOrderFixture(
              fixtureDatabase,
              db,
              apiDatabase,
              attester,
              roles.attester!,
              target.release_manifest_sha256,
              'positive-finance'
            );
            const executeAndMaterialize = async (candidate: QueuedCommand) => {
              const admitted = await recordDispatch(candidate, 0, worker, 30, 20);
              const raw = (
                await worker.query(executionSql, [
                  admitted.jobValidationId,
                  admitted.workerInstanceId,
                ])
              ).rows[0]!;
              const observed = (
                await worker.query(outcomeSql, [
                  admitted.jobValidationId,
                  admitted.workerInstanceId,
                  admitted.recoveryLeaseId,
                ])
              ).rows[0]!;
              const materialized = (
                await worker.query(materializeSql, [
                  admitted.jobValidationId,
                  observed.outcome_fact.outcome_fact_id,
                ])
              ).rows[0]!;
              const decoded = decodeMaterialization(
                materialized,
                candidate,
                admitted.jobValidationId,
                observed.outcome_fact.outcome_fact_id
              );
              expect(decoded.financialEvent).toEqual(materialized.financial_event);
              expect(decoded.lifecycleBridge).toEqual(materialized.lifecycle_bridge);
              return { admitted, raw, observed, materialized };
            };
            const prepareSubmission = await prepareQueuedCommand(
              db,
              phaseFixture.lane,
              phaseFixture.key,
              { database: apiDatabase, attester, attesterRole: roles.attester! }
            );
            const methodCommand = await createQueuedCommand(
              300,
              db,
              phaseFixture.lane,
              prepareSubmission
            );
            const methodProof = await executeAndMaterialize(methodCommand);
            const prepareMoney = async (
              kind: 'AUTHORIZE' | 'SECURE',
              predecessor: typeof methodProof
            ) => {
              const operationId = deterministicUuid(phaseFixture.key, kind.toLowerCase());
              const idempotencyKey =
                phaseFixture.key + (kind === 'AUTHORIZE' ? ':auth' : ':secure');
              const amountCents = Number(phaseFixture.phase.context.customer_total_cents);
              const currency = phaseFixture.phase.context.currency.toLowerCase();
              const canonicalRequest = encodeFakeFinancialDurableRequest(kind, {
                operationId,
                idempotencyKey,
                expectedVersion: 0,
                amountCents,
                currency,
                relatedOperationId: predecessor.raw.operation_id,
                ...(kind === 'AUTHORIZE'
                  ? { paymentMethodReference: predecessor.raw.external_reference }
                  : { authorizationOperationId: predecessor.raw.operation_id }),
              }).canonicalRequestJson;
              const sha = createHash('sha256').update(canonicalRequest).digest('hex');
              const receipt = await new PostgresUniversalV1PreparedFinancialCommandAuthority(
                apiDatabase
              ).prepare(
                {
                  operationKind: kind,
                  operationId,
                  providerKind: 'FAKE',
                  idempotencyKey,
                  providerExpectedVersion: 0,
                  lifecycleExpectedVersion: kind === 'AUTHORIZE' ? 1 : 2,
                  providerRequestSha256: sha,
                  taskDraftId: phaseFixture.lane.draftId,
                  taskId: phaseFixture.lane.taskId,
                  eligibilityDecisionId: phaseFixture.lane.eligibilityDecisionId,
                  scopeVersionId: phaseFixture.lane.scopeVersionId,
                  recordedBy: phaseFixture.lane.posterUserId,
                  predecessorEventId: predecessor.materialized.financial_event.id,
                  relatedOperationId: predecessor.raw.operation_id,
                  amountCents,
                  currency,
                  changeOrderId: null,
                  completionFactId: null,
                },
                await createSyntheticActorAttestation(
                  db,
                  apiDatabase,
                  attester,
                  roles.attester!,
                  target.release_manifest_sha256,
                  phaseFixture.lane.posterUserId
                )
              );
              const prepared = {
                prepared_command_id: receipt.preparedCommandId,
                authority_context_sha256: receipt.authorityContextSha256,
              };
              const identity = JSON.parse(prepareSubmission.canonicalIdentity);
              Object.assign(identity, {
                operationKind: kind,
                operationId,
                idempotencyKey,
                requestSha256: sha,
              });
              Object.assign(identity.evidence, {
                preparedFinancialCommandId: prepared.prepared_command_id,
                preparedAuthoritySha256: prepared.authority_context_sha256,
                relatedOperationId: predecessor.raw.operation_id,
                amountCents,
                currency: currency.toUpperCase(),
              });
              return {
                canonicalRequest,
                canonicalIdentity: JSON.stringify(identity),
                preparedCommandId: prepared.prepared_command_id as string,
                idempotencyKey,
              };
            };
            const authorizationSubmission = await prepareMoney('AUTHORIZE', methodProof);
            const authorizationCommand = await createQueuedCommand(
              300,
              db,
              phaseFixture.lane,
              authorizationSubmission
            );
            if (phaseScenario === 'AUTHORIZE_CANCEL') {
              const admitted = await recordDispatch(authorizationCommand, 0, worker, 30, 20);
              await db.query("UPDATE public.task_reservations SET status='CANCELLED' WHERE id=$1", [
                phaseFixture.hold.conditional_hold_id,
              ]);
              await expect(
                worker.query(executionSql, [admitted.jobValidationId, admitted.workerInstanceId])
              ).rejects.toThrow('COMMITMENT_AUTHORITY_REVOKED');
              await assertNoRawEffect(authorizationCommand);
              continue;
            }
            const authorizationProof = await executeAndMaterialize(authorizationCommand);
            expect(authorizationProof.raw).toMatchObject({
              operation_kind: 'AUTHORIZE',
              state: 'SUCCEEDED',
              amount_cents: '10000',
              currency: 'usd',
            });
            const secureSubmission = await prepareMoney('SECURE', authorizationProof);
            const secureCommand = await createQueuedCommand(
              300,
              db,
              phaseFixture.lane,
              secureSubmission
            );
            if (phaseScenario === 'SUCCESS') {
              const secured = await executeAndMaterialize(secureCommand);
              expect(secured.raw).toMatchObject({
                operation_kind: 'SECURE',
                state: 'SUCCEEDED',
                amount_cents: '10000',
                currency: 'usd',
              });
              expect(secured.materialized.financial_event).toMatchObject({
                event_kind: 'SECURED',
                status: 'SUCCEEDED',
                amount_cents: 10000,
                currency: 'USD',
              });
              await db.query("UPDATE public.task_reservations SET status='CANCELLED' WHERE id=$1", [
                phaseFixture.hold.conditional_hold_id,
              ]);
              const replay = (
                await worker.query(materializeSql, [
                  secured.admitted.jobValidationId,
                  secured.observed.outcome_fact.outcome_fact_id,
                ])
              ).rows[0]!;
              expect(replay).toEqual({ ...secured.materialized, idempotency_replayed: true });
              expect((await recover(secureCommand)).provider_event.event_id).toBe(
                secured.raw.event_id
              );
              continue;
            }
            const secureAdmission = await recordDispatch(secureCommand, 0, worker, 30, 20);
            // The exact recorded hold is required even though preparation was valid.
            await db.query("UPDATE public.task_reservations SET status='CANCELLED' WHERE id=$1", [
              phaseFixture.hold.conditional_hold_id,
            ]);
            await expect(
              worker.query(executionSql, [
                secureAdmission.jobValidationId,
                secureAdmission.workerInstanceId,
              ])
            ).rejects.toThrow('COMMITMENT_AUTHORITY_REVOKED');
            await assertNoRawEffect(secureCommand);
            // Committed AUTHORIZE evidence remains recoverable after the hold is revoked.
            expect((await recover(authorizationCommand)).provider_event.event_id).toBe(
              authorizationProof.raw.event_id
            );
          }
        }
        const taskFixture = await createAcceptedEstimateFixture(
          fixtureDatabase,
          db,
          'reconcile-materialization'
        );
        const materializeCommand = await createQueuedCommand(300, db, taskFixture);
        const materializeAdmission = await recordDispatch(materializeCommand, 0, worker, 3, 2);
        const materializeRaw = (
          await worker.query(executionSql, [
            materializeAdmission.jobValidationId,
            materializeAdmission.workerInstanceId,
          ])
        ).rows[0]!;
        await worker.query('BEGIN');
        try {
          const pendingOutcome = (
            await worker.query(outcomeSql, [
              materializeAdmission.jobValidationId,
              materializeAdmission.workerInstanceId,
              materializeAdmission.recoveryLeaseId,
            ])
          ).rows[0]!;
          await expect(
            worker.query(materializeSql, [
              materializeAdmission.jobValidationId,
              pendingOutcome.outcome_fact.outcome_fact_id,
            ])
          ).rejects.toThrow('COMMITTED_OUTCOME_REQUIRED');
        } finally {
          await worker.query('ROLLBACK');
        }
        await db.query(
          'SELECT pg_sleep_until(expires_at) FROM public.financial_provider_command_recovery_leases WHERE recovery_lease_id=$1',
          [materializeAdmission.recoveryLeaseId]
        );
        const materializeLeaseArgs = [
          materializeAdmission.jobValidationId,
          randomUUID(),
          randomUUID(),
          3,
        ];
        await worker.query(leaseSql, materializeLeaseArgs);
        const materializeOutcome = (
          await worker.query(outcomeSql, materializeLeaseArgs.slice(0, 3))
        ).rows[0]!;
        const materializeArgs = [
          materializeAdmission.jobValidationId,
          materializeOutcome.outcome_fact.outcome_fact_id,
        ];
        await expect(
          worker.query(materializeSql, [
            materializeAdmission.jobValidationId,
            observedOutcome.outcome_fact.outcome_fact_id,
          ])
        ).rejects.toThrow('TERMINAL_OUTCOME_REQUIRED');
        const unknownFact = await db.query(
          "SELECT outcome_fact_id FROM public.financial_provider_command_outcome_facts WHERE command_id=$1 AND outcome_kind='OUTCOME_UNKNOWN' LIMIT 1",
          [unknownCommand.commandId]
        );
        await expect(
          worker.query(materializeSql, [
            unknownAdmission.jobValidationId,
            unknownFact.rows[0]!.outcome_fact_id,
          ])
        ).rejects.toThrow('TERMINAL_OUTCOME_REQUIRED');
        const taskRowBlocker = await db.connect();
        try {
          await taskRowBlocker.query('BEGIN');
          await taskRowBlocker.query('SELECT id FROM public.tasks WHERE id=$1 FOR UPDATE', [
            taskFixture.taskId,
          ]);
          await worker.query('BEGIN');
          try {
            await worker.query("SET LOCAL lock_timeout='1s'");
            await expect(worker.query(materializeSql, materializeArgs)).rejects.toThrow(
              /could not obtain lock on row in relation "tasks"/u
            );
          } finally {
            await worker.query('ROLLBACK');
          }
          expect(
            (
              await taskRowBlocker.query(
                "SELECT pg_try_advisory_xact_lock(hashtextextended('hxuv1-financial-security-task:' || $1::text,0)) AS acquired",
                [taskFixture.taskId]
              )
            ).rows
          ).toEqual([{ acquired: true }]);
          const unmaterialized = await db.query(
            'SELECT count(*)::integer AS count FROM public.task_financial_security_events WHERE operation_id=$1',
            [materializeRaw.operation_id]
          );
          expect(unmaterialized.rows).toEqual([{ count: 0 }]);
          await taskRowBlocker.query('COMMIT');
        } finally {
          await taskRowBlocker.query('ROLLBACK');
          taskRowBlocker.release();
        }
        const firstMaterializations = await Promise.all([
          worker.query(materializeSql, materializeArgs),
          concurrentWorker.query(materializeSql, materializeArgs),
        ]);
        const creations = firstMaterializations
          .flatMap((result) => result.rows)
          .filter((row) => !row.idempotency_replayed);
        expect(creations).toHaveLength(1);
        const materialized = creations[0]!;
        for (const result of firstMaterializations)
          expect(result.rows[0]).toEqual({
            ...materialized,
            idempotency_replayed: result.rows[0]!.idempotency_replayed,
          });
        expect(materialized).toMatchObject({
          idempotency_replayed: false,
          financial_event: {
            event_kind: 'PAYMENT_METHOD_PREPARED',
            status: 'SUCCEEDED',
            task_id: taskFixture.taskId,
          },
          lifecycle_bridge: {
            dispatch_attempt_id: materializeAdmission.dispatchAttemptId,
            outcome_fact_id: materializeArgs[1],
            fake_operation_event_id: materializeRaw.event_id,
          },
        });
        expect(new Date(materialized.financial_event.occurred_at).toISOString()).toBe(
          new Date(materializeRaw.recorded_at).toISOString()
        );
        expect(materialized.financial_event.expires_at).toBeNull();
        // Validate the real restricted-worker receipt, including all three bridge
        // hashes, through the same decoder used by the application port.
        const decodedMaterialization = decodeMaterialization(
          materialized,
          materializeCommand,
          materializeAdmission.jobValidationId,
          materializeArgs[1]!
        );
        expect(decodedMaterialization.financialEvent).toEqual(materialized.financial_event);
        expect(decodedMaterialization.lifecycleBridge).toEqual(materialized.lifecycle_bridge);
        const materializeDuplicates = await Promise.all([
          worker.query(materializeSql, materializeArgs),
          concurrentWorker.query(materializeSql, materializeArgs),
        ]);
        for (const duplicate of materializeDuplicates)
          expect(duplicate.rows).toEqual([{ ...materialized, idempotency_replayed: true }]);
        await db.query(
          'SELECT pg_sleep_until(expires_at) FROM public.financial_provider_command_recovery_leases WHERE recovery_lease_id=$1',
          [materializeLeaseArgs[2]]
        );
        expect((await worker.query(materializeSql, materializeArgs)).rows).toEqual([
          { ...materialized, idempotency_replayed: true },
        ]);
        const dispatchFixture = await createAcceptedEstimateFixture(
          fixtureDatabase,
          db,
          'dispatch-materialization'
        );
        const dispatchMaterializeCommand = await createQueuedCommand(300, db, dispatchFixture);
        const dispatchMaterializeAdmission = await recordDispatch(
          dispatchMaterializeCommand,
          0,
          worker,
          3,
          2
        );
        const dispatchMaterializeArgs = [
          dispatchMaterializeAdmission.jobValidationId,
          dispatchMaterializeAdmission.workerInstanceId,
          dispatchMaterializeAdmission.recoveryLeaseId,
        ];
        await worker.query(executionSql, dispatchMaterializeArgs.slice(0, 2));
        const dispatchMaterializeOutcome = (await worker.query(outcomeSql, dispatchMaterializeArgs))
          .rows[0]!;
        await db.query(
          'SELECT pg_sleep_until(expires_at) FROM public.financial_provider_command_recovery_leases WHERE recovery_lease_id=$1',
          [dispatchMaterializeAdmission.recoveryLeaseId]
        );
        const dispatchMaterialized = (
          await worker.query(materializeSql, [
            dispatchMaterializeAdmission.jobValidationId,
            dispatchMaterializeOutcome.outcome_fact.outcome_fact_id,
          ])
        ).rows[0]!;
        expect(dispatchMaterialized).toMatchObject({
          idempotency_replayed: false,
          recovery_lease: { recovery_action: 'DISPATCH' },
          lifecycle_bridge: { dispatch_attempt_id: dispatchMaterializeAdmission.dispatchAttemptId },
        });
        expect(
          decodeMaterialization(
            dispatchMaterialized,
            dispatchMaterializeCommand,
            dispatchMaterializeAdmission.jobValidationId,
            dispatchMaterializeOutcome.outcome_fact.outcome_fact_id
          ).lease.recovery_action
        ).toBe('DISPATCH');

        const expectedProjection = [
          rawOutcome.operation_id,
          rawOutcome.operation_kind,
          'FAKE',
          'SUCCEEDED',
          '1',
          '',
          '',
          createHash('sha256').update(rawOutcome.external_reference).digest('hex'),
          'false',
        ].join(':');
        expect(observedOutcome.outcome_fact.provider_result_sha256).toBe(
          createHash('sha256').update(expectedProjection).digest('hex')
        );
        const duplicateOutcomes = await Promise.all([
          worker.query(outcomeSql, outcomeArgs),
          concurrentWorker.query(outcomeSql, outcomeArgs),
        ]);
        for (const duplicate of duplicateOutcomes)
          expect(duplicate.rows).toEqual([observedOutcome]);
        await expect(
          worker.query(leaseSql, [outcomeAdmission.jobValidationId, randomUUID(), randomUUID(), 30])
        ).rejects.toThrow(/terminal outcome/i);
        await worker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          await expect(worker.query(outcomeSql, outcomeArgs)).rejects.toThrow(
            'READ_COMMITTED_REQUIRED'
          );
        } finally {
          await worker.query('ROLLBACK');
        }
        for (const relation of [
          'public.financial_provider_command_outcome_facts',
          'public.financial_provider_command_recovery_leases',
        ]) {
          await expect(worker.query(`INSERT INTO ${relation} DEFAULT VALUES`)).rejects.toThrow(
            'permission denied'
          );
          await expect(worker.query(`SELECT * FROM ${relation}`)).rejects.toThrow(
            'permission denied'
          );
        }

        // Simulate an existing pre-v13 raw event with exact hashes but no admission
        // provenance. It must remain evidence only, never adopted by this port.
        const historicalCommand = await createQueuedCommand();
        const historicalAdmission = await recordDispatch(historicalCommand, 0, worker);
        const historicalRead = await admittedRead(historicalAdmission);
        const projection = (
          await db.query(
            `SELECT hx_authority.derive_fake_financial_projection_v13($1,$2) AS projection`,
            [historicalRead.operation_kind, historicalRead.canonical_provider_request]
          )
        ).rows[0]!.projection;
        await db.query(
          `INSERT INTO public.hxos_fake_financial_operations_v1(
          operation_id,operation_kind,identity_sha256,external_reference)
          VALUES ($1,$2,$3,$4)`,
          [
            projection.operationId,
            projection.operationKind,
            projection.identitySha256,
            projection.externalReference,
          ]
        );
        await db.query(
          `INSERT INTO public.hxos_fake_financial_operation_events_v1(
          operation_id,operation_kind,event_version,state,scenario,external_reference,idempotency_key,
          identity_sha256,request_sha256,provider_request_sha256,response_sha256,retryable,metadata)
          VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            projection.operationId,
            projection.operationKind,
            projection.state,
            projection.scenario,
            projection.externalReference,
            projection.idempotencyKey,
            projection.identitySha256,
            projection.requestSha256,
            projection.providerRequestSha256,
            projection.responseSha256,
            projection.retryable,
            projection.metadata,
          ]
        );
        await expect(
          worker.query(executionSql, [
            historicalAdmission.jobValidationId,
            historicalAdmission.workerInstanceId,
          ])
        ).rejects.toThrow('EVENT_PROVENANCE_CONFLICT');
        await expect(recover(historicalCommand)).rejects.toThrow('EVENT_PROVENANCE_CONFLICT');
        expect(await rawCounts(historicalRead.operation_id)).toEqual([
          { operations: 1, events: 1 },
        ]);
        expect(
          (
            await db.query(
              `SELECT admitted_job_validation_id FROM public.hxos_fake_financial_operation_events_v1
          WHERE operation_id=$1`,
              [historicalRead.operation_id]
            )
          ).rows
        ).toEqual([{ admitted_job_validation_id: null }]);
        for (const relation of [
          'public.hxos_fake_financial_operations_v1',
          'public.hxos_fake_financial_operation_events_v1',
        ]) {
          await expect(worker.query(`SELECT * FROM ${relation}`)).rejects.toThrow(
            /permission denied/u
          );
          await expect(worker.query(`INSERT INTO ${relation} DEFAULT VALUES`)).rejects.toThrow(
            /permission denied/u
          );
        }
        await expect(
          api.query('SELECT * FROM public.hxos_read_admitted_fake_financial_request_v13($1,$2)', [
            admission.job_validation_id,
            admitted.evidence.worker_instance_id,
          ])
        ).rejects.toThrow(/permission denied/u);
        expect(await evidenceCounts(command.commandId)).toMatchObject({
          admissions: 1,
          leases: 1,
          attempts: 1,
          validations: 1,
        });
        if (process.env.REDIS_URL !== 'redis://127.0.0.1:16379')
          throw new Error('EXACT_SYNTHETIC_REDIS_REQUIRED');
        const prefix = `hx-ci-v13-publisher-${randomUUID()}`;
        const queue = new Queue('synthetic_finance', {
          prefix,
          connection: { host: '127.0.0.1', port: 16379, maxRetriesPerRequest: 1 },
        });
        const repository = new PostgresFakeFinancialOutboxRepository({
          transaction: async (callback) => {
            await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
            try {
              const query: QueryFn = async <T>(sql: string, params?: unknown[]) => {
                const response = await worker.query(sql, params);
                return { rows: response.rows as T[], rowCount: response.rowCount ?? 0 };
              };
              const value = await callback(query);
              await worker.query('COMMIT');
              return value;
            } catch (error) {
              await worker.query('ROLLBACK');
              throw error;
            }
          },
        });
        const transport = createFakeFinancialOutboxTransport({
          redisUrl: process.env.REDIS_URL,
          prefix,
        });
        try {
          const durable = await createQueuedCommand(null);
          const loseRedisAcknowledgement = new FakeFinancialOutboxPublisher(
            repository,
            {
              publish: async (claim) => {
                await transport.publish(claim);
                throw new Error('synthetic acknowledgement loss');
              },
            },
            () => undefined,
            { publisherId: randomUUID(), batchLimit: 1, retryDelaySeconds: 1 }
          );
          expect(await loseRedisAcknowledgement.runOnce()).toMatchObject({
            confirmed: 0,
            retryableFailures: 1,
          });
          await db.query('SELECT pg_sleep(1.05)');
          // A restarted publisher reads the actual existing job; it does not
          // create another command, overwrite its payload, or infer add success.
          const restarted = new FakeFinancialOutboxPublisher(
            repository,
            transport,
            () => undefined,
            { publisherId: randomUUID(), batchLimit: 1 }
          );
          expect(await restarted.runOnce()).toMatchObject({ confirmed: 1, persistenceErrors: 0 });
          const persisted = await queue.getJob(durable.bullmqJobId);
          expect(persisted?.data).toEqual({
            version: 1,
            kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
            outboxRequestId: durable.outboxRequestId,
            commandId: durable.commandId,
            jobAuthoritySha256: durable.jobAuthoritySha256,
          });
          expect(persisted?.opts).toMatchObject({
            removeOnComplete: false,
            removeOnFail: false,
            attempts: 64,
          });
          expect(await queue.getJobCounts('wait', 'active', 'completed', 'failed')).toMatchObject({
            wait: 1,
            active: 0,
            completed: 0,
            failed: 0,
          });
          expect(
            (
              await db.query(
                `SELECT claim_number FROM hx_authority.fake_financial_outbox_publish_claims_v13 WHERE outbox_request_id=$1 ORDER BY claim_number`,
                [durable.outboxRequestId]
              )
            ).rows
          ).toEqual([{ claim_number: 1 }, { claim_number: 2 }]);
          expect(await evidenceCounts(durable.commandId)).toMatchObject({
            admissions: 0,
            leases: 0,
            attempts: 0,
            validations: 0,
          });

          const collision = await createQueuedCommand(null);
          await queue.add(
            'synthetic_finance.command.v13',
            { forged: 'synthetic collision' },
            { jobId: collision.bullmqJobId }
          );
          expect(await restarted.runOnce()).toMatchObject({ confirmed: 0, terminalFailures: 1 });
          expect((await queue.getJob(collision.bullmqJobId))?.data).toEqual({
            forged: 'synthetic collision',
          });
          expect(await evidenceCounts(collision.commandId)).toMatchObject({
            admissions: 0,
            leases: 0,
            attempts: 0,
            validations: 0,
          });
          await expect(recordDispatch(collision, 0, worker)).rejects.toThrow(
            /terminal|held|publish/iu
          );
          const delayed = await createQueuedCommand(null);
          await queue.add(
            'synthetic_finance.command.v13',
            {
              version: 1,
              kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
              outboxRequestId: delayed.outboxRequestId,
              commandId: delayed.commandId,
              jobAuthoritySha256: delayed.jobAuthoritySha256,
            },
            {
              jobId: delayed.bullmqJobId,
              attempts: 64,
              backoff: { type: 'fixed', delay: 5000 },
              removeOnComplete: false,
              removeOnFail: false,
              delay: 86400 * 365 * 1000,
            }
          );
          expect(await restarted.runOnce()).toMatchObject({ confirmed: 0, terminalFailures: 1 });
          expect((await queue.getJob(delayed.bullmqJobId))?.opts.delay).toBe(86400 * 365 * 1000);
          await expect(recordDispatch(delayed, 0, worker)).rejects.toThrow(
            /terminal|held|publish/iu
          );
        } finally {
          if (!/^hx-ci-v13-publisher-[a-f0-9-]{36}$/u.test(prefix))
            throw new Error('UNSAFE_SYNTHETIC_QUEUE_CLEANUP');
          const cleanupErrors: unknown[] = [];
          try {
            await queue.obliterate({ force: true });
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            await queue.close();
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (cleanupErrors.length)
            throw new AggregateError(cleanupErrors, 'SYNTHETIC_QUEUE_CLEANUP_FAILED');
        }
        const submission = await prepareQueuedCommand();
        const identity = JSON.parse(submission.canonicalIdentity);
        const apiDatabase = {
          transaction: async <T>(callback: (query: QueryFn) => Promise<T>) => {
            await api.query('BEGIN');
            try {
              const query: QueryFn = async <R>(sql: string, params?: unknown[]) => {
                const result = await api.query(sql, params);
                return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
              };
              const value = await callback(query);
              await api.query('COMMIT');
              return value;
            } catch (error) {
              await api.query('ROLLBACK');
              throw error;
            }
          },
        } as Database;
        const journal = new PostgresFinancialProviderCommandJournal(apiDatabase);
        const input = { ...identity, exactRequest: JSON.parse(submission.canonicalRequest) };
        const requested = await journal.recordRequested(input);
        expect(requested.idempotencyReplayed).toBe(false);
        expect(requested.commandIdentitySha256).toBe(
          createHash('sha256').update(submission.canonicalIdentity).digest('hex')
        );
        expect(
          (
            await db.query(
              'SELECT canonical_provider_request FROM hx_authority.fake_financial_exact_requests_v13 WHERE command_id=$1',
              [requested.commandId]
            )
          ).rows
        ).toEqual([{ canonical_provider_request: submission.canonicalRequest }]);
        await expect(journal.recordRequested(input)).resolves.toEqual({
          ...requested,
          idempotencyReplayed: true,
        });
        await expect(
          api.query('SELECT * FROM public.financial_provider_command_journal')
        ).rejects.toThrow('permission denied');
        const beforeHistoricalRead = await evidenceCounts(recoveryCommand.commandId);
        const staleProgress = await publicProgressAssertion(requested);
        await db.query(
          `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts (
          authority_version,target_database_name,environment,release_manifest_sha256,
          activation_request_sha256,supersedes_target_authority_id
        ) VALUES ($1,current_database(),'local',$2,$3,$4)`,
          [
            target.authority_version + 1,
            `sha256:${'8'.repeat(64)}`,
            createHash('sha256').update(randomUUID()).digest('hex'),
            target.target_authority_id,
          ]
        );
        await expect(worker.query(executionSql, executionArgs)).rejects.toThrow(/target|manifest/i);
        await expect(
          api.query(
            'SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)',
            [staleProgress.actor_assertion_token, { commandId: requested.commandId }]
          )
        ).rejects.toThrow();
        expect(await publicProgress(requested)).toMatchObject({
          commandId: requested.commandId,
          progressState: 'RECOVERY_REQUIRED',
          financialEvent: null,
        });
        await worker.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const historicalRead = await recover(recoveryCommand);
          expect(historicalRead.request_evidence.target_authority_id).toBe(
            target.target_authority_id
          );
          expect(historicalRead.provider_event.event_id).toBe(committedExecution.event_id);
          await worker.query('COMMIT');
        } finally {
          await worker.query('ROLLBACK');
        }
        expect(await evidenceCounts(recoveryCommand.commandId)).toEqual(beforeHistoricalRead);
        const historicalLeaseArgs = [
          recoveryAdmission.jobValidationId,
          randomUUID(),
          randomUUID(),
          30,
        ];
        const historicalLease = (await worker.query(leaseSql, historicalLeaseArgs)).rows[0]!;
        const historicalOutcomeArgs = historicalLeaseArgs.slice(0, 3);
        const historicalOutcome = (await worker.query(outcomeSql, historicalOutcomeArgs)).rows[0]!;
        expect(historicalOutcome.outcome_fact).toMatchObject({
          outcome_kind: 'OUTCOME_OBSERVED',
          provider_state: 'SUCCEEDED',
          effect_certainty: 'CONFIRMED_EFFECT',
          dispatch_attempt_id: recoveryAdmission.dispatchAttemptId,
          recovery_lease_id: historicalLeaseArgs[2],
        });
        await expect(worker.query(leaseSql, historicalLeaseArgs)).resolves.toMatchObject({
          rows: [{ ...historicalLease, idempotency_replayed: true }],
        });
        await expect(worker.query(outcomeSql, historicalOutcomeArgs)).resolves.toMatchObject({
          rows: [{ ...historicalOutcome, idempotency_replayed: true }],
        });
        await db.query('SELECT pg_sleep_until($1::timestamptz)', [
          observedOutcome.recovery_lease.expires_at,
        ]);
        await expect(worker.query(outcomeSql, outcomeArgs)).resolves.toMatchObject({
          rows: [observedOutcome],
        });
        expect((await evidenceCounts(recoveryCommand.commandId)).attempts).toBe(1);
      } finally {
        for (const client of clients) await client.end();
        // Unique roles were created solely for this unique disposable database.
        // Restore its ownership before dropping the roles; no shared role is touched.
        for (const name of created) {
          await db.query(`REASSIGN OWNED BY ${quote(name)} TO hx_ci_runner`);
          await db.query(`DROP OWNED BY ${quote(name)}`);
          await db.query(`DROP ROLE ${quote(name)}`);
        }
      }
    }, 60_000);
  });
});
