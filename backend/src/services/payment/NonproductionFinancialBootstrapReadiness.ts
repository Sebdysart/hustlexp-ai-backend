import { readFinancialReadinessCustodyViolations } from '../../jobs/financial-readiness-custody.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BuildIdentity } from '../../buildIdentity.js';
import type { QueryFn } from '../../db.js';
import {
  configuredWorkOrderCommandRoles,
  verifyWorkOrderCommandAuthorityInCurrentSnapshot,
  type WorkOrderCommandRoleNames,
} from '../../jobs/work-order-command-role-authority.js';
import { releaseManifestDigest, type ReleaseManifestEvidence } from '../../releaseManifest.js';
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
  | 'database_identity_mismatch'
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

interface WorkOrderBootstrapAuthorityEvidenceRow extends Record<string, unknown> {
  session_database_role: unknown;
  target_authority_id: unknown;
  authority_version: unknown;
  target_database_name: unknown;
  observed_database_name: unknown;
  environment: unknown;
  release_manifest_sha256: unknown;
  v13_sql_sha256: unknown;
  fake_financial_operations_relation: unknown;
  fake_financial_operation_events_relation: unknown;
  evidence_row_count: number | string;
  evidence_v12_sha256: string | null;
  evidence_ordinal146_sha256: string | null;
  seal_evidence_row_count: number | string;
  seal_evidence_sha256: string | null;
  seal_evidence_ordinal146_sha256: string | null;
  seal_evidence_v12_sha256: string | null;
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

interface PostgreSqlVersionRow extends Record<string, unknown> {
  server_version_num: unknown;
}

interface DatabaseIdentityRow extends Record<string, unknown> {
  server_encoding: unknown;
  database_encoding: unknown;
  locale_provider: unknown;
  lc_collate: unknown;
  lc_ctype: unknown;
  icu_locale: unknown;
  icu_rules: unknown;
  recorded_collation_version: unknown;
  actual_collation_version: unknown;
  is_template: unknown;
  allows_connections: unknown;
}

export interface NonproductionFinancialReadinessDatabase {
  readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
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
const SUPPORTED_POSTGRESQL_MAJOR = 16;
const SUPPORTED_DATABASE_IDENTITY = Object.freeze({
  serverEncoding: 'UTF8',
  databaseEncoding: 'UTF8',
  localeProvider: 'c',
  lcCollate: 'en_US.utf8',
  lcCtype: 'en_US.utf8',
  icuLocale: null,
  icuRules: null,
  recordedCollationVersion: null,
  actualCollationVersion: null,
  isTemplate: false,
  allowsConnections: true,
});
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
    migrationName: '20260928_provider_observation_normalization_v1',
    fileName: '20260928_provider_observation_normalization_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260923_legacy_escrow_insert_containment_v1',
    fileName: '20260923_legacy_escrow_insert_containment_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
    fileName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260922_universal_v1_fake_terminal_lifecycle_intent_v1',
    fileName: '20260922_universal_v1_fake_terminal_lifecycle_intent_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260926_universal_v1_change_order_three_phase_v1',
    fileName: '20260926_universal_v1_change_order_three_phase_v1.sql',
  }),
  Object.freeze({
    migrationName: '20260927_universal_v1_change_order_recovery_v1',
    fileName: '20260927_universal_v1_change_order_recovery_v1.sql',
  }),
  Object.freeze({
    migrationName: '20261002_universal_v1_dispute_fake_release_gate_v8',
    fileName: '20261002_universal_v1_dispute_fake_release_gate_v8.sql',
  }),
  Object.freeze({
    migrationName: '20261010_universal_v1_financial_security_event_expiry_v1',
    fileName: '20261010_universal_v1_financial_security_event_expiry_v1.sql',
  }),
  Object.freeze({
    migrationName: '20261010_universal_v1_fake_financial_expiry_v9',
    fileName: '20261010_universal_v1_fake_financial_expiry_v9.sql',
  }),
  Object.freeze({
    migrationName: '20261011_universal_v1_fake_financial_expiry_recovery_v10',
    fileName: '20261011_universal_v1_fake_financial_expiry_recovery_v10.sql',
  }),
  Object.freeze({
    migrationName: '20261013_nonproduction_runtime_insert_authority_v1',
    fileName: '20261013_nonproduction_runtime_insert_authority_v1.sql',
  }),
  Object.freeze({
    migrationName: '20261014_universal_v1_work_order_command_ports_v1',
    fileName: '20261014_universal_v1_work_order_command_ports_v1.sql',
  }),
  Object.freeze({
    migrationName: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
    fileName: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql',
  }),
  Object.freeze({
    migrationName: '20261015_universal_v1_work_order_bootstrap_seal_v1',
    fileName: '20261015_universal_v1_work_order_bootstrap_seal_v1.sql',
  }),
] as const);
const CRITICAL_RELATION_NAMES = Object.freeze([
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
] as const);
const SECURITY_DEFINER_DEPENDENCY_FUNCTION_SIGNATURES = Object.freeze([
  'public.digest(text,text)',
  'public.digest(bytea,text)',
] as const);
const RUNTIME_EXPRESSION_DEPENDENCY_FUNCTION_SIGNATURES =
  SECURITY_DEFINER_DEPENDENCY_FUNCTION_SIGNATURES;
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
] as const);
const CRITICAL_AUTHORITY_FUNCTION_SIGNATURES = Object.freeze([
  'hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()',
  'public.hxos_read_universal_v1_work_order_runtime_authority_v1()',
] as const);
const CRITICAL_SCHEMA_IDENTITY_NAMES = Object.freeze([
  'relations',
  'constraints',
  'indexes',
  'functions',
  'triggers',
  'rewrite_rules',
  'constraint_triggers',
  'policies',
  'extensions',
] as const);

