import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BuildIdentity } from '../../buildIdentity.js';
import type { QueryFn } from '../../db.js';
import {
  releaseManifestDigest,
  type ReleaseManifestEvidence,
} from '../../releaseManifest.js';
import { REQUIRED_MIGRATION_FILES } from '../../jobs/engine-automation-migration-files.js';
import { NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES } from '../../jobs/nonproduction-financial-migration.js';
import {
  assertNonproductionFakeFinanceAuthorized,
  type NonproductionFinancialComponent,
  type NonproductionFinancialEnvironment,
} from './NonproductionFinancialAuthorization.js';

export type NonproductionFinancialBootstrapReadinessStatus =
  | 'disabled'
  | 'ready'
  | 'unauthorized'
  | 'bootstrap_missing'
  | 'schema_evidence_mismatch'
  | 'database_authority_violation'
  | 'attestation_unavailable';

export interface NonproductionFinancialMigrationEvidence {
  migrationName: string;
  sha256: string;
}

export interface NonproductionFinancialBootstrapReadiness {
  schemaVersion: 1;
  required: boolean;
  ready: boolean;
  status: NonproductionFinancialBootstrapReadinessStatus;
  environment: NonproductionFinancialEnvironment | 'production' | 'unknown';
  releaseId: string | null;
  releaseManifestDigest: string | null;
  migrationArtifactDigest: string | null;
  requiredMigrationCount: number;
  fakeFinancialMigrationCount: number;
  matchedFakeFinancialMigrationCount: number;
  completedAt: string | null;
}

interface BootstrapCompletionRow extends Record<string, unknown> {
  release_id: string;
  release_environment: string;
  required_migration_count: number | string;
  financial_migration_status: string;
  completed_at: Date | string;
}

interface SchemaEvidenceRow extends Record<string, unknown> {
  migration_name: string;
  evidence_sha256: string;
  applied_sha256: string | null;
}

interface AppliedMigrationEvidenceRow extends Record<string, unknown> {
  migration_name: string;
  applied_sha256: string | null;
}

interface CriticalSchemaIdentityEvidence extends Record<string, unknown> {
  identityName: string;
  sha256: string;
}

interface CriticalSchemaIdentityRow extends Record<string, unknown> {
  identity_name: string;
  identity_sha256: string;
}

interface DatabaseAuthorityViolationRow extends Record<string, unknown> {
  violation_code: string;
}

export interface NonproductionFinancialReadinessDatabase {
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
}

interface ReadinessOptions {
  environment: string;
  component: NonproductionFinancialComponent;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  release: ReleaseManifestEvidence;
  identity: BuildIdentity;
  database: NonproductionFinancialReadinessDatabase;
  expectedFinancialEvidence?: readonly NonproductionFinancialMigrationEvidence[];
  expectedCriticalMigrationEvidence?: readonly NonproductionFinancialMigrationEvidence[];
  expectedCriticalSchemaEvidence?: readonly CriticalSchemaIdentityEvidence[];
}

const SHA256 = /^[0-9a-f]{64}$/u;
const CRITICAL_FINANCIAL_MIGRATIONS = Object.freeze([
  Object.freeze({
    migrationName: '20260916_provider_event_inbox_v1',
    fileName: '20260916_provider_event_inbox_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260917_financial_provider_command_journal_v1',
    fileName: '20260917_financial_provider_command_journal_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260918_universal_v1_prepared_financial_command_v1',
    fileName: '20260918_universal_v1_prepared_financial_command_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260919_provider_event_processing_v1',
    fileName: '20260919_provider_event_processing_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260920_financial_provider_command_recovery_v1',
    fileName: '20260920_financial_provider_command_recovery_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
    fileName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql',
  }),
] as const);
const CRITICAL_RELATION_NAMES = Object.freeze([
  'applied_migrations',
  'hxos_fake_financial_schema_evidence_v1',
  'hxos_fake_financial_schema_evidence_v2',
  'hxos_fake_financial_schema_evidence_v3',
  'hxos_fake_financial_schema_evidence_v4',
  'hxos_nonproduction_bootstrap_completion_v1',
  'hxos_fake_financial_operations_v1',
  'hxos_fake_financial_operation_events_v1',
  'provider_event_inbox_observations',
  'provider_event_inbox_receipts',
  'financial_provider_command_journal',
  'universal_v1_prepared_financial_commands',
  'provider_event_processing_state',
  'provider_event_processing_attempts',
  'provider_event_processing_outcomes',
  'financial_provider_command_recovery_leases',
  'financial_provider_command_dispatch_attempts',
  'financial_provider_command_outcome_facts',
  'universal_v1_fake_financial_lifecycle_bridges',
] as const);
const READ_ONLY_ATTESTATION_RELATION_NAMES = Object.freeze([
  'applied_migrations',
  'hxos_fake_financial_schema_evidence_v1',
  'hxos_fake_financial_schema_evidence_v2',
  'hxos_fake_financial_schema_evidence_v3',
  'hxos_fake_financial_schema_evidence_v4',
  'hxos_nonproduction_bootstrap_completion_v1',
] as const);
const CRITICAL_FUNCTION_NAMES = Object.freeze([
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
  'validate_universal_v1_fake_financial_lifecycle_bridge',
  'reject_universal_v1_fake_financial_lifecycle_bridge_mutation',
  'require_universal_v1_controlled_fake_lifecycle_bridge',
] as const);
const CRITICAL_SCHEMA_IDENTITY_NAMES = Object.freeze([
  'relations',
  'constraints',
  'indexes',
  'functions',
  'triggers',
  'constraint_triggers',
  'policies',
  'extensions',
] as const);

// These PostgreSQL 16 semantic catalog fingerprints must be regenerated from
// the exact, fresh 20260916..20260920 engine chain plus the nonproduction
// fake-finance v1..v4 chain whenever any critical SQL changes.
// An empty default intentionally keeps runtime attestation fail-closed until
// independently captured catalog evidence is reviewed and frozen here.
const CRITICAL_SCHEMA_EVIDENCE = Object.freeze(
  [] satisfies readonly CriticalSchemaIdentityEvidence[],
);

