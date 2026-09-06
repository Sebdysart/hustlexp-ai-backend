import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import type { QueryFn } from '../../src/db.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { engineMigrationArtifactDigest } from '../../src/jobs/engine-migration-manifest.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';
import {
  runNonproductionFinancialMigration,
  type NonproductionFinancialMigrationRuntime,
} from '../../src/jobs/nonproduction-financial-migration.js';
import {
  releaseManifestDigest,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest.js';
import { readNonproductionFinancialBootstrapReadiness } from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const describePg = describe.skipIf(configuredDatabaseUrl.length === 0).sequential;
const authorityDatabase = `hx_ci_stage1_containment_${createHash('sha256')
  .update(`recovery-upgrade:${process.pid}`)
  .digest('hex')
  .slice(0, 20)}`;
const ownerRole = `hx_ci_authority_owner_${process.pid}`;
const runtimeRole = `hx_ci_authority_runtime_${process.pid}`;
const elevatedRole = `hx_ci_authority_elevated_${process.pid}`;
const runtimePassword = `hx-ci-runtime-${process.pid}-synthetic-only`;
const sourceOperationId = 'a9100000-0000-4000-8000-000000000001';
const sourceEventId = 'a9200000-0000-4000-8000-000000000001';
const compensationEventId = 'a9300000-0000-4000-8000-000000000001';
let actualRunnerRuntime: NonproductionFinancialMigrationRuntime;
const revision = '1'.repeat(40);

const criticalRelations = [
  'applied_migrations',
  'escrows',
  'hxos_fake_financial_schema_evidence_v1',
  'hxos_fake_financial_schema_evidence_v2',
  'hxos_fake_financial_schema_evidence_v3',
  'hxos_fake_financial_schema_evidence_v4',
  'hxos_fake_financial_schema_evidence_v5',
  'hxos_fake_financial_schema_evidence_v6',
  'hxos_fake_financial_schema_evidence_v7',
  'hxos_fake_financial_schema_evidence_v8',
  'hxos_fake_financial_schema_evidence_v9',
  'hxos_fake_financial_schema_evidence_v10',
  'hxos_fake_financial_schema_evidence_v11',
  'hxos_fake_financial_schema_evidence_v12',
  'hxos_work_order_bootstrap_seal_evidence_v1',
  'hxos_universal_v1_work_order_target_activation_barrier_v1',
  'hxos_nonproduction_bootstrap_completion_v1',
  'hxos_fake_financial_operations_v1',
  'hxos_fake_financial_operation_events_v1',
  'hxos_fake_financial_legacy_expiry_dispositions_v9',
  'hxos_fake_financial_legacy_expiry_compensation_commands_v9',
  'hxos_fake_financial_legacy_expiry_compensation_attempts_v9',
  'hxos_fake_financial_legacy_expiry_compensation_outcomes_v9',
  'hxos_fake_financial_legacy_expiry_compensations_v9',
  'hxos_fake_financial_legacy_expiry_noncompensable_facts_v10',
  'provider_event_inbox_observations',
  'provider_event_inbox_receipts',
  'financial_provider_command_journal',
  'universal_v1_prepared_financial_commands',
  'provider_event_processing_state',
  'provider_event_processing_attempts',
  'provider_event_processing_outcomes',
  'provider_financial_observation_normalizations',
  'provider_financial_observation_backlog_v1',
  'financial_provider_command_recovery_leases',
  'financial_provider_command_dispatch_attempts',
  'financial_provider_command_outcome_facts',
  'universal_v1_fake_financial_lifecycle_bridges',
  'universal_v1_fake_terminal_plan_steps_v1',
  'universal_v1_fake_terminal_lifecycle_intents',
  'universal_v1_fake_provider_account_facts',
  'universal_v1_fake_reconciliation_bridges',
  'universal_v1_change_order_materialization_commands',
  'universal_v1_change_order_recovery_leases',
  'universal_v1_change_order_compensation_commands',
  'universal_v1_change_order_recovery_terminal_facts',
  'task_financial_security_events',
  'task_reconciliation_facts',
  'task_work_orders',
  'task_work_order_amendments',
  'task_location_access_log',
] as const;

const runtimeInsertRelations = [
  'hxos_fake_financial_operations_v1',
  'hxos_fake_financial_operation_events_v1',
  'provider_event_inbox_observations',
  'provider_event_inbox_receipts',
  'provider_event_processing_state',
  'provider_event_processing_attempts',
  'provider_event_processing_outcomes',
  'financial_provider_command_recovery_leases',
  'financial_provider_command_outcome_facts',
] as const;

const runtimeFunctions = [
  'public.hxos_read_universal_v1_work_order_runtime_authority_v1()',
  'public.hxos_prepare_legacy_expiry_compensation_v10(uuid,text)',
  'public.hxos_record_legacy_expiry_compensation_attempt_v10(uuid)',
  'public.hxos_finalize_legacy_expiry_compensation_v10(uuid,uuid,uuid,uuid)',
  'public.hxos_record_financial_provider_command_v1(uuid,text,uuid,text,text,bigint,text,text,uuid,text,uuid,uuid,uuid,uuid,bigint,text,uuid,text,text,text,text,text,text)',
  'public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)',
  'public.hxos_record_financial_provider_dispatch_attempt_v1(uuid,uuid,uuid,integer)',
  'public.hxos_record_change_order_materialization_command_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid,integer,integer,text,timestamp with time zone)',
  'public.hxos_record_fake_financial_security_event_v1(uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid)',
  'public.hxos_record_fake_terminal_lifecycle_intent_v1(uuid,text,uuid,uuid,uuid,uuid,bigint,integer,text,text,uuid)',
  'public.hxos_record_fake_provider_account_fact_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
  'public.hxos_record_fake_reconciliation_fact_v1(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid,uuid,text)',
] as const;

const securityDefinerDependencies = [
  'public.digest(text, text)',
  'public.digest(bytea, text)',
] as const;

const criticalFunctionNames = [
  'hxos_reject_fake_financial_mutation_v1',
  'reject_provider_event_inbox_mutation',
  'reject_financial_provider_command_mutation',
  'enforce_universal_v1_financial_command_preparation',
  'reject_universal_v1_prepared_financial_command_mutation',
  'enforce_financial_provider_command_prepared_authority',
  'initialize_provider_event_processing_state',
  'validate_provider_event_processing_state_transition',
  'validate_provider_event_processing_attempt',
  'validate_provider_event_processing_outcome',
  'reject_provider_event_processing_evidence_mutation',
  'reject_provider_event_processing_state_removal',
  'assert_financial_provider_command_recovery_lease',
  'assert_financial_provider_command_dispatch_attempt',
  'assert_financial_provider_command_outcome_fact',
  'reject_financial_provider_command_recovery_mutation',
  'validate_financial_provider_observation_v1',
  'reject_financial_provider_observation_mutation_v1',
  'normalize_financial_provider_observation_v1',
  'enforce_legacy_escrow_insert_containment_v1',
  'validate_universal_v1_fake_financial_lifecycle_bridge',
  'reject_universal_v1_fake_financial_lifecycle_bridge_mutation',
  'require_universal_v1_controlled_fake_lifecycle_bridge',
  'universal_v1_fake_terminal_plan_v1',
  'validate_universal_v1_fake_terminal_lifecycle_intent',
  'validate_universal_v1_fake_provider_account_fact',
  'universal_v1_reconciliation_snapshot_sha256_v1',
  'validate_universal_v1_fake_reconciliation_bridge',
  'require_universal_v1_fake_reconciliation_bridge',
  'require_universal_v1_double_entry_ledger_v1',
  'reject_universal_v1_fake_terminal_authority_mutation',
  'universal_v1_change_order_materialization_request_sha256',
  'enforce_universal_v1_change_order_materialization_command',
  'enforce_universal_v1_prepared_adjustment_witness',
  'prevent_universal_v1_change_order_materialization_mutation',
  'universal_v1_change_order_recovery_uuid_v1',
  'reject_universal_v1_change_order_recovery_mutation',
  'validate_universal_v1_change_order_recovery_lease',
  'universal_v1_change_order_recovery_lease_is_active_v1',
  'universal_v1_change_order_recovery_revocation_reason_v1',
  'validate_universal_v1_change_order_compensation_command',
  'lock_universal_v1_change_order_financial_slot_v1',
  'reject_change_order_witness_after_financial_slot_v1',
  'validate_universal_v1_change_order_compensating_reversal',
  'prevent_change_order_adjust_after_terminal_recovery',
  'reject_amendment_after_change_order_compensation',
  'validate_universal_v1_change_order_recovery_terminal_fact',
  'claim_universal_v1_change_order_recovery_v1',
  'claim_universal_v1_change_order_compensation_v1',
  'record_universal_v1_change_order_materialized_recovery_v1',
  'record_universal_v1_change_order_compensated_recovery_v1',
  'record_universal_v1_change_order_no_effect_recovery_v1',
  'universal_v1_change_order_recovery_resolution_v1',
  'enforce_universal_v1_dispute_release_gate_v1',
  'universal_v1_financial_security_is_current_v1',
  'universal_v1_effective_financial_security_expiry_v1',
  'enforce_universal_v1_work_order_financial_expiry_v1',
  'enforce_universal_v1_amendment_financial_expiry_v1',
  'enforce_universal_v1_prepared_positive_expiry_v1',
  'enforce_universal_v1_dispatch_positive_expiry_v1',
  'enforce_universal_v1_location_access_expiry_v1',
  'validate_fake_financial_legacy_expiry_disposition_v9',
  'legacy_fake_expiry_compensation_operation_id_v9',
  'prepare_fake_financial_legacy_expiry_compensation_v9',
  'prepare_fake_financial_legacy_expiry_attempt_v9',
  'validate_fake_financial_legacy_expiry_outcome_v9',
  'validate_fake_financial_legacy_expiry_compensation_v9',
  'require_legacy_expiry_compensation_before_terminal_outcome_v9',
  'enforce_universal_v1_fake_expiry_bridge_v9',
  'enforce_universal_v1_change_order_predecessor_expiry_v9',
  'enforce_universal_v1_terminal_intent_expiry_v9',
  'validate_fake_financial_legacy_expiry_noncompensable_v10',
  'hxos_prepare_legacy_expiry_compensation_v10',
  'hxos_record_legacy_expiry_compensation_attempt_v10',
  'hxos_finalize_legacy_expiry_compensation_v10',
  'require_legacy_expiry_terminal_before_outcome_v10',
  'hxos_record_financial_provider_command_v1',
  'hxos_prepare_universal_v1_financial_command_v1',
  'hxos_record_financial_provider_dispatch_attempt_v1',
  'hxos_record_change_order_materialization_command_v1',
  'hxos_record_fake_financial_lifecycle_bridge_v1',
  'hxos_record_fake_financial_security_event_v1',
  'hxos_record_fake_terminal_lifecycle_intent_v1',
  'hxos_record_fake_provider_account_fact_v1',
  'hxos_record_fake_reconciliation_bridge_v1',
  'hxos_record_fake_reconciliation_fact_v1',
] as const;

interface SchemaIdentityRow extends Record<string, unknown> {
  identity_name: string;
  identity_sha256: string;
}

interface FunctionIdentityRow extends Record<string, unknown> {
  function_name: string;
  function_identity: string;
}

interface RelationIdentityRow extends Record<string, unknown> {
  relation_name: string;
  relation_kind: string;
}

interface WrapperPreparationRow extends Record<string, unknown> {
  command_id: string;
  compensation_operation_id: string;
  compensation_operation_kind: string;
  compensation_idempotency_key: string;
  provider_request_sha256: string;
  idempotency_replayed: boolean;
}

interface WrapperAttemptRow extends Record<string, unknown> {
  dispatch_attempt_id: string;
  command_id: string;
  idempotency_replayed: boolean;
}

interface WrapperFinalizationRow extends Record<string, unknown> {
  source_fake_operation_event_id: string;
  compensation_fake_operation_event_id: string;
  compensation_operation_id: string;
  compensation_operation_kind: string;
  compensation_provider_state: string;
  idempotency_replayed: boolean;
}

let adminClient: pg.Client | null = null;
let ownerDatabaseClient: pg.Client | null = null;
let runtimeClient: pg.Client | null = null;
let runtimeDatabaseUrl = '';
let authority: Awaited<ReturnType<typeof localAuthority>>;
let authorityQueryExecutions = 0;

function artifactDigest(value: string): string {
  return `sha256:${value.repeat(64)}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafeIdentifier(value: string): string {
  if (!/^hx_ci_[a-z0-9_]+$/u.test(value) || value.length > 63) {
    throw new Error(`Unsafe disposable PostgreSQL identifier: ${value}`);
  }
  return value;
}

function quotedIdentifier(value: string): string {
  return `"${assertSafeIdentifier(value)}"`;
}

function qualifiedRelations(relations: readonly string[]): string {
  return relations.map((relation) => `public."${relation}"`).join(', ');
}

function exactAdminUrl(): string {
  const parsed = new URL(configuredDatabaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    !/^\/hx_ci_(?:admin|invariant|system)_test$/u.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Runtime authority proof requires the exact loopback-only hx_ci_* PG16 runner');
  }
  parsed.pathname = '/hx_ci_admin_test';
  return parsed.toString();
}

function databaseUrl(databaseName: string, username?: string, password?: string): string {
  const parsed = new URL(exactAdminUrl());
  parsed.pathname = `/${assertSafeIdentifier(databaseName)}`;
  if (username !== undefined) parsed.username = assertSafeIdentifier(username);
  if (password !== undefined) parsed.password = password;
  return parsed.toString();
}

async function localAuthority(): Promise<{
  identity: BuildIdentity;
  manifest: ReleaseManifestV2;
  release: ReleaseManifestEvidence;
}> {
  const migrationArtifactDigest = `sha256:${await engineMigrationArtifactDigest()}`;
  const manifest: ReleaseManifestV2 = {
    version: 2,
    environment: 'local',
    releaseId: `local-runtime-authority-pg-${randomUUID()}`,
    createdAt: '2026-08-31T20:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: artifactDigest('f'),
    },
    components: {
      backend: {
        revision,
        artifactDigest: artifactDigest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('2'),
      },
      worker: {
        revision,
        artifactDigest: artifactDigest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('4'),
      },
      web: {
        revision: '2'.repeat(40),
        artifactDigest: artifactDigest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('6'),
      },
      migration: { revision, artifactDigest: migrationArtifactDigest },
      policy: { revision: '3'.repeat(40), artifactDigest: artifactDigest('8') },
      fixtures: {
        revision: '4'.repeat(40),
        artifactDigest: artifactDigest('9'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: artifactDigest('a'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: artifactDigest('b'),
      },
    },
    infrastructure: {
      revision: '5'.repeat(40),
      artifactDigest: artifactDigest('c'),
      desiredTopologyDigest: artifactDigest('d'),
    },
    databaseTargets: {
      api: { component: 'api', environment: 'local', databaseTargetDigest: artifactDigest('e') },
      worker: {
        component: 'worker',
        environment: 'local',
        databaseTargetDigest: artifactDigest('f'),
      },
      attester: {
        component: 'attester',
        environment: 'local',
        databaseTargetDigest: artifactDigest('1'),
      },
    },
    capabilities: {
      financialProvider: 'fake',
      fakeFinancialEvents: true,
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication: 'sink',
      dataClass: 'synthetic',
    },
    promotion: {
      baseManifestDigest: null,
      changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
      infrastructureChanged: true,
    },
    acceptance: {
      backend: { kind: 'http', component: 'backend', path: '/health' },
      worker: { kind: 'http', component: 'worker', path: '/health' },
      web: { kind: 'http', component: 'web', path: '/version.json' },
      migration: { kind: 'receipt', component: 'migration', receiptType: 'migration-execution-v1' },
      policy: { kind: 'receipt', component: 'policy', receiptType: 'canonical-policy-digest-v1' },
      fixtures: { kind: 'receipt', component: 'fixtures', receiptType: 'fixture-seed-v1' },
      infrastructure: {
        kind: 'readback',
        binding: 'infrastructure',
        receiptType: 'infrastructure-readback-v1',
      },
    },
  };
  const identity: BuildIdentity = {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision,
    built_at: '2026-08-31T20:00:00.000Z',
    environment: 'development',
    clean_source: false,
    source: 'git',
    artifact_digest: artifactDigest('1'),
    artifact_verified: false,
  };
  return {
    identity,
    manifest,
    release: {
      schema_version: 1,
      status: 'valid',
      digest: releaseManifestDigest(manifest),
      source: 'runtime-authority-pg-test',
      errors: [],
      manifest,
      authentication: {
        status: 'missing',
        algorithm: null,
        keyId: null,
        keyFingerprint: null,
        signatureDigest: null,
        source: 'none',
        errors: [],
      },
    },
  };
}

async function cleanupDisposableAuthorityDatabase(): Promise<void> {
  const cleanup = adminClient ?? new pg.Client({ connectionString: exactAdminUrl() });
  const ownsCleanup = adminClient === null;
  if (ownsCleanup) await cleanup.connect();
  try {
    await cleanup.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
         FROM pg_catalog.pg_stat_activity
        WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [authorityDatabase]
    );
    await cleanup.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(authorityDatabase)}`);
    await cleanup.query(`DROP ROLE IF EXISTS ${quotedIdentifier(runtimeRole)}`);
    await cleanup.query(`DROP ROLE IF EXISTS ${quotedIdentifier(elevatedRole)}`);
    await cleanup.query(`DROP ROLE IF EXISTS ${quotedIdentifier(ownerRole)}`);
  } finally {
    if (ownsCleanup) await cleanup.end();
  }
}