// These PostgreSQL 16 semantic catalog fingerprints must be regenerated from
// the exact, fresh 20260916..20260923 registered engine tail plus the nonproduction
// fake-finance through v13 with canonical eight-role custody whenever any
// critical SQL changes.
const CRITICAL_SCHEMA_EVIDENCE = Object.freeze([
  {
    identityName: 'relations',
    sha256: 'd7ecec5ae7c04077d62fb668486f9726e89d8231f46106a84c797117779ab2ca',
  },
  {
    identityName: 'constraints',
    sha256: '84c8b54a03bd4c2ac2340b977adb5c9d1ee59e22b4d5e949d39ab0ca58a203b3',
  },
  {
    identityName: 'indexes',
    sha256: '9f37130df486b14ea943e255ab81ba4df1acf347bb26232b0e46ce11e4b9784f',
  },
  {
    identityName: 'functions',
    sha256: 'afca9d4e36d964306a051e5d831176ae764406fccfd702cbf85d6a5f3aacfa69',
  },
  {
    identityName: 'triggers',
    sha256: 'fc06d8677aafd69d1fd496d75f43bac0f41e5216c74787b097addfdc7b1cbbb1',
  },
  {
    identityName: 'rewrite_rules',
    sha256: '38e1ac5f344c529e5d12ef778f1be38ec5a6154487d76ca63bfbd07bde8f45f9',
  },
  {
    identityName: 'constraint_triggers',
    sha256: 'd7d9a944695d458e29b98dfb896c0e0578b2fc6604dca036cd57d36d96ff354f',
  },
  {
    identityName: 'policies',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    identityName: 'extensions',
    sha256: 'd49c999edb78e599cc4abcf90a0586c8941def0440d694fd10759d836e3818ee',
  },
] satisfies readonly CriticalSchemaIdentityEvidence[]);

/** Resolve exact catalog identities without requiring USAGE on private authority schemas.
 * Only this module's fixed SQL expression is supplied; no caller text is interpolated.
 */
function catalogFunctionOidSql(): string {
  return `(SELECT lookup_procedure.oid
             FROM pg_catalog.pg_proc lookup_procedure
             JOIN pg_catalog.pg_namespace lookup_namespace
               ON lookup_namespace.oid = lookup_procedure.pronamespace
            WHERE pg_catalog.replace(pg_catalog.format('%I.%I(%s)',
                    lookup_namespace.nspname, lookup_procedure.proname,
                    pg_catalog.oidvectortypes(lookup_procedure.proargtypes)), ', ', ',')
                  = function_signature)`;
}

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
  environment: string
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
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): boolean {
  const declaredEnvironment = normalizeEnvironment(environment);
  const hxEnvironment = env.HX_ENVIRONMENT ? normalizeEnvironment(env.HX_ENVIRONMENT) : null;
  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  if (
    hxEnvironment &&
    hxEnvironment !== 'unknown' &&
    declaredEnvironment !== 'unknown' &&
    hxEnvironment !== declaredEnvironment
  ) {
    return true;
  }
  const deploymentEnvironment =
    hxEnvironment && hxEnvironment !== 'unknown' ? hxEnvironment : declaredEnvironment;
  if (deploymentEnvironment === 'preview' || deploymentEnvironment === 'staging') {
    return nodeEnvironment !== 'production';
  }
  return (
    deploymentEnvironment === 'production' &&
    Boolean(nodeEnvironment) &&
    nodeEnvironment !== 'production'
  );
}