function sqlTextValues(values: readonly string[]): string {
  return values.map((value) => `('${value}'::text)`).join(',\n         ');
}

let defaultExpectedFinancialEvidence:
  | Promise<readonly NonproductionFinancialMigrationEvidence[]>
  | undefined;
let defaultExpectedCriticalMigrationEvidence:
  | Promise<readonly NonproductionFinancialMigrationEvidence[]>
  | undefined;

function normalizeEnvironment(
  environment: string,
): NonproductionFinancialEnvironment | 'production' | 'unknown' {
  const normalized = environment.trim().toLowerCase();
  if (normalized === 'development' || normalized === 'test' || normalized === 'local') {
    return 'local';
  }
  if (normalized === 'preview' || normalized === 'staging' || normalized === 'production') {
    return normalized;
  }
  return 'unknown';
}

function hasContradictoryProductionMetadata(
  environment: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const declaredEnvironment = normalizeEnvironment(environment);
  const hxEnvironment = env.HX_ENVIRONMENT
    ? normalizeEnvironment(env.HX_ENVIRONMENT)
    : null;
  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  if (
    hxEnvironment
    && hxEnvironment !== 'unknown'
    && declaredEnvironment !== 'unknown'
    && hxEnvironment !== declaredEnvironment
  ) {
    return true;
  }
  const deploymentEnvironment = hxEnvironment && hxEnvironment !== 'unknown'
    ? hxEnvironment
    : declaredEnvironment;
  if (deploymentEnvironment === 'preview' || deploymentEnvironment === 'staging') {
    return nodeEnvironment !== 'production';
  }
  return deploymentEnvironment === 'production'
    && Boolean(nodeEnvironment)
    && nodeEnvironment !== 'production';
}

function baseReadiness(
  environment: NonproductionFinancialBootstrapReadiness['environment'],
  status: NonproductionFinancialBootstrapReadinessStatus,
  overrides: Partial<NonproductionFinancialBootstrapReadiness> = {},
): NonproductionFinancialBootstrapReadiness {
  return {
    schemaVersion: 1,
    required: environment !== 'production',
    ready: status === 'disabled' || status === 'ready',
    status,
    environment,
    releaseId: null,
    releaseManifestDigest: null,
    migrationArtifactDigest: null,
    requiredMigrationCount: REQUIRED_MIGRATION_FILES.length,
    fakeFinancialMigrationCount: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.length,
    matchedFakeFinancialMigrationCount: 0,
    completedAt: null,
    ...overrides,
  };
}

export function unavailableNonproductionFinancialBootstrapReadiness(
  environment: string,
): NonproductionFinancialBootstrapReadiness {
  return baseReadiness(normalizeEnvironment(environment), 'attestation_unavailable', {
    required: true,
    ready: false,
  });
}

function expectedEvidencePath(fileName: string): string {
  return path.join(process.cwd(), 'backend/database/migrations', fileName);
}

async function loadExpectedFinancialEvidence(): Promise<
  readonly NonproductionFinancialMigrationEvidence[]