async function applySqlMigration(
  client: pg.Client,
  registration: { name: string; fileName: string },
  evidenceTable?: string
): Promise<void> {
  const sql = await readFile(
    new URL(`../../database/migrations/${registration.fileName}`, import.meta.url)
  );
  const digest = sha256(sql);
  await client.query('BEGIN');
  try {
    await client.query(sql.toString('utf8'));
    if (evidenceTable) {
      await client.query(
        `INSERT INTO public."${evidenceTable}"(migration_name, migration_sql_sha256)
         VALUES ($1, $2)`,
        [registration.name, digest]
      );
    }
    await client.query(`INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`, [
      registration.name,
      digest,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seedHistoricalValuedSecurity(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO public.hxos_fake_financial_operations_v1(
       operation_id, operation_kind, identity_sha256, external_reference,
       amount_cents, currency, created_at
     ) VALUES ($1, 'AUTHORIZE', $2, $3, 2400, 'usd', $4)`,
    [
      sourceOperationId,
      'a'.repeat(64),
      'fake_authorize_aaaaaaaaaaaaaaaaaaaaaaaa',
      '2020-01-01T00:00:00.000Z',
    ]
  );
  await client.query(
    `INSERT INTO public.hxos_fake_financial_operation_events_v1(
       event_id, operation_id, operation_kind, event_version, state, scenario,
       amount_cents, currency, external_reference, idempotency_key,
       identity_sha256, request_sha256, provider_request_sha256,
       response_sha256, retryable, metadata, recorded_at
     ) VALUES (
       $1, $2, 'AUTHORIZE', 1, 'SUCCEEDED', 'SUCCESS', 2400, 'usd', $3, $4,
       $5, $6, $6, $7, FALSE, '{}'::jsonb, $8
     )`,
    [
      sourceEventId,
      sourceOperationId,
      'fake_authorize_aaaaaaaaaaaaaaaaaaaaaaaa',
      'runtime-authority-source-0001',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      '2020-01-01T00:00:00.001Z',
    ]
  );
}

async function explicitlyReassignCriticalObjects(client: pg.Client): Promise<void> {
  const relations = await client.query<RelationIdentityRow>(
    `SELECT relation.relname AS relation_name, relation.relkind::text AS relation_kind
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname`,
    [criticalRelations]
  );
  expect(relations.rows.map(({ relation_name }) => relation_name)).toEqual(
    [...criticalRelations].sort()
  );
  for (const relation of relations.rows) {
    const command =
      relation.relation_kind === 'v'
        ? 'ALTER VIEW'
        : relation.relation_kind === 'm'
          ? 'ALTER MATERIALIZED VIEW'
          : 'ALTER TABLE';
    await client.query(
      `${command} public."${relation.relation_name}" OWNER TO ${quotedIdentifier(ownerRole)}`
    );
  }

  const functions = await client.query<FunctionIdentityRow>(
    `SELECT procedure.proname AS function_name,
            pg_catalog.format(
              '%I.%I(%s)', namespace.nspname, procedure.proname,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid)
            ) AS function_identity
       FROM pg_catalog.pg_proc procedure
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND (
          NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend extension_dependency
             WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::regclass
               AND extension_dependency.objid = procedure.oid
               AND extension_dependency.refclassid = 'pg_catalog.pg_extension'::regclass
               AND extension_dependency.deptype = 'e'
          )
          OR procedure.oid IN (
            SELECT pg_catalog.to_regprocedure(signature)::oid
              FROM pg_catalog.unnest($1::text[]) signature
          )
        )
      ORDER BY procedure.proname, procedure.oid`,
    [securityDefinerDependencies]
  );
  const observedFunctionNames = new Set(functions.rows.map(({ function_name }) => function_name));
  for (const functionName of criticalFunctionNames)
    expect(observedFunctionNames).toContain(functionName);
  for (const routine of functions.rows) {
    await client.query(
      `ALTER ROUTINE ${routine.function_identity} OWNER TO ${quotedIdentifier(ownerRole)}`
    );
  }
  await client.query(
    `ALTER FUNCTION hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()
       OWNER TO ${quotedIdentifier(ownerRole)}`
  );
}

async function installExactRuntimeAcl(client: pg.Client): Promise<void> {
  const allCriticalRelations = qualifiedRelations(criticalRelations);
  await client.query(
    `ALTER DATABASE ${quotedIdentifier(authorityDatabase)} OWNER TO ${quotedIdentifier(ownerRole)}`
  );
  await client.query(`ALTER SCHEMA public OWNER TO ${quotedIdentifier(ownerRole)}`);
  await client.query(`REVOKE ALL ON DATABASE ${quotedIdentifier(authorityDatabase)} FROM PUBLIC`);
  await client.query(
    `GRANT CONNECT ON DATABASE ${quotedIdentifier(authorityDatabase)} TO ${quotedIdentifier(runtimeRole)}`
  );
  await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quotedIdentifier(runtimeRole)}`);
  await client.query(`GRANT USAGE ON SCHEMA hx_authority TO ${quotedIdentifier(runtimeRole)}`);
  await client.query(`REVOKE ALL ON TABLE ${allCriticalRelations} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${allCriticalRelations} FROM hx_ci_runner`);
  await client.query(
    `REVOKE ALL ON TABLE ${allCriticalRelations} FROM ${quotedIdentifier(runtimeRole)}`
  );
  await client.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC');
  await client.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM hx_ci_runner');
  await client.query(
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${quotedIdentifier(runtimeRole)}`
  );
  await client.query(
    `REVOKE ALL ON FUNCTION
       hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()
       FROM PUBLIC, hx_ci_runner, ${quotedIdentifier(runtimeRole)}`
  );
  // pgcrypto is a trusted extension, but its C-language member functions stay
  // owned by the bootstrap superuser even when the extension itself is owned
  // by the NOLOGIN authority role. The definer role needs these exact overloads
  // for sealed commands, and runtime needs the same immutable overloads because
  // permitted CHECK/generated expressions execute with invoker privileges.
  await client.query(
    `GRANT EXECUTE ON FUNCTION public.digest(text, text), public.digest(bytea, text)
       TO ${quotedIdentifier(ownerRole)}, ${quotedIdentifier(runtimeRole)}`
  );
  await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC');
  await client.query(
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${quotedIdentifier(runtimeRole)}`
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedIdentifier(ownerRole)}
       REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedIdentifier(ownerRole)} IN SCHEMA public
       REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
  );
  await client.query(
    `GRANT SELECT ON TABLE ${allCriticalRelations} TO ${quotedIdentifier(runtimeRole)}`
  );
  await client.query(
    `GRANT INSERT ON TABLE ${qualifiedRelations(runtimeInsertRelations)}
       TO ${quotedIdentifier(runtimeRole)}`
  );
  await client.query(
    `GRANT UPDATE ON TABLE public.provider_event_processing_state
       TO ${quotedIdentifier(runtimeRole)}`
  );
  for (const signature of runtimeFunctions) {
    await client.query(
      `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(runtimeRole)}`
    );
  }
}