function baseReadiness(
  environment: NonproductionFinancialBootstrapReadiness['environment'],
  status: NonproductionFinancialBootstrapReadinessStatus,
  overrides: Partial<NonproductionFinancialBootstrapReadiness> = {}
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
  environment: string
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
  return Promise.all(
    NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(async (migration) => {
      const contents = await readFile(expectedEvidencePath(migration.fileName));
      return {
        migrationName: migration.name,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    })
  );
}

function expectedFinancialEvidence(): Promise<readonly NonproductionFinancialMigrationEvidence[]> {
  defaultExpectedFinancialEvidence ??= loadExpectedFinancialEvidence();
  return defaultExpectedFinancialEvidence;
}

async function loadExpectedCriticalMigrationEvidence(): Promise<
  readonly NonproductionFinancialMigrationEvidence[]
> {
  return Promise.all(
    CRITICAL_FINANCIAL_MIGRATIONS.map(async (migration) => {
      const registered =
        NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.find(
          ({ name }) => name === migration.migrationName
        ) ?? REQUIRED_MIGRATION_FILES.find(({ name }) => name === migration.migrationName);
      if (registered?.fileName !== migration.fileName) {
        throw new Error('critical financial migration registry identity is unavailable');
      }
      const contents = await readFile(expectedEvidencePath(migration.fileName));
      return {
        migrationName: migration.migrationName,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    })
  );
}

function expectedCriticalMigrationEvidence(): Promise<
  readonly NonproductionFinancialMigrationEvidence[]
> {
  defaultExpectedCriticalMigrationEvidence ??= loadExpectedCriticalMigrationEvidence();
  return defaultExpectedCriticalMigrationEvidence;
}

async function readSchemaEvidence(query: QueryFn): Promise<SchemaEvidenceRow[]> {
  const result = await query<SchemaEvidenceRow>(
    `SELECT migration_name, evidence_sha256, applied_sha256
       FROM public.hxos_read_fake_financial_schema_evidence_v13()`
  );
  return result.rows;
}

async function readWorkOrderBootstrapAuthorityEvidence(
  query: QueryFn
): Promise<WorkOrderBootstrapAuthorityEvidenceRow | null> {
  // The sealed reader rejects missing/duplicate receipts and ledger drift before
  // returning the exact frozen predecessor hashes. No runtime evidence-table access.
  const result = await query<WorkOrderBootstrapAuthorityEvidenceRow>(
    `SELECT session_database_role, target_authority_id::text, authority_version,
            target_database_name, pg_catalog.current_database()::text AS observed_database_name,
            environment, release_manifest_sha256, v13_sql_sha256,
            fake_financial_operations_relation, fake_financial_operation_events_relation,
            1 AS evidence_row_count,
            v12_sql_sha256 AS evidence_v12_sha256,
            ordinal146_sql_sha256 AS evidence_ordinal146_sha256,
            1 AS seal_evidence_row_count,
            seal_sql_sha256 AS seal_evidence_sha256,
            ordinal146_sql_sha256 AS seal_evidence_ordinal146_sha256,
            v12_sql_sha256 AS seal_evidence_v12_sha256
       FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()`
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}

function matchingEvidenceCount(
  observed: readonly SchemaEvidenceRow[],
  expected: readonly NonproductionFinancialMigrationEvidence[]
): number {
  const actual = new Map(observed.map((row) => [row.migration_name, row]));
  return expected.filter(({ migrationName, sha256 }) => {
    const row = actual.get(migrationName);
    return SHA256.test(sha256) && row?.evidence_sha256 === sha256 && row.applied_sha256 === sha256;
  }).length;
}

function validExpectedEvidence(
  observed: readonly NonproductionFinancialMigrationEvidence[],
  expectedNames: readonly string[]
): boolean {
  return (
    observed.length === expectedNames.length &&
    observed.every(
      (entry, index) => entry.migrationName === expectedNames[index] && SHA256.test(entry.sha256)
    )
  );
}

async function readAppliedCriticalMigrationEvidence(
  query: QueryFn
): Promise<AppliedMigrationEvidenceRow[]> {
  const result = await query<AppliedMigrationEvidenceRow>(
    `SELECT migration_name, applied_sha256
       FROM public.hxos_read_fake_financial_applied_migrations_v13()
      WHERE migration_name = ANY($1::text[])
      ORDER BY migration_name`,
    [CRITICAL_FINANCIAL_MIGRATIONS.map(({ migrationName }) => migrationName)]
  );
  return result.rows;
}

function criticalMigrationEvidenceMatches(
  observed: readonly AppliedMigrationEvidenceRow[],
  expected: readonly NonproductionFinancialMigrationEvidence[]
): boolean {
  const actual = new Map(observed.map((row) => [row.migration_name, row.applied_sha256]));
  return (
    observed.length === expected.length &&
    actual.size === expected.length &&
    expected.every(({ migrationName, sha256 }) => actual.get(migrationName) === sha256)
  );
}

async function readCriticalSchemaIdentityEvidence(
  query: QueryFn,
  roles: WorkOrderCommandRoleNames
): Promise<CriticalSchemaIdentityRow[]> {
  const result = await query<CriticalSchemaIdentityRow>(
    `WITH configured_role_labels AS MATERIALIZED (
       SELECT configured.key AS role_label, role_record.oid AS role_oid
       FROM pg_catalog.jsonb_each_text($1::jsonb) configured
       JOIN pg_catalog.pg_roles role_record ON role_record.rolname=configured.value
     ), target_relations(relation_name,schema_name) AS (
       SELECT relation_name,'public' FROM (VALUES ${sqlTextValues(CRITICAL_RELATION_NAMES)}) configured(relation_name)
       UNION ALL SELECT 'fake_financial_change_order_compensation_origins_v13','hx_authority'
     ), target_functions(function_name) AS (
       VALUES
         ${sqlTextValues(CRITICAL_FUNCTION_NAMES)}
     ), target_authority_functions(function_signature) AS (
       VALUES
         ${sqlTextValues(CRITICAL_AUTHORITY_FUNCTION_SIGNATURES)}
     ), target_extension_function_signatures(function_signature) AS (
       VALUES
         ${sqlTextValues(RUNTIME_EXPRESSION_DEPENDENCY_FUNCTION_SIGNATURES)}
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
           ON namespace.nspname = target.schema_name
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
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
          ) OR (
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=referenced_namespace.nspname AND target.relation_name=referenced_relation.relname)
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
        WHERE EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
     ), extension_function_members AS (
       SELECT extension_dependency.objid AS function_oid,
              extension_record.extname AS extension_name
         FROM pg_catalog.pg_depend extension_dependency
         JOIN pg_catalog.pg_extension extension_record
           ON extension_record.oid = extension_dependency.refobjid
        WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::regclass
          AND extension_dependency.refclassid = 'pg_catalog.pg_extension'::regclass
          AND extension_dependency.deptype = 'e'
     ), target_extension_functions AS (
       SELECT function_signature,
              ${catalogFunctionOidSql()}::oid AS function_oid
         FROM target_extension_function_signatures
     ), critical_trigger_functions AS (
       SELECT DISTINCT trigger_record.tgfoid AS function_oid
         FROM pg_catalog.pg_trigger trigger_record
         JOIN relation_objects relation_object
           ON relation_object.relation_oid = trigger_record.tgrelid
        WHERE relation_object.relation_oid IS NOT NULL
          AND NOT trigger_record.tgisinternal
     ), function_objects AS (
       SELECT procedure.oid AS function_oid,
              namespace.nspname AS function_schema,
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
              procedure.prolang,
              procedure.prosrc,
              procedure.probin,
              owner_role.rolcanlogin AS owner_can_login,
              owner_role.rolsuper AS owner_is_superuser,
              owner_role.rolcreaterole AS owner_can_create_role,
              owner_role.rolcreatedb AS owner_can_create_database,
              owner_role.rolreplication AS owner_can_replicate,
              owner_role.rolbypassrls AS owner_can_bypass_rls,
              extension_member.extension_name
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
         JOIN pg_catalog.pg_roles owner_role
           ON owner_role.oid = procedure.proowner
         LEFT JOIN extension_function_members extension_member
           ON extension_member.function_oid = procedure.oid
        WHERE (
            namespace.nspname = 'public'
            AND extension_member.function_oid IS NULL
          )
           OR procedure.oid IN (
             SELECT function_oid
               FROM target_extension_functions
              WHERE function_oid IS NOT NULL
           )
           OR procedure.oid IN (SELECT function_oid FROM critical_trigger_functions)
           OR procedure.oid IN (
             SELECT ${catalogFunctionOidSql()}::OID
               FROM target_authority_functions
              WHERE ${catalogFunctionOidSql()} IS NOT NULL
           )
     ), function_identities AS (
       SELECT function_object.function_schema || '.' || function_object.proname || '(' ||
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
                'owner_login=' || function_object.owner_can_login::text,
                'owner_superuser=' || function_object.owner_is_superuser::text,
                'owner_createrole=' || function_object.owner_can_create_role::text,
                'owner_createdb=' || function_object.owner_can_create_database::text,
                'owner_replication=' || function_object.owner_can_replicate::text,
                'owner_bypassrls=' || function_object.owner_can_bypass_rls::text,
                'extension=' || COALESCE(function_object.extension_name, 'NONE'),
                'acl=' || COALESCE((
                  SELECT pg_catalog.string_agg(
                    concat_ws(':',
                      CASE
                        WHEN privilege.grantee = 0 THEN 'PUBLIC'
                        WHEN privilege.grantee = function_object.proowner THEN 'OWNER'
                        ELSE COALESCE((SELECT role_label FROM configured_role_labels
                          WHERE role_oid=privilege.grantee), 'UNEXPECTED')
                      END,
                      privilege.privilege_type,
                      privilege.is_grantable::text
                    ),
                    ',' ORDER BY
                      CASE
                        WHEN privilege.grantee = 0 THEN 'PUBLIC'
                        WHEN privilege.grantee = function_object.proowner THEN 'OWNER'
                        ELSE COALESCE((SELECT role_label FROM configured_role_labels
                          WHERE role_oid=privilege.grantee), 'UNEXPECTED')
                      END,
                      privilege.privilege_type,
                      privilege.is_grantable::text
                  )
                    FROM pg_catalog.aclexplode(
                      COALESCE(
                        function_object.proacl,
                        pg_catalog.acldefault('f', function_object.proowner)
                      )
                    ) privilege
                ), ''),
                'source=' || function_object.prosrc,
                'binary=' || COALESCE(function_object.probin, 'NULL'),
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
                function_namespace.nspname || '.' || function_record.proname || '(' ||
                  pg_catalog.pg_get_function_identity_arguments(function_record.oid) || ')',
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
        WHERE EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
          AND NOT trigger_record.tgisinternal
     ), rewrite_rule_identities AS (
       SELECT namespace.nspname || '.' || relation.relname || '.' ||
                rewrite_record.rulename AS object_name,
              concat_ws('|',
                'enabled=' || rewrite_record.ev_enabled::text,
                'event=' || rewrite_record.ev_type::text,
                'instead=' || rewrite_record.is_instead::text,
                pg_catalog.pg_get_ruledef(rewrite_record.oid, false)
              ) AS identity
         FROM pg_catalog.pg_rewrite rewrite_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = rewrite_record.ev_class
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
        WHERE EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
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
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=constraint_namespace.nspname AND target.relation_name=constraint_relation.relname)
          ) OR (
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=referenced_namespace.nspname AND target.relation_name=referenced_relation.relname)
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
        WHERE EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
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
       SELECT 'rewrite_rules', COALESCE(string_agg(
                object_name || '|' || identity,
                E'\n' ORDER BY object_name
              ), '')
         FROM rewrite_rule_identities
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
    [JSON.stringify(roles)]
  );
  return result.rows;
}

async function hasSupportedPostgreSqlMajor(query: QueryFn): Promise<boolean> {
  const result = await query<PostgreSqlVersionRow>(
    `/* hxos_nonproduction_postgresql_major_v1 */
     SELECT pg_catalog.current_setting('server_version_num') AS server_version_num`
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) return false;
  const rawServerVersionNumber = result.rows[0]?.server_version_num;
  if (typeof rawServerVersionNumber !== 'string' || !/^[0-9]+$/u.test(rawServerVersionNumber)) {
    return false;
  }
  const serverVersionNumber = Number(rawServerVersionNumber);
  return (
    Number.isSafeInteger(serverVersionNumber) &&
    Math.floor(serverVersionNumber / 10_000) === SUPPORTED_POSTGRESQL_MAJOR
  );
}

async function hasSupportedDatabaseIdentity(query: QueryFn): Promise<boolean> {
  const result = await query<DatabaseIdentityRow>(
    `/* hxos_nonproduction_database_identity_v1 */
     SELECT pg_catalog.current_setting('server_encoding') AS server_encoding,
            pg_catalog.pg_encoding_to_char(database_record.encoding) AS database_encoding,
            database_record.datlocprovider::text AS locale_provider,
            database_record.datcollate AS lc_collate,
            database_record.datctype AS lc_ctype,
            database_record.daticulocale AS icu_locale,
            database_record.daticurules AS icu_rules,
            database_record.datcollversion AS recorded_collation_version,
            pg_catalog.pg_database_collation_actual_version(database_record.oid)
              AS actual_collation_version,
            database_record.datistemplate AS is_template,
            database_record.datallowconn AS allows_connections
       FROM pg_catalog.pg_database database_record
      WHERE database_record.datname = pg_catalog.current_database()`
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) return false;
  const row = result.rows[0];
  return (
    row?.server_encoding === SUPPORTED_DATABASE_IDENTITY.serverEncoding &&
    row.database_encoding === SUPPORTED_DATABASE_IDENTITY.databaseEncoding &&
    row.locale_provider === SUPPORTED_DATABASE_IDENTITY.localeProvider &&
    row.lc_collate === SUPPORTED_DATABASE_IDENTITY.lcCollate &&
    row.lc_ctype === SUPPORTED_DATABASE_IDENTITY.lcCtype &&
    row.icu_locale === SUPPORTED_DATABASE_IDENTITY.icuLocale &&
    row.icu_rules === SUPPORTED_DATABASE_IDENTITY.icuRules &&
    row.recorded_collation_version === SUPPORTED_DATABASE_IDENTITY.recordedCollationVersion &&
    row.actual_collation_version === SUPPORTED_DATABASE_IDENTITY.actualCollationVersion &&
    row.is_template === SUPPORTED_DATABASE_IDENTITY.isTemplate &&
    row.allows_connections === SUPPORTED_DATABASE_IDENTITY.allowsConnections
  );
}

async function readInternalConstraintViolations(
  query: QueryFn
): Promise<DatabaseAuthorityViolationRow[]> {
  const result =
    await query<DatabaseAuthorityViolationRow>(`WITH target_relations(relation_name,schema_name) AS (
       SELECT relation_name,'public' FROM (VALUES ${sqlTextValues(CRITICAL_RELATION_NAMES)}) configured(relation_name)
       UNION ALL SELECT 'fake_financial_change_order_compensation_origins_v13','hx_authority'
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
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
          ) OR (
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=referenced_namespace.nspname AND target.relation_name=referenced_relation.relname)
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
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=namespace.nspname AND target.relation_name=relation.relname)
          ) OR (
            EXISTS (SELECT 1 FROM target_relations target
              WHERE target.schema_name=referenced_namespace.nspname AND target.relation_name=referenced_relation.relname)
          ))
          AND trigger_record.tgisinternal
          AND trigger_record.tgenabled NOT IN ('O', 'A')
     )
    SELECT 'FOREIGN_KEY_TRIGGER_ENFORCEMENT_INVALID' AS violation_code FROM foreign_key_trigger_state
    WHERE internal_trigger_count<4 OR disabled_trigger_count>0
    UNION ALL SELECT 'DISABLED_INTERNAL_CONSTRAINT_TRIGGER' FROM disabled_internal_constraint_triggers`);
  return result.rows;
}

function validExpectedSchemaEvidence(expected: readonly CriticalSchemaIdentityEvidence[]): boolean {
  return (
    expected.length === CRITICAL_SCHEMA_IDENTITY_NAMES.length &&
    expected.every(
      (entry, index) =>
        entry.identityName === CRITICAL_SCHEMA_IDENTITY_NAMES[index] && SHA256.test(entry.sha256)
    )
  );
}

function criticalSchemaEvidenceMatches(
  observed: readonly CriticalSchemaIdentityRow[],
  expected: readonly CriticalSchemaIdentityEvidence[]
): boolean {
  const actual = new Map(observed.map((row) => [row.identity_name, row.identity_sha256]));
  return (
    observed.length === expected.length &&
    actual.size === expected.length &&
    expected.every(({ identityName, sha256 }) => actual.get(identityName) === sha256)
  );
}

/**
 * Read-only runtime attestation for the nonproduction fake-finance schema.
 *
 * This grants no provider authority and performs no migration. A nonproduction
 * runtime is ready only when its exact authorized manifest is bound to one
 * supported PostgreSQL 16 database identity, one append-only bootstrap
 * completion, every current financial SQL checksum, and the exact live catalog
 * identity of the financial intake, preparation, processing, command-journal,
 * and recovery schema.
 */
export async function readNonproductionFinancialBootstrapReadiness(
  options: ReadinessOptions
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
    return await options.database.readOnlyAttestationTransaction(async (query) => {
      if (
        !(await hasSupportedPostgreSqlMajor(query)) ||
        !(await hasSupportedDatabaseIdentity(query))
      ) {
        return baseReadiness(environment, 'database_identity_mismatch', evidenceFields);
      }
      const completion = await query<BootstrapCompletionRow>(
        `SELECT release_id, release_environment, required_migration_count,
              financial_migration_status, completed_at
       FROM public.hxos_read_fake_financial_bootstrap_completion_v13($1,$2)`,
        [exactReleaseManifestDigest, migrationArtifactDigest]
      );
      const row = completion.rows[0];
      if (
        completion.rows.length !== 1 ||
        !row ||
        row.release_id !== manifest.releaseId ||
        row.release_environment !== environment ||
        Number(row.required_migration_count) !== REQUIRED_MIGRATION_FILES.length ||
        !['applied', 'already_applied'].includes(row.financial_migration_status)
      ) {
        return baseReadiness(environment, 'bootstrap_missing', evidenceFields);
      }

      const expected = options.expectedFinancialEvidence ?? (await expectedFinancialEvidence());
      if (
        expected.length !== NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.length ||
        expected.some(
          (entry, index) =>
            entry.migrationName !== NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES[index]?.name ||
            !SHA256.test(entry.sha256)
        )
      ) {
        return baseReadiness(environment, 'attestation_unavailable', evidenceFields);
      }
      const observed = await readSchemaEvidence(query);
      const matchedFakeFinancialMigrationCount = matchingEvidenceCount(observed, expected);
      if (
        observed.length !== expected.length ||
        matchedFakeFinancialMigrationCount !== expected.length
      ) {
        return baseReadiness(environment, 'schema_evidence_mismatch', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }

      const expectedCriticalMigrations =
        options.expectedCriticalMigrationEvidence ?? (await expectedCriticalMigrationEvidence());
      if (
        !validExpectedEvidence(
          expectedCriticalMigrations,
          CRITICAL_FINANCIAL_MIGRATIONS.map(({ migrationName }) => migrationName)
        )
      ) {
        return baseReadiness(environment, 'attestation_unavailable', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }
      const appliedCriticalMigrations = await readAppliedCriticalMigrationEvidence(query);
      if (
        !criticalMigrationEvidenceMatches(appliedCriticalMigrations, expectedCriticalMigrations)
      ) {
        return baseReadiness(environment, 'schema_evidence_mismatch', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }

      const expectedOrdinal146 = expectedCriticalMigrations.find(
        ({ migrationName }) => migrationName === '20261014_universal_v1_work_order_command_ports_v1'
      );
      const expectedV12 = expected.find(
        ({ migrationName }) =>
          migrationName ===
          '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
      );
      const expectedSeal = expected.find(
        ({ migrationName }) =>
          migrationName === '20261015_universal_v1_work_order_bootstrap_seal_v1'
      );
      const bootstrapAuthorityEvidence = await readWorkOrderBootstrapAuthorityEvidence(query);
      if (
        !expectedOrdinal146 ||
        !expectedV12 ||
        !expectedSeal ||
        !bootstrapAuthorityEvidence ||
        Number(bootstrapAuthorityEvidence.evidence_row_count) !== 1 ||
        bootstrapAuthorityEvidence.evidence_ordinal146_sha256 !== expectedOrdinal146.sha256 ||
        bootstrapAuthorityEvidence.evidence_v12_sha256 !== expectedV12.sha256 ||
        Number(bootstrapAuthorityEvidence.seal_evidence_row_count) !== 1 ||
        bootstrapAuthorityEvidence.seal_evidence_sha256 !== expectedSeal.sha256 ||
        bootstrapAuthorityEvidence.seal_evidence_ordinal146_sha256 !== expectedOrdinal146.sha256 ||
        bootstrapAuthorityEvidence.seal_evidence_v12_sha256 !== expectedV12.sha256
      ) {
        return baseReadiness(environment, 'schema_evidence_mismatch', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }

      const roles = configuredWorkOrderCommandRoles(options.env);
      const expectedRuntimeRole =
        options.component === 'backend'
          ? roles.apiRole
          : options.component === 'worker'
            ? roles.workerRole
            : roles.migrationRole;
      const expectedDatabase = options.env.HX_RUNTIME_DATABASE_NAME?.trim();
      const expectedV13 = expected.find(
        ({ migrationName }) =>
          migrationName === '20261016_universal_v1_fake_financial_command_outbox_authority_v13'
      );
      // The sealed reader proves internal receipt consistency. Readiness must also
      // bind that authority to this component, configured database and exact release.
      // The data plane owns the activation barrier before opening this read snapshot.
      if (
        !expectedDatabase ||
        typeof bootstrapAuthorityEvidence.target_authority_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          bootstrapAuthorityEvidence.target_authority_id
        ) ||
        typeof bootstrapAuthorityEvidence.authority_version !== 'number' ||
        !Number.isSafeInteger(bootstrapAuthorityEvidence.authority_version) ||
        bootstrapAuthorityEvidence.authority_version < 1 ||
        bootstrapAuthorityEvidence.session_database_role !== expectedRuntimeRole ||
        bootstrapAuthorityEvidence.target_database_name !== expectedDatabase ||
        bootstrapAuthorityEvidence.observed_database_name !== expectedDatabase ||
        bootstrapAuthorityEvidence.environment !== environment ||
        bootstrapAuthorityEvidence.release_manifest_sha256 !== exactReleaseManifestDigest ||
        !expectedV13 ||
        bootstrapAuthorityEvidence.v13_sql_sha256 !== expectedV13.sha256 ||
        bootstrapAuthorityEvidence.fake_financial_operations_relation !==
          'public.hxos_fake_financial_operations_v1' ||
        bootstrapAuthorityEvidence.fake_financial_operation_events_relation !==
          'public.hxos_fake_financial_operation_events_v1'
      ) {
        return baseReadiness(environment, 'database_authority_violation', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }

      const commandAuthority = await verifyWorkOrderCommandAuthorityInCurrentSnapshot(
        query,
        options.env,
        options.component === 'backend'
          ? 'apiRole'
          : options.component === 'worker'
            ? 'workerRole'
            : 'migrationRole'
      );
      if (commandAuthority.status !== 'READY')
        return baseReadiness(environment, 'database_authority_violation', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      const authorityViolations = [
        ...(await readFinancialReadinessCustodyViolations(query, roles)),
        ...(await readInternalConstraintViolations(query)),
      ];
      if (authorityViolations.length > 0) {
        return baseReadiness(environment, 'database_authority_violation', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }

      const expectedCriticalSchema =
        options.expectedCriticalSchemaEvidence ?? CRITICAL_SCHEMA_EVIDENCE;
      if (!validExpectedSchemaEvidence(expectedCriticalSchema)) {
        return baseReadiness(environment, 'attestation_unavailable', {
          ...evidenceFields,
          matchedFakeFinancialMigrationCount,
        });
      }
      const observedCriticalSchema = await readCriticalSchemaIdentityEvidence(query, roles);
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