> {
  return Promise.all(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(async (migration) => {
    const contents = await readFile(expectedEvidencePath(migration.fileName));
    return {
      migrationName: migration.name,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  }));
}

function expectedFinancialEvidence(): Promise<
  readonly NonproductionFinancialMigrationEvidence[]
> {
  defaultExpectedFinancialEvidence ??= loadExpectedFinancialEvidence();
  return defaultExpectedFinancialEvidence;
}

async function loadExpectedCriticalMigrationEvidence(): Promise<
  readonly NonproductionFinancialMigrationEvidence[]
> {
  return Promise.all(CRITICAL_FINANCIAL_MIGRATIONS.map(async (migration) => {
    const registered = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.find(
      ({ name }) => name === migration.migrationName,
    ) ?? REQUIRED_MIGRATION_FILES.find(
      ({ name }) => name === migration.migrationName,
    );
    if (registered?.fileName !== migration.fileName) {
      throw new Error('critical financial migration registry identity is unavailable');
    }
    const contents = await readFile(expectedEvidencePath(migration.fileName));
    return {
      migrationName: migration.migrationName,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  }));
}

function expectedCriticalMigrationEvidence(): Promise<
  readonly NonproductionFinancialMigrationEvidence[]
> {
  defaultExpectedCriticalMigrationEvidence ??= loadExpectedCriticalMigrationEvidence();
  return defaultExpectedCriticalMigrationEvidence;
}

async function readSchemaEvidence(query: QueryFn): Promise<SchemaEvidenceRow[]> {
  const result = await query<SchemaEvidenceRow>(
    `WITH evidence AS (
       SELECT migration_name, btrim(migration_sql_sha256) AS evidence_sha256
       FROM public.hxos_fake_financial_schema_evidence_v1
       UNION ALL
       SELECT migration_name, btrim(migration_sql_sha256) AS evidence_sha256
       FROM public.hxos_fake_financial_schema_evidence_v2
       UNION ALL
       SELECT migration_name, btrim(migration_sql_sha256) AS evidence_sha256
       FROM public.hxos_fake_financial_schema_evidence_v3
       UNION ALL
       SELECT migration_name, btrim(migration_sql_sha256) AS evidence_sha256
       FROM public.hxos_fake_financial_schema_evidence_v4
     )
     SELECT evidence.migration_name,
            evidence.evidence_sha256,
            btrim(applied_migrations.sha256) AS applied_sha256
     FROM evidence
     LEFT JOIN public.applied_migrations
       ON applied_migrations.name = evidence.migration_name
     ORDER BY evidence.migration_name`,
  );
  return result.rows;
}

function matchingEvidenceCount(
  observed: readonly SchemaEvidenceRow[],
  expected: readonly NonproductionFinancialMigrationEvidence[],
): number {
  const actual = new Map(observed.map((row) => [row.migration_name, row]));
  return expected.filter(({ migrationName, sha256 }) => {
    const row = actual.get(migrationName);
    return SHA256.test(sha256)
      && row?.evidence_sha256 === sha256
      && row.applied_sha256 === sha256;
  }).length;
}

function validExpectedEvidence(
  observed: readonly NonproductionFinancialMigrationEvidence[],
  expectedNames: readonly string[],
): boolean {
  return observed.length === expectedNames.length
    && observed.every((entry, index) => (
      entry.migrationName === expectedNames[index]
      && SHA256.test(entry.sha256)
    ));
}

async function readAppliedCriticalMigrationEvidence(
  query: QueryFn,
): Promise<AppliedMigrationEvidenceRow[]> {
  const result = await query<AppliedMigrationEvidenceRow>(
    `SELECT name AS migration_name, btrim(sha256) AS applied_sha256
       FROM public.applied_migrations
      WHERE name = ANY($1::text[])
      ORDER BY name`,
    [CRITICAL_FINANCIAL_MIGRATIONS.map(({ migrationName }) => migrationName)],
  );
  return result.rows;
}

function criticalMigrationEvidenceMatches(
  observed: readonly AppliedMigrationEvidenceRow[],
  expected: readonly NonproductionFinancialMigrationEvidence[],
): boolean {
  const actual = new Map(observed.map((row) => [row.migration_name, row.applied_sha256]));
  return observed.length === expected.length
    && actual.size === expected.length
    && expected.every(({ migrationName, sha256 }) => actual.get(migrationName) === sha256);
}

async function readCriticalSchemaIdentityEvidence(
  query: QueryFn,
): Promise<CriticalSchemaIdentityRow[]> {
  const result = await query<CriticalSchemaIdentityRow>(
     `WITH target_relations(relation_name) AS (
       VALUES
         ${sqlTextValues(CRITICAL_RELATION_NAMES)}
     ), target_functions(function_name) AS (
       VALUES
         ${sqlTextValues(CRITICAL_FUNCTION_NAMES)}
     ), relation_objects AS (
       SELECT target.relation_name,
              relation.oid AS relation_oid,
              relation.relowner,
              relation.relacl,
              relation.relkind,
              relation.relpersistence,
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              relation.relreplident,
              relation.relispartition,
              relation.reloptions
         FROM target_relations target
         LEFT JOIN pg_catalog.pg_namespace namespace
           ON namespace.nspname = 'public'
         LEFT JOIN pg_catalog.pg_class relation
           ON relation.relnamespace = namespace.oid
          AND relation.relname = target.relation_name
     ), relation_identities AS (
       SELECT relation_object.relation_name,
              CASE WHEN relation_object.relation_oid IS NULL THEN 'MISSING'
                   ELSE concat_ws('|',
                     'relkind=' || relation_object.relkind::text,
                     'persistence=' || relation_object.relpersistence::text,
                     'rls=' || relation_object.relrowsecurity::text,
                     'force_rls=' || relation_object.relforcerowsecurity::text,
                     'replica_identity=' || relation_object.relreplident::text,
                     'is_partition=' || relation_object.relispartition::text,
                     'options=' || COALESCE((
                       SELECT string_agg(relation_option, ',' ORDER BY relation_option)
                         FROM unnest(relation_object.reloptions) relation_option
                     ), 'NULL'),
                     'columns=' || COALESCE((
                       SELECT string_agg(concat_ws(':',
                         attribute.attname,
                         pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                         attribute.attnotnull::text,
                         attribute.attidentity::text,
                         attribute.attgenerated::text,
                         attribute.attndims::text,
                         CASE WHEN attribute.attcollation = 0 THEN 'NONE'
                              ELSE attribute.attcollation::regcollation::text
                         END,
                         COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), 'NULL')
                       ), ',' ORDER BY attribute.attnum)
                       FROM pg_catalog.pg_attribute attribute
                       LEFT JOIN pg_catalog.pg_attrdef default_value
                         ON default_value.adrelid = attribute.attrelid
                        AND default_value.adnum = attribute.attnum
                      WHERE attribute.attrelid = relation_object.relation_oid
                        AND attribute.attnum > 0
                        AND NOT attribute.attisdropped
                     ), '')
                   )
              END AS identity
         FROM relation_objects relation_object
     ), constraint_identities AS (
       SELECT namespace.nspname || '.' || relation.relname || '.' ||
                constraint_record.conname AS object_name,
              concat_ws('|',
                constraint_record.contype::text,
                constraint_record.convalidated::text,
                constraint_record.condeferrable::text,
                constraint_record.condeferred::text,
                constraint_record.connoinherit::text,
                pg_catalog.pg_get_constraintdef(constraint_record.oid, false)
              ) AS identity
         FROM pg_catalog.pg_constraint constraint_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         LEFT JOIN pg_catalog.pg_class referenced_relation
           ON referenced_relation.oid = constraint_record.confrelid
         LEFT JOIN pg_catalog.pg_namespace referenced_namespace
           ON referenced_namespace.oid = referenced_relation.relnamespace
        WHERE ((
            namespace.nspname = 'public'
            AND relation.relname IN (SELECT relation_name FROM target_relations)
          ) OR (
            referenced_namespace.nspname = 'public'
            AND referenced_relation.relname IN (SELECT relation_name FROM target_relations)
          ))
          AND constraint_record.contype IN ('p', 'f', 'u', 'c')
     ), index_identities AS (
       SELECT relation.relname || '.' || index_relation.relname AS object_name,
              concat_ws('|',
                'unique=' || index_record.indisunique::text,
                'primary=' || index_record.indisprimary::text,
                'valid=' || index_record.indisvalid::text,
                'ready=' || index_record.indisready::text,
                'live=' || index_record.indislive::text,
                'exclusion=' || index_record.indisexclusion::text,
                'immediate=' || index_record.indimmediate::text,
                'replica_identity=' || index_record.indisreplident::text,
                'clustered=' || index_record.indisclustered::text,
                'nulls_not_distinct=' || index_record.indnullsnotdistinct::text,
                'key_attributes=' || index_record.indnkeyatts::text,
                'attributes=' || index_record.indnatts::text,
                'access_method=' || access_method.amname,
                'expression=' || COALESCE(
                  pg_catalog.pg_get_expr(index_record.indexprs, index_record.indrelid),
                  'NULL'
                ),
                'predicate=' || COALESCE(
                  pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid),
                  'NULL'
                ),
                pg_catalog.pg_get_indexdef(index_record.indexrelid, 0, false)
              ) AS identity
         FROM pg_catalog.pg_index index_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = index_record.indrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         JOIN pg_catalog.pg_class index_relation
           ON index_relation.oid = index_record.indexrelid
         JOIN pg_catalog.pg_am access_method
           ON access_method.oid = index_relation.relam
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relation_name FROM target_relations)
     ), function_objects AS (
       SELECT procedure.oid AS function_oid,
              procedure.proname,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
              procedure.proowner,
              procedure.proacl,
              procedure.prokind,
              procedure.prorettype,
              procedure.provolatile,
              procedure.prosecdef,
              procedure.proleakproof,
              procedure.proisstrict,
              procedure.proparallel,
              procedure.proconfig,
              procedure.prolang
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname IN (SELECT function_name FROM target_functions)
     ), function_identities AS (
       SELECT function_object.proname || '(' ||
                function_object.identity_arguments || ')' AS object_name,
              concat_ws('|',
                function_object.prokind::text,
                function_object.prorettype::regtype::text,
                language.lanname,
                function_object.provolatile::text,
                function_object.prosecdef::text,
                function_object.proleakproof::text,
                function_object.proisstrict::text,
                function_object.proparallel::text,
                COALESCE(array_to_string(function_object.proconfig, ','), 'NULL'),
                pg_catalog.pg_get_functiondef(function_object.function_oid)
              ) AS identity
         FROM function_objects function_object
         JOIN pg_catalog.pg_language language
           ON language.oid = function_object.prolang
     ), trigger_identities AS (
       SELECT relation.relname || '.' || trigger_record.tgname AS object_name,
              concat_ws('|',
                trigger_record.tgenabled::text,
                trigger_record.tgtype::text,
                function_namespace.nspname || '.' || function_record.proname,
                COALESCE(pg_catalog.pg_get_expr(trigger_record.tgqual, trigger_record.tgrelid), 'NULL'),
                pg_catalog.pg_get_triggerdef(trigger_record.oid, false)
              ) AS identity
         FROM pg_catalog.pg_trigger trigger_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = trigger_record.tgrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         JOIN pg_catalog.pg_proc function_record
           ON function_record.oid = trigger_record.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_record.pronamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relation_name FROM target_relations)
          AND NOT trigger_record.tgisinternal
     ), constraint_trigger_identities AS (
       SELECT constraint_relation.relname || '.' || constraint_record.conname || '|' ||
              trigger_relation.relname || '|' || function_record.proname || '|' ||
              trigger_record.tgtype::text AS object_name,
              concat_ws('|',
                'enabled=' || trigger_record.tgenabled::text,
                'deferrable=' || trigger_record.tgdeferrable::text,
                'initially_deferred=' || trigger_record.tginitdeferred::text,
                'function=' || function_namespace.nspname || '.' || function_record.proname,
                'qual=' || COALESCE(
                  pg_catalog.pg_get_expr(trigger_record.tgqual, trigger_record.tgrelid),
                  'NULL'
                )
              ) AS identity
         FROM pg_catalog.pg_constraint constraint_record
         JOIN pg_catalog.pg_class constraint_relation
           ON constraint_relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace constraint_namespace
           ON constraint_namespace.oid = constraint_relation.relnamespace
         JOIN pg_catalog.pg_trigger trigger_record
           ON trigger_record.tgconstraint = constraint_record.oid
          AND trigger_record.tgisinternal
         JOIN pg_catalog.pg_class trigger_relation
           ON trigger_relation.oid = trigger_record.tgrelid
         JOIN pg_catalog.pg_proc function_record
           ON function_record.oid = trigger_record.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_record.pronamespace
         LEFT JOIN pg_catalog.pg_class referenced_relation
           ON referenced_relation.oid = constraint_record.confrelid
         LEFT JOIN pg_catalog.pg_namespace referenced_namespace
           ON referenced_namespace.oid = referenced_relation.relnamespace
        WHERE ((
            constraint_namespace.nspname = 'public'
            AND constraint_relation.relname IN (SELECT relation_name FROM target_relations)
          ) OR (
            referenced_namespace.nspname = 'public'
            AND referenced_relation.relname IN (SELECT relation_name FROM target_relations)
          ))
          AND constraint_record.contype IN ('p', 'f', 'u', 'c')
     ), policy_identities AS (
       SELECT relation.relname || '.' || policy_record.polname AS object_name,
              concat_ws('|',
                'command=' || policy_record.polcmd::text,
                'permissive=' || policy_record.polpermissive::text,
                'roles=' || COALESCE((
                  SELECT pg_catalog.string_agg(
                    CASE WHEN policy_role.role_oid = 0 THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(policy_role.role_oid)
                    END,
                    ',' ORDER BY pg_catalog.pg_get_userbyid(policy_role.role_oid)
                  )
                    FROM pg_catalog.unnest(policy_record.polroles) policy_role(role_oid)
                ), ''),
                'using=' || COALESCE(
                  pg_catalog.pg_get_expr(policy_record.polqual, policy_record.polrelid),
                  'NULL'
                ),
                'check=' || COALESCE(
                  pg_catalog.pg_get_expr(policy_record.polwithcheck, policy_record.polrelid),
                  'NULL'
                )
              ) AS identity
         FROM pg_catalog.pg_policy policy_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = policy_record.polrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relation_name FROM target_relations)
     ), extension_identities AS (
       SELECT target.extension_name AS object_name,
              CASE WHEN extension_record.oid IS NULL THEN 'MISSING'
                   ELSE concat_ws('|',
                     'version=' || extension_record.extversion,
                     'schema=' || extension_namespace.nspname,
                     'relocatable=' || extension_record.extrelocatable::text
                   )
              END AS identity
         FROM (VALUES ('pgcrypto'::text)) target(extension_name)
         LEFT JOIN pg_catalog.pg_extension extension_record
           ON extension_record.extname = target.extension_name
         LEFT JOIN pg_catalog.pg_namespace extension_namespace
           ON extension_namespace.oid = extension_record.extnamespace
     ), identity_documents(identity_name, identity_document) AS (
       SELECT 'relations', COALESCE(string_agg(
                relation_name || '|' || identity,
                E'\\n' ORDER BY relation_name
              ), '')
         FROM relation_identities
       UNION ALL
       SELECT 'constraints', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM constraint_identities
       UNION ALL
       SELECT 'indexes', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM index_identities
       UNION ALL
       SELECT 'functions', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM function_identities
       UNION ALL
       SELECT 'triggers', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM trigger_identities
       UNION ALL
       SELECT 'constraint_triggers', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM constraint_trigger_identities
       UNION ALL
       SELECT 'policies', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM policy_identities
       UNION ALL
       SELECT 'extensions', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\\n' ORDER BY object_name
              ), '')
         FROM extension_identities
     )
     SELECT identity_name,
            pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(identity_document, 'UTF8')),
              'hex'
            ) AS identity_sha256
       FROM identity_documents
      ORDER BY identity_name`,
  );
  return result.rows;
}

async function readDatabaseAuthorityViolations(
  query: QueryFn,
): Promise<DatabaseAuthorityViolationRow[]> {
  const result = await query<DatabaseAuthorityViolationRow>(
    `WITH RECURSIVE target_relations(relation_name) AS (
       VALUES
         ${sqlTextValues(CRITICAL_RELATION_NAMES)}
     ), target_functions(function_name) AS (
       VALUES
         ${sqlTextValues(CRITICAL_FUNCTION_NAMES)}
     ), runtime_role AS (
       SELECT role_record.*
         FROM pg_catalog.pg_roles role_record
        WHERE role_record.rolname = current_user
     ), current_database_record AS (
       SELECT database_record.*
         FROM pg_catalog.pg_database database_record
        WHERE database_record.datname = current_database()
     ), relation_objects AS (
       SELECT relation.oid AS object_oid,
              relation.relname AS object_name,
              relation.relowner AS owner_oid,
              relation.relacl AS object_acl,
              'r'::text AS acl_kind
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relation_name FROM target_relations)
     ), function_objects AS (
       SELECT procedure.oid AS object_oid,
              procedure.proname || '(' ||
                pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')'
                AS object_name,
              procedure.proowner AS owner_oid,
              procedure.proacl AS object_acl,
              'f'::text AS acl_kind
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname IN (SELECT function_name FROM target_functions)
     ), object_owners AS (
       SELECT owner_oid FROM relation_objects
       UNION
       SELECT owner_oid FROM function_objects
     ), authority_owners AS (
       SELECT owner_oid FROM object_owners
       UNION
       SELECT namespace.nspowner
         FROM pg_catalog.pg_namespace namespace
        WHERE namespace.nspname = 'public'
       UNION
       SELECT extension_record.extowner
         FROM pg_catalog.pg_extension extension_record
        WHERE extension_record.extname = 'pgcrypto'
       UNION
       SELECT database_record.datdba
         FROM current_database_record database_record
     ), owner_roles AS (
       SELECT role_record.*
         FROM pg_catalog.pg_roles role_record
        WHERE role_record.oid IN (SELECT owner_oid FROM authority_owners)
     ), role_membership(member_oid, role_oid) AS (
       SELECT membership.member, membership.roleid
         FROM pg_catalog.pg_auth_members membership
       UNION
       SELECT inherited.member_oid, membership.roleid
         FROM role_membership inherited
         JOIN pg_catalog.pg_auth_members membership
           ON membership.member = inherited.role_oid
     ), unsafe_owner_login_members AS (
       SELECT login_role.oid
         FROM pg_catalog.pg_roles login_role
        WHERE login_role.rolcanlogin
          AND EXISTS (
            SELECT 1
              FROM authority_owners owner
             WHERE login_role.oid <> owner.owner_oid
               AND EXISTS (
                 SELECT 1
                   FROM role_membership membership
                  WHERE membership.member_oid = login_role.oid
                    AND membership.role_oid = owner.owner_oid
               )
          )
     ), unsafe_owner_elevated_memberships AS (
       SELECT owner.owner_oid
         FROM authority_owners owner
         JOIN pg_catalog.pg_roles elevated_role
           ON elevated_role.oid <> owner.owner_oid
          AND (
            elevated_role.rolsuper
            OR elevated_role.rolcreaterole
            OR elevated_role.rolcreatedb
            OR elevated_role.rolreplication
            OR elevated_role.rolbypassrls
          )
          AND EXISTS (
            SELECT 1
              FROM role_membership membership
             WHERE membership.member_oid = owner.owner_oid
               AND membership.role_oid = elevated_role.oid
          )
     ), relation_acl_items AS (
       SELECT 'relation'::text AS object_kind,
              relation_object.object_name,
              relation_object.owner_oid,
              privilege.grantee,
              privilege.privilege_type,
              privilege.is_grantable
         FROM relation_objects relation_object
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(COALESCE(
             relation_object.object_acl,
             pg_catalog.acldefault('r', relation_object.owner_oid)
           )) > 0
           THEN COALESCE(
             relation_object.object_acl,
             pg_catalog.acldefault('r', relation_object.owner_oid)
           )
           ELSE NULL::aclitem[] END
         ) privilege
     ), column_acl_items AS (
       SELECT 'column'::text AS object_kind,
              relation.relname || '.' || attribute.attname AS object_name,
              relation.relowner AS owner_oid,
              privilege.grantee,
              privilege.privilege_type,
              privilege.is_grantable
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         JOIN pg_catalog.pg_attribute attribute
           ON attribute.attrelid = relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(attribute.attacl) > 0
                THEN attribute.attacl
                ELSE NULL::aclitem[] END
         ) privilege
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (SELECT relation_name FROM target_relations)
     ), function_acl_items AS (
       SELECT 'function'::text AS object_kind,
              function_object.object_name,
              function_object.owner_oid,
              privilege.grantee,
              privilege.privilege_type,
              privilege.is_grantable
         FROM function_objects function_object
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(COALESCE(
             function_object.object_acl,
             pg_catalog.acldefault('f', function_object.owner_oid)
           )) > 0
           THEN COALESCE(
             function_object.object_acl,
             pg_catalog.acldefault('f', function_object.owner_oid)
           )
           ELSE NULL::aclitem[] END
         ) privilege
     ), object_acl_items AS (
       SELECT * FROM relation_acl_items
       UNION ALL
       SELECT * FROM column_acl_items
       UNION ALL
       SELECT * FROM function_acl_items
     ), default_acl_targets AS (
       SELECT owner_oid, acl_kind
         FROM object_owners
         CROSS JOIN (VALUES ('r'::text), ('f'::text)) kinds(acl_kind)
     ), global_default_acls AS (
       SELECT target.owner_oid,
              target.acl_kind,
              COALESCE(default_acl.defaclacl,
                CASE target.acl_kind
                  WHEN 'r' THEN pg_catalog.acldefault('r', target.owner_oid)
                  ELSE pg_catalog.acldefault('f', target.owner_oid)
                END
              ) AS effective_acl
         FROM default_acl_targets target
         LEFT JOIN pg_catalog.pg_default_acl default_acl
           ON default_acl.defaclrole = target.owner_oid
          AND default_acl.defaclnamespace = 0
          AND default_acl.defaclobjtype::text = target.acl_kind
     ), schema_default_acls AS (
       SELECT default_acl.defaclrole AS owner_oid,
              default_acl.defaclacl AS effective_acl
         FROM pg_catalog.pg_default_acl default_acl
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = default_acl.defaclnamespace
        WHERE namespace.nspname = 'public'
          AND default_acl.defaclrole IN (SELECT owner_oid FROM object_owners)
          AND default_acl.defaclobjtype IN ('r', 'f')
     ), default_acl_items AS (
       SELECT default_acl.owner_oid,
              privilege.grantee,
              privilege.privilege_type
         FROM global_default_acls default_acl
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(default_acl.effective_acl) > 0
                THEN default_acl.effective_acl
                ELSE NULL::aclitem[] END
         ) privilege
       UNION ALL
       SELECT default_acl.owner_oid,
              privilege.grantee,
              privilege.privilege_type
         FROM schema_default_acls default_acl
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(default_acl.effective_acl) > 0
                THEN default_acl.effective_acl
                ELSE NULL::aclitem[] END
         ) privilege
     ), public_schema_acl AS (
       SELECT namespace.nspowner AS owner_oid,
              privilege.grantee,
              privilege.privilege_type,
              privilege.is_grantable
         FROM pg_catalog.pg_namespace namespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(COALESCE(
             namespace.nspacl,
             pg_catalog.acldefault('n', namespace.nspowner)
           )) > 0
           THEN COALESCE(
             namespace.nspacl,
             pg_catalog.acldefault('n', namespace.nspowner)
           )
           ELSE NULL::aclitem[] END
         ) privilege
        WHERE namespace.nspname = 'public'
     ), database_acl AS (
       SELECT database_record.datdba AS owner_oid,
              privilege.grantee,
              privilege.privilege_type,
              privilege.is_grantable
         FROM current_database_record database_record
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           CASE WHEN pg_catalog.cardinality(COALESCE(
             database_record.datacl,
             pg_catalog.acldefault('d', database_record.datdba)
           )) > 0
           THEN COALESCE(
             database_record.datacl,
             pg_catalog.acldefault('d', database_record.datdba)
           )
           ELSE NULL::aclitem[] END
         ) privilege
     ), target_foreign_keys AS (
       SELECT constraint_record.oid
         FROM pg_catalog.pg_constraint constraint_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         LEFT JOIN pg_catalog.pg_class referenced_relation
           ON referenced_relation.oid = constraint_record.confrelid
         LEFT JOIN pg_catalog.pg_namespace referenced_namespace
           ON referenced_namespace.oid = referenced_relation.relnamespace
        WHERE ((
            namespace.nspname = 'public'
            AND relation.relname IN (SELECT relation_name FROM target_relations)
          ) OR (
            referenced_namespace.nspname = 'public'
            AND referenced_relation.relname IN (SELECT relation_name FROM target_relations)
          ))
          AND constraint_record.contype = 'f'
     ), foreign_key_trigger_state AS (
       SELECT foreign_key.oid,
              count(trigger_record.oid) FILTER (WHERE trigger_record.tgisinternal)
                AS internal_trigger_count,
              count(trigger_record.oid) FILTER (
                WHERE trigger_record.tgisinternal
                  AND trigger_record.tgenabled NOT IN ('O', 'A')
              ) AS disabled_trigger_count
         FROM target_foreign_keys foreign_key
         LEFT JOIN pg_catalog.pg_trigger trigger_record
           ON trigger_record.tgconstraint = foreign_key.oid
        GROUP BY foreign_key.oid
     ), disabled_internal_constraint_triggers AS (
       SELECT trigger_record.oid
         FROM pg_catalog.pg_trigger trigger_record
         JOIN pg_catalog.pg_constraint constraint_record
           ON constraint_record.oid = trigger_record.tgconstraint
         JOIN pg_catalog.pg_class relation
           ON relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         LEFT JOIN pg_catalog.pg_class referenced_relation
           ON referenced_relation.oid = constraint_record.confrelid
         LEFT JOIN pg_catalog.pg_namespace referenced_namespace
           ON referenced_namespace.oid = referenced_relation.relnamespace
        WHERE ((
            namespace.nspname = 'public'
            AND relation.relname IN (SELECT relation_name FROM target_relations)
          ) OR (
            referenced_namespace.nspname = 'public'
            AND referenced_relation.relname IN (SELECT relation_name FROM target_relations)
          ))
          AND trigger_record.tgisinternal
          AND trigger_record.tgenabled NOT IN ('O', 'A')
     ), violations(violation_code) AS (
       SELECT 'RUNTIME_ROLE_ELEVATED'
         FROM runtime_role
        WHERE rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
       UNION ALL
       SELECT 'OBJECT_OWNER_ROLE_COUNT'
        WHERE (SELECT count(*) FROM authority_owners) <> 1
       UNION ALL
       SELECT 'OBJECT_OWNER_UNSAFE'
         FROM owner_roles
        WHERE rolsuper OR rolcanlogin OR rolcreaterole OR rolcreatedb
           OR rolreplication OR rolbypassrls
       UNION ALL
       SELECT 'RUNTIME_HAS_OWNER_AUTHORITY'
         FROM authority_owners owner
         CROSS JOIN runtime_role runtime
        WHERE owner.owner_oid = runtime.oid
           OR EXISTS (
             SELECT 1
               FROM role_membership membership
              WHERE membership.member_oid = runtime.oid
                AND membership.role_oid = owner.owner_oid
           )
       UNION ALL
       SELECT 'OWNER_HAS_LOGIN_MEMBER'
         FROM unsafe_owner_login_members
       UNION ALL
       SELECT 'OWNER_HAS_ELEVATED_MEMBERSHIP'
         FROM unsafe_owner_elevated_memberships
       UNION ALL
       SELECT 'OBJECT_PUBLIC_GRANT'
         FROM object_acl_items
        WHERE grantee = 0
       UNION ALL
       SELECT 'OBJECT_ROGUE_GRANT'
         FROM object_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.grantee <> 0
          AND acl_item.grantee <> acl_item.owner_oid
          AND acl_item.grantee <> runtime.oid
       UNION ALL
       SELECT 'RUNTIME_COLUMN_GRANT'
         FROM object_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.object_kind = 'column'
          AND acl_item.grantee = runtime.oid
       UNION ALL
       SELECT 'RUNTIME_GRANT_OPTION'
         FROM object_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.grantee = runtime.oid
          AND acl_item.is_grantable
       UNION ALL
       SELECT 'RUNTIME_FUNCTION_EXECUTE_GRANT'
         FROM object_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.object_kind = 'function'
          AND acl_item.grantee = runtime.oid
       UNION ALL
       SELECT 'RUNTIME_RELATION_PRIVILEGE_EXCEEDS_ALLOWLIST'
         FROM object_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.object_kind = 'relation'
          AND acl_item.grantee = runtime.oid
          AND NOT (
            acl_item.privilege_type = 'SELECT'
            OR (
              acl_item.privilege_type = 'INSERT'
              AND acl_item.object_name NOT IN (
                ${READ_ONLY_ATTESTATION_RELATION_NAMES
                  .map((name) => `'${name}'`)
                  .join(', ')}
              )
            )
            OR (
              acl_item.object_name = 'provider_event_processing_state'
              AND acl_item.privilege_type = 'UPDATE'
            )
          )
       UNION ALL
       SELECT 'PUBLIC_SCHEMA_CREATE'
         FROM public_schema_acl
        WHERE grantee = 0 AND privilege_type = 'CREATE'
       UNION ALL
       SELECT 'PUBLIC_SCHEMA_GRANT_OPTION'
         FROM public_schema_acl
        WHERE grantee = 0 AND is_grantable
       UNION ALL
       SELECT 'SCHEMA_ROGUE_GRANT'
         FROM public_schema_acl schema_acl
         CROSS JOIN runtime_role runtime
        WHERE schema_acl.grantee <> 0
          AND schema_acl.grantee <> schema_acl.owner_oid
          AND schema_acl.grantee <> runtime.oid
       UNION ALL
       SELECT 'RUNTIME_SCHEMA_CREATE'
        WHERE pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
       UNION ALL
       SELECT 'RUNTIME_DATABASE_CREATE_OR_TEMP'
        WHERE pg_catalog.has_database_privilege(
          current_user,
          current_database(),
          'CREATE'
        ) OR pg_catalog.has_database_privilege(
          current_user,
          current_database(),
          'TEMPORARY'
        )
       UNION ALL
       SELECT 'DATABASE_PUBLIC_CREATE_OR_TEMP'
         FROM database_acl
        WHERE grantee = 0 AND privilege_type IN ('CREATE', 'TEMPORARY')
       UNION ALL
       SELECT 'DATABASE_ROGUE_CREATE_OR_TEMP'
         FROM database_acl database_privilege
         CROSS JOIN runtime_role runtime
        WHERE database_privilege.grantee <> 0
          AND database_privilege.grantee <> database_privilege.owner_oid
          AND database_privilege.grantee <> runtime.oid
          AND database_privilege.privilege_type IN ('CREATE', 'TEMPORARY')
       UNION ALL
       SELECT 'RUNTIME_SCHEMA_GRANT_OPTION'
         FROM public_schema_acl schema_acl
         CROSS JOIN runtime_role runtime
        WHERE schema_acl.grantee = runtime.oid
          AND schema_acl.is_grantable
       UNION ALL
       SELECT 'DEFAULT_PUBLIC_GRANT'
         FROM default_acl_items
        WHERE grantee = 0
       UNION ALL
       SELECT 'DEFAULT_ROGUE_GRANT'
         FROM default_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.grantee <> 0
          AND acl_item.grantee <> acl_item.owner_oid
          AND acl_item.grantee <> runtime.oid
       UNION ALL
       SELECT 'DEFAULT_RUNTIME_GRANT'
         FROM default_acl_items acl_item
         CROSS JOIN runtime_role runtime
        WHERE acl_item.grantee = runtime.oid
       UNION ALL
       SELECT 'FOREIGN_KEY_INTERNAL_TRIGGER_UNSAFE'
         FROM foreign_key_trigger_state
        WHERE internal_trigger_count < 4 OR disabled_trigger_count > 0
       UNION ALL
       SELECT 'INTERNAL_CONSTRAINT_TRIGGER_DISABLED'
         FROM disabled_internal_constraint_triggers
     )
     SELECT DISTINCT violation_code
       FROM violations
      ORDER BY violation_code`,
  );
  return result.rows;
}

function validExpectedSchemaEvidence(
  expected: readonly CriticalSchemaIdentityEvidence[],
): boolean {
  return expected.length === CRITICAL_SCHEMA_IDENTITY_NAMES.length
    && expected.every((entry, index) => (
      entry.identityName === CRITICAL_SCHEMA_IDENTITY_NAMES[index]
      && SHA256.test(entry.sha256)
    ));
}

function criticalSchemaEvidenceMatches(
  observed: readonly CriticalSchemaIdentityRow[],
  expected: readonly CriticalSchemaIdentityEvidence[],
): boolean {
  const actual = new Map(observed.map((row) => [row.identity_name, row.identity_sha256]));
  return observed.length === expected.length
    && actual.size === expected.length
    && expected.every(({ identityName, sha256 }) => actual.get(identityName) === sha256);
}

/**
 * Read-only runtime attestation for the nonproduction fake-finance schema.
 *
 * This grants no provider authority and performs no migration. A nonproduction
 * runtime is ready only when its exact authorized manifest is bound to one
 * append-only bootstrap completion, every current financial SQL checksum, and
 * the exact live catalog identity of the financial intake, preparation,
 * processing, command-journal, and recovery schema.
 */
export async function readNonproductionFinancialBootstrapReadiness(
  options: ReadinessOptions,
): Promise<NonproductionFinancialBootstrapReadiness> {
  const environment = normalizeEnvironment(options.environment);
  if (hasContradictoryProductionMetadata(options.environment, options.env)) {
    return baseReadiness(environment, 'unauthorized', {
      required: true,
      ready: false,
    });
  }
  if (environment === 'production') {
    return baseReadiness(environment, 'disabled', { required: false });
  }
  if (environment === 'unknown') {
    return baseReadiness(environment, 'unauthorized');
  }

  let manifest;
  try {
    manifest = assertNonproductionFakeFinanceAuthorized({
      env: { ...options.env, HX_ENVIRONMENT: environment },
      release: options.release,
      identity: options.identity,
      component: options.component,
    });
  } catch {
    return baseReadiness(environment, 'unauthorized');
  }

  const exactReleaseManifestDigest = releaseManifestDigest(manifest);
  const migrationArtifactDigest = manifest.components.migration.artifactDigest;
  const evidenceFields = {
    releaseId: manifest.releaseId,
    releaseManifestDigest: exactReleaseManifestDigest,
    migrationArtifactDigest,
  };

  try {
    return await options.database.transaction(async (query) => {
      await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await query("SET LOCAL search_path = 'pg_catalog'");
      await query("SET LOCAL statement_timeout = '1000ms'");
      await query("SET LOCAL lock_timeout = '250ms'");
      const completion = await query<BootstrapCompletionRow>(
      `SELECT release_id, release_environment, required_migration_count,
              financial_migration_status, completed_at
       FROM public.hxos_nonproduction_bootstrap_completion_v1
       WHERE release_manifest_digest = $1
         AND migration_artifact_digest = $2`,
      [exactReleaseManifestDigest, migrationArtifactDigest],
    );
    const row = completion.rows[0];
    if (
      completion.rows.length !== 1
      || !row
      || row.release_id !== manifest.releaseId
      || row.release_environment !== environment
      || Number(row.required_migration_count) !== REQUIRED_MIGRATION_FILES.length
      || !['applied', 'already_applied'].includes(row.financial_migration_status)
    ) {
      return baseReadiness(environment, 'bootstrap_missing', evidenceFields);
    }

    const expected = options.expectedFinancialEvidence ?? await expectedFinancialEvidence();
    if (
      expected.length !== NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.length
      || expected.some((entry, index) => (
        entry.migrationName !== NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES[index]?.name
        || !SHA256.test(entry.sha256)
      ))
    ) {
      return baseReadiness(environment, 'attestation_unavailable', evidenceFields);
    }
    const observed = await readSchemaEvidence(query);
    const matchedFakeFinancialMigrationCount = matchingEvidenceCount(observed, expected);
    if (
      observed.length !== expected.length
      || matchedFakeFinancialMigrationCount !== expected.length
    ) {
      return baseReadiness(environment, 'schema_evidence_mismatch', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }

    const expectedCriticalMigrations = options.expectedCriticalMigrationEvidence
      ?? await expectedCriticalMigrationEvidence();
    if (!validExpectedEvidence(
      expectedCriticalMigrations,
      CRITICAL_FINANCIAL_MIGRATIONS.map(({ migrationName }) => migrationName),
    )) {
      return baseReadiness(environment, 'attestation_unavailable', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }
    const appliedCriticalMigrations = await readAppliedCriticalMigrationEvidence(query);
    if (!criticalMigrationEvidenceMatches(
      appliedCriticalMigrations,
      expectedCriticalMigrations,
    )) {
      return baseReadiness(environment, 'schema_evidence_mismatch', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }

    const authorityViolations = await readDatabaseAuthorityViolations(query);
    if (authorityViolations.length > 0) {
      return baseReadiness(environment, 'database_authority_violation', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }

    const expectedCriticalSchema = options.expectedCriticalSchemaEvidence
      ?? CRITICAL_SCHEMA_EVIDENCE;
    if (!validExpectedSchemaEvidence(expectedCriticalSchema)) {
      return baseReadiness(environment, 'attestation_unavailable', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }
    const observedCriticalSchema = await readCriticalSchemaIdentityEvidence(query);
    if (!criticalSchemaEvidenceMatches(observedCriticalSchema, expectedCriticalSchema)) {
      return baseReadiness(environment, 'schema_evidence_mismatch', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }

    const completedAt = new Date(row.completed_at);
    if (Number.isNaN(completedAt.getTime())) {
      return baseReadiness(environment, 'schema_evidence_mismatch', {
        ...evidenceFields,
        matchedFakeFinancialMigrationCount,
      });
    }
    return baseReadiness(environment, 'ready', {
      ...evidenceFields,
      matchedFakeFinancialMigrationCount,
      completedAt: completedAt.toISOString(),
    });
    });
  } catch {
    return baseReadiness(environment, 'attestation_unavailable', evidenceFields);
  }
}