function runtimeReadinessDatabase(
  client: pg.Client,
  capture?: (rows: SchemaIdentityRow[]) => void
) {
  return {
    readOnlyAttestationTransaction: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SET LOCAL search_path=pg_catalog');
      await client.query("SET LOCAL statement_timeout='1000ms'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      const query: QueryFn = async <R = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => {
        const result = await client.query(sql, params);
        if (sql.includes('violations(violation_code)')) authorityQueryExecutions += 1;
        if (capture && sql.includes('identity_documents')) {
          capture(result.rows as SchemaIdentityRow[]);
        }
        return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
      };
      try {
        const value = await fn(query);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
}

function readinessOptions(database = runtimeReadinessDatabase(runtimeClient!)) {
  return {
    environment: 'local',
    component: 'backend' as const,
    env: {
      HX_ENVIRONMENT: 'local',
      NODE_ENV: 'development',
      HX_PAYMENT_CREATION_MODE: 'frozen',
    },
    release: authority.release,
    identity: authority.identity,
    database,
  };
}

describePg('historical financial recovery and exact current migration upgrade', () => {
  beforeAll(async () => {
    assertSafeIdentifier(authorityDatabase);
    assertSafeIdentifier(ownerRole);
    assertSafeIdentifier(runtimeRole);
    assertSafeIdentifier(elevatedRole);
    adminClient = new pg.Client({ connectionString: exactAdminUrl() });
    await adminClient.connect();
    await cleanupDisposableAuthorityDatabase();

    const version = await adminClient.query<{ server_version_num: string }>(
      `SELECT pg_catalog.current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(170_000);

    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(ownerRole)} NOLOGIN NOSUPERUSER NOCREATEDB
         NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(runtimeRole)} LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(elevatedRole)} NOLOGIN NOSUPERUSER CREATEDB
         NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE DATABASE ${quotedIdentifier(authorityDatabase)}
         OWNER ${quotedIdentifier(ownerRole)} TEMPLATE template0
         ENCODING 'UTF8' LOCALE_PROVIDER libc
         LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'`
    );

    ownerDatabaseClient = new pg.Client({ connectionString: databaseUrl(authorityDatabase) });
    await ownerDatabaseClient.connect();
    await ownerDatabaseClient.query(`ALTER SCHEMA public OWNER TO ${quotedIdentifier(ownerRole)}`);
    await ownerDatabaseClient.query(`SET ROLE ${quotedIdentifier(ownerRole)}`);
    const baseline = await readFile(
      new URL('../../database/constitutional-schema.sql', import.meta.url),
      'utf8'
    );
    await ownerDatabaseClient.query(baseline);
    await ownerDatabaseClient.query(
      `CREATE TABLE public.applied_migrations (
         name TEXT PRIMARY KEY,
         sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
       )`
    );
    await ownerDatabaseClient.query('RESET ROLE');
    for (const registration of REQUIRED_MIGRATION_FILES) {
      await applySqlMigration(ownerDatabaseClient, registration);
    }
    for (const registration of CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.slice(0, 8)) {
      await applySqlMigration(ownerDatabaseClient, registration, registration.evidenceTable);
    }
    await seedHistoricalValuedSecurity(ownerDatabaseClient);
    authority = await localAuthority();
    actualRunnerRuntime = {
      env: {
        NODE_ENV: 'test',
        SERVICE_ROLE: 'migration',
        HX_ENVIRONMENT: 'local',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HXOS_LOCAL_TEST_DATABASE_NAME: authorityDatabase,
        HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
        HX_ALLOW_TASK_DRAFT_INGRESS_PG: '1',
        HX_ALLOW_CI_DB_RECREATE: 'true',
      },
      release: authority.release,
      identity: authority.identity,
      databaseUrl: databaseUrl(authorityDatabase),
      migrationSpecs: CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name, fileName }) => ({
        name,
        candidatePaths: [resolve('backend/database/migrations', fileName)],
      })),
      migrationArtifactDigest: engineMigrationArtifactDigest,
      readText: (filePath) => readFile(filePath, 'utf8'),
      createClient: (connectionString) => {
        const client = new pg.Client({ connectionString });
        return {
          connect: async () => {
            await client.connect();
          },
          end: () => client.end(),
          query: (sql, values) => client.query(sql, values),
        };
      },
    };
    // Build the last historical stage using the exact registered SQL bytes.
    for (const registration of CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.slice(8, -1)) {
      await applySqlMigration(ownerDatabaseClient, registration, registration.evidenceTable);
    }
    await ownerDatabaseClient.query(
      `INSERT INTO public.hxos_nonproduction_bootstrap_completion_v1(
         release_manifest_digest, migration_artifact_digest, release_id,
         release_environment, required_migration_count, financial_migration_status
       ) VALUES ($1, $2, $3, 'local', $4, 'applied')`,
      [
        releaseManifestDigest(authority.manifest),
        authority.manifest.components.migration.artifactDigest,
        authority.manifest.releaseId,
        REQUIRED_MIGRATION_FILES.length,
      ]
    );
    await explicitlyReassignCriticalObjects(ownerDatabaseClient);
    await installExactRuntimeAcl(ownerDatabaseClient);

    runtimeDatabaseUrl = databaseUrl(authorityDatabase, runtimeRole, runtimePassword);
    runtimeClient = new pg.Client({ connectionString: runtimeDatabaseUrl });
    await runtimeClient.connect();
  }, 180_000);

  afterAll(async () => {
    try {
      await runtimeClient?.end();
    } finally {
      runtimeClient = null;
      try {
        await ownerDatabaseClient?.end();
      } finally {
        ownerDatabaseClient = null;
        if (adminClient) {
          try {
            await cleanupDisposableAuthorityDatabase();
          } finally {
            await adminClient.end();
            adminClient = null;
          }
        }
      }
    }
  }, 60_000);

  it('preserves historical compensation replay, then verifies the exact full current migration chain', async () => {
    const expressionDependencies = await runtimeClient!.query<{
      text_digest: string;
      bytea_digest: string;
    }>(
      `SELECT pg_catalog.encode(public.digest('runtime-text', 'sha256'), 'hex') AS text_digest,
              pg_catalog.encode(
                public.digest(pg_catalog.convert_to('runtime-bytea', 'UTF8'), 'sha256'),
                'hex'
              ) AS bytea_digest`
    );
    expect(expressionDependencies.rows[0]).toEqual({
      text_digest: sha256('runtime-text'),
      bytea_digest: sha256('runtime-bytea'),
    });
    const compensationOperation = await ownerDatabaseClient!.query<{ operation_id: string }>(
      `SELECT public.legacy_fake_expiry_compensation_operation_id_v9($1) AS operation_id`,
      [sourceEventId]
    );
    const compensationOperationId = compensationOperation.rows[0]!.operation_id;
    const compensationIdempotencyKey = `legacy-expiry-compensation:v9:${sourceEventId}`;
    const providerRequestSha256 = sha256(
      JSON.stringify({
        amountCents: 2400,
        currency: 'usd',
        expectedVersion: 0,
        idempotencyKey: compensationIdempotencyKey,
        operationId: compensationOperationId,
        relatedOperationId: sourceOperationId,
      })
    );

    const prepare = () =>
      runtimeClient!.query<WrapperPreparationRow>(
        `SELECT * FROM public.hxos_prepare_legacy_expiry_compensation_v10($1, $2)`,
        [sourceEventId, providerRequestSha256]
      );
    const firstPreparation = (await prepare()).rows[0]!;
    const replayedPreparation = (await prepare()).rows[0]!;
    expect(firstPreparation).toMatchObject({
      compensation_operation_id: compensationOperationId,
      compensation_operation_kind: 'VOID',
      compensation_idempotency_key: compensationIdempotencyKey,
      provider_request_sha256: providerRequestSha256,
      idempotency_replayed: false,
    });
    expect(replayedPreparation).toEqual({
      ...firstPreparation,
      idempotency_replayed: true,
    });

    const attempt = () =>
      runtimeClient!.query<WrapperAttemptRow>(
        `SELECT * FROM public.hxos_record_legacy_expiry_compensation_attempt_v10($1)`,
        [firstPreparation.command_id]
      );
    const firstAttempt = (await attempt()).rows[0]!;
    const replayedAttempt = (await attempt()).rows[0]!;
    expect(firstAttempt).toMatchObject({
      command_id: firstPreparation.command_id,
      idempotency_replayed: false,
    });
    expect(replayedAttempt).toEqual({ ...firstAttempt, idempotency_replayed: true });

    await ownerDatabaseClient!.query(`SET ROLE ${quotedIdentifier(ownerRole)}`);
    try {
      await ownerDatabaseClient!.query(
        `INSERT INTO public.hxos_fake_financial_operations_v1(
           operation_id, operation_kind, identity_sha256, external_reference,
           amount_cents, currency, related_operation_id
         ) VALUES ($1, 'VOID', $2, $3, 2400, 'usd', $4)`,
        [
          compensationOperationId,
          'd'.repeat(64),
          'fake_void_dddddddddddddddddddddddd',
          sourceOperationId,
        ]
      );
      await ownerDatabaseClient!.query(
        `INSERT INTO public.hxos_fake_financial_operation_events_v1(
           event_id, operation_id, operation_kind, event_version, state, scenario,
           amount_cents, currency, related_operation_id, external_reference,
           idempotency_key, identity_sha256, request_sha256,
           provider_request_sha256, response_sha256, retryable, metadata, expires_at
         ) VALUES (
           $1, $2, 'VOID', 1, 'VOIDED', 'SUCCESS', 2400, 'usd', $3, $4, $5,
           $6, $7, $7, $8, FALSE, '{}'::jsonb, NULL
         )`,
        [
          compensationEventId,
          compensationOperationId,
          sourceOperationId,
          'fake_void_dddddddddddddddddddddddd',
          compensationIdempotencyKey,
          'd'.repeat(64),
          providerRequestSha256,
          'e'.repeat(64),
        ]
      );
    } finally {
      await ownerDatabaseClient!.query('RESET ROLE');
    }

    const finalize = () =>
      runtimeClient!.query<WrapperFinalizationRow>(
        `SELECT * FROM public.hxos_finalize_legacy_expiry_compensation_v10($1, $2, $3, $4)`,
        [
          sourceEventId,
          compensationEventId,
          firstPreparation.command_id,
          firstAttempt.dispatch_attempt_id,
        ]
      );
    const firstFinalization = (await finalize()).rows[0]!;
    const replayedFinalization = (await finalize()).rows[0]!;
    expect(firstFinalization).toMatchObject({
      source_fake_operation_event_id: sourceEventId,
      compensation_fake_operation_event_id: compensationEventId,
      compensation_operation_id: compensationOperationId,
      compensation_operation_kind: 'VOID',
      compensation_provider_state: 'VOIDED',
      idempotency_replayed: false,
    });
    expect(replayedFinalization).toEqual({
      ...firstFinalization,
      idempotency_replayed: true,
    });
    const runnerResult = await runNonproductionFinancialMigration(actualRunnerRuntime);
    expect(runnerResult.migrations).toHaveLength(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.length);
    expect(
      runnerResult.migrations.slice(0, -1).every(({ status }) => status === 'already_applied')
    ).toBe(true);
    expect(runnerResult.migrations.at(-1)).toMatchObject({
      migration: '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      status: 'applied',
    });
    // The historical two-role installation cannot attest current runtime authority.
    const readiness = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
    expect(readiness).toMatchObject({
      required: true,
      ready: false,
      status: 'attestation_unavailable',
    });
  });
});
