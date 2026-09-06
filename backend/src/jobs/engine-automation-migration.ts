import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files.js';
import { engineMigrationArtifactDigest } from './engine-migration-manifest.js';
import {
  abortMigrationOperation,
  beginConstitutionalBaselineOperation,
  beginLegacyLocationBackfillOperation,
  beginMigrationArtifactOperation,
  completeMigrationExecutionSession,
  completeMigrationOperation,
  assertIssuedMigrationExecutionAuthority,
  assertMigrationExecutionSession,
  assertMigrationExecutionAuthorized,
  authorizeMigrationExecutionPlan,
  type MigrationExecutionAuthority,
  type MigrationExecutionPlanEntry,
  type MigrationExecutionReceipt,
  type MigrationExecutionSession,
} from './migration-execution-authority.js';
import { workerLogger } from '../logger.js';
import {
  assertTaskLocationCryptoConfigured,
  encryptTaskLocation,
} from '../services/TaskLocationCrypto.js';

export const ADD_MISSING_TABLES_V2_MIGRATION = 'add_missing_tables_v2';
export const ENGINE_AUTOMATION_MIGRATION = '20260710_engine_automation_contracts';
export const PROOF_ALIGNMENT_MIGRATION = '20260711_required_proof_alignment';
export const EXPERTISE_SUPPLY_MIGRATION = '20260711_required_expertise_supply';
export const TASK_OUTCOME_CLASSIFICATION_MIGRATION = '20260711_task_outcome_classification';
export const HUSTLER_IDENTITY_LINK_MIGRATION = '20260712_hustler_identity_link';
export const DISPATCH_EXPIRY_PAYMENT_CANCEL_MIGRATION =
  '20260712_dispatch_expiry_pending_payment_cancel';
export const DISPATCH_EXPIRY_NO_PAYMENT_RECONCILE_MIGRATION =
  '20260712_dispatch_expiry_no_payment_reconcile';
export const PERFORMANCE_INDEX_ALIGNMENT_MIGRATION = 'performance_indexes_v1';
export const CHARGEBACK_LIFECYCLE_MIGRATION = 'chargeback_lifecycle_v1';
export const REVENUE_AUDIT_RAIL_MIGRATION = '20260718_revenue_audit_rail';
export const QUOTE_ECONOMICS_CONTRACT_MIGRATION = '20260718_quote_economics_contract';
export const TASK_SCOPE_VERSIONS_MIGRATION = '20260718_task_scope_versions';
export const TASK_LOCATION_ENCRYPTION_MIGRATION = '20260718_task_location_encryption';
export const PROOF_SUBMISSION_ATOMICITY_MIGRATION = '20260718_proof_submission_atomicity';
export const TASK_SAFETY_INCIDENT_CASES_MIGRATION = '20260718_task_safety_incident_cases';
export const TASK_SAFETY_DELIVERY_CONTRACT_MIGRATION = '20260718_task_safety_delivery_contract';
export const TASK_SAFETY_CHECKINS_MIGRATION = '20260718_task_safety_checkins';
export const TASK_SAFETY_LOCATION_ENCRYPTION_MIGRATION = '20260718_task_safety_location_encryption';
export const ZONE_CATEGORY_LIQUIDITY_CELLS_MIGRATION = '20260718_zone_category_liquidity_cells';
export const WORKER_OFFER_DECISION_CONTRACT_MIGRATION = '20260718_worker_offer_decision_contract';
export const WORKER_SCREENING_RIGHTS_CONTRACT_MIGRATION =
  '20260718_worker_screening_rights_contract';
export const REGION_POLICY_CONTRACT_MIGRATION = '20260718_region_policy_contract';
export const COMPLETION_RETENTION_CONTRACT_MIGRATION = '20260718_completion_retention_contract';
export const TASK_PUBLIC_CLARIFICATIONS_MIGRATION = '20260718_task_public_clarifications';
export const MARKETPLACE_REPUTATION_CONTRACT_MIGRATION = '20260718_marketplace_reputation_contract';
export const BUSINESS_WORKSPACE_CONTRACT_MIGRATION = '20260718_business_workspace_contract';
export const BUSINESS_OPERATIONS_CONTRACT_MIGRATION = '20260718_business_operations_contract';
export const BUSINESS_EXECUTION_CONTRACT_MIGRATION = '20260718_business_execution_contract';
export const RECURRING_WORK_CONTRACT_MIGRATION = '20260718_recurring_work_contract';
export const BUSINESS_RECURRING_CONTRACT_MIGRATION = '20260718_business_recurring_contract';
export const RECOMMENDATION_CONTRACT_MIGRATION = '20260719_recommendation_contract';
export const HUSTLER_WALLET_CONTRACT_MIGRATION = '20260719_hustler_wallet_contract';
export const WALLET_PROVIDER_EVENT_INTEGRITY_MIGRATION = '20260719_wallet_provider_event_integrity';
export const WALLET_PROVIDER_EVENT_INTEGRITY_REPAIR_MIGRATION =
  '20260719_wallet_provider_event_integrity_repair';
export const LIFECYCLE_SERVICE_FOUNDATIONS_MIGRATION = '20260719_lifecycle_service_foundations';
export const TASK_WORKER_ELIGIBILITY_CONTRACT_MIGRATION =
  '20260719_task_worker_eligibility_contract';
export const APPEND_ONLY_TRUNCATE_CONTRACT_MIGRATION = '20260719_append_only_truncate_contract';
export const ADMIN_USER_SEARCH_TRIGRAM_CONTRACT_MIGRATION =
  '20260719_admin_user_search_trigram_contract';
export const ADMIN_CAPABILITY_CONTRACT_MIGRATION = '20260719_admin_capability_contract';
export const TIER0_BROWSE_ONLY_CONTRACT_MIGRATION = '20260719_tier0_browse_only_contract';
export const TASK_TEMPLATE_POLICY_CONTRACT_MIGRATION = '20260719_task_template_policy_contract';
export const COMPLIANCE_GUARDIAN_PERSISTENCE_CONTRACT_MIGRATION =
  '20260719_compliance_guardian_persistence_contract';
export const WORKER_OFFER_RETAKE_CONTRACT_MIGRATION = '20260719_worker_offer_retake_contract';
export const LIQUIDITY_EXPANSION_CONTRACT_MIGRATION = '20260719_liquidity_expansion_contract';
export const LIQUIDITY_EXPANSION_FK_REPAIR_MIGRATION = '20260719_liquidity_expansion_fk_repair';
export const WORKER_COUNTER_OFFER_CONTRACT_MIGRATION = '20260719_worker_counter_offer_contract';
export const WORKER_COUNTER_OFFER_EXCLUSIVITY_MIGRATION =
  '20260719_worker_counter_offer_exclusivity';
export const EXTERNAL_TASK_BRIDGE_CONTRACT_MIGRATION = '20260719_external_task_bridge_contract';
export const TASK_GEOFENCE_EVENT_CONTRACT_MIGRATION = '20260720_task_geofence_event_contract';
export const MAJOR_ACTION_TELEMETRY_CONTRACT_MIGRATION = '20260720_major_action_telemetry_contract';
export const MAJOR_ACTION_TELEMETRY_CONTRACT_REPAIR_MIGRATION =
  '20260720_major_action_telemetry_contract_repair';
export const MAJOR_ACTION_SOURCE_REGISTRY_REPAIR_MIGRATION =
  '20260720_major_action_source_registry_repair';
export const OFFLINE_ACTION_SYNC_CONTRACT_MIGRATION = '20260720_offline_action_sync_contract';
export const OFFLINE_ACTION_SYNC_CONTRACT_REPAIR_MIGRATION =
  '20260720_offline_action_sync_contract_repair';
export const PROOF_VERIFICATION_SIGNAL_CONTRACT_MIGRATION =
  '20260720_proof_verification_signal_contract';
export const PROOF_MEDIA_METADATA_MINIMIZATION_MIGRATION =
  '20260720_proof_media_metadata_minimization';
export const MEDIA_UPLOAD_FINALIZATION_CONTRACT_MIGRATION =
  '20260720_media_upload_finalization_contract';
export const PRIVATE_MEDIA_DELIVERY_CONTRACT_MIGRATION = '20260720_private_media_delivery_contract';
export const WORKER_STANDING_APPEALS_MIGRATION = '20260720_worker_standing_appeals';
export const OFFLINE_ACTION_RECONCILIATION_MIGRATION = '20260720_offline_action_reconciliation';
export const DISPUTE_RELEASE_AUTHORITY_CONTRACT_MIGRATION =
  '20260720_dispute_release_authority_contract';
export const NOTIFICATION_DELIVERY_CONTRACT_MIGRATION = '20260720_notification_delivery_contract';
export const NOTIFICATION_DELIVERY_CONTRACT_REPAIR_MIGRATION =
  '20260720_notification_delivery_contract_repair';
export const NOTIFICATION_FOCUS_SUPPRESSION_MIGRATION = '20260720_notification_focus_suppression';
export const SCHEMA_CONVERGENCE_REPAIR_MIGRATION = '20260720_schema_convergence_repair';
export const LOCAL_CERTIFICATION_PAYMENT_PROVIDER_MIGRATION =
  '20260720_local_certification_payment_provider';
export const REGION_POLICY_PRICE_BOOK_ALIGNMENT_MIGRATION =
  '20260720_region_policy_price_book_alignment';
export const LOCAL_CERTIFICATION_PAYOUT_PROVIDER_MIGRATION =
  '20260720_local_certification_payout_provider';
export const LOCAL_CERTIFICATION_SCREENING_PROVIDER_MIGRATION =
  '20260720_local_certification_screening_provider';
export const CONTROLLED_TEST_LIQUIDITY_CELL_MIGRATION = '20260720_controlled_test_liquidity_cell';
export const CONTROLLED_TEST_LIQUIDITY_MARKER_REPAIR_MIGRATION =
  '20260720_controlled_test_liquidity_marker_repair';
export const CONTROLLED_TEST_LIQUIDITY_LIFECYCLE_REPAIR_MIGRATION =
  '20260720_controlled_test_liquidity_lifecycle_repair';
export const CONTROLLED_TEST_DURATION_EVIDENCE_MIGRATION =
  '20260720_controlled_test_duration_evidence';
export const CONTROLLED_TEST_PROVIDER_CAPABILITY_MIGRATION =
  '20260720_controlled_test_provider_capability';
export const CONTROLLED_TEST_PROVIDER_CAPABILITY_EXPIRY_MIGRATION =
  '20260720_controlled_test_provider_capability_expiry';
export const CONTROLLED_TEST_PROVIDER_CAPABILITY_REFRESH_MIGRATION =
  '20260720_controlled_test_provider_capability_refresh';
export const CONTROLLED_TEST_PROVIDER_CAPABILITY_REFRESH_REPAIR_MIGRATION =
  '20260720_controlled_test_provider_capability_refresh_repair';
export const CONTROLLED_TEST_OFFER_REVIEW_MIGRATION = '20260720_controlled_test_offer_review';
export const TASK_SAFETY_STATE_INTEGRITY_MIGRATION = '20260720_task_safety_state_integrity';
export const TASK_SAFETY_RESOLUTION_INTEGRITY_MIGRATION =
  '20260720_task_safety_resolution_integrity';
export const TASK_SAFETY_CASE_ACCESS_INTEGRITY_MIGRATION =
  '20260720_task_safety_case_access_integrity';
export const OPERATIONS_EXCEPTION_CONTRACT_MIGRATION = '20260720_operations_exception_contract';
export const HUSTLER_TRUST_PROGRESSION_CONTRACT_MIGRATION =
  '20260721_hustler_trust_progression_contract';
export const TASK_QUOTE_SHORTLIST_MESSAGING_CONTRACT_MIGRATION =
  '20260721_task_quote_shortlist_messaging_contract';
export const UNIT_ECONOMICS_GUARDRAILS_MIGRATION = '20260721_unit_economics_guardrails';
export const BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_MIGRATION =
  '20260721_build_now_spend_promotion_guardrails';
export const PRIVATE_IDENTITY_VERIFICATION_CONTRACT_MIGRATION =
  '20260721_private_identity_verification_contract';
export const SENSITIVE_MEDIA_INGESTION_SHUTDOWN_MIGRATION =
  '20260721_sensitive_media_ingestion_shutdown';
export const AI_OBSERVABILITY_CONTRACT_MIGRATION = '20260721_ai_observability_contract';
export const CONTROLLED_TEST_RETAKE_ACCEPTANCE_REPAIR_MIGRATION =
  '20260721_controlled_test_retake_acceptance_repair';
export const CONTROLLED_TEST_RETAKE_LIQUIDITY_REPAIR_MIGRATION =
  '20260721_controlled_test_retake_liquidity_repair';
export const CONTROLLED_TEST_RETAKE_GUARD_CONVERGENCE_MIGRATION =
  '20260721_controlled_test_retake_guard_convergence';
export const SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION =
  '20260721_same_worker_retake_assignment_guard_repair';
export const REGION_POLICY_LEGAL_APPROVAL_ACTIVATION_MIGRATION =
  '20260722_region_policy_legal_approval_activation';
export const RECURRING_PAYMENT_DISPATCH_GATE_MIGRATION = '20260722_recurring_payment_dispatch_gate';
export const SERVICE_BUSINESS_ASSIGNMENT_CONTRACT_MIGRATION =
  '20260722_service_business_assignment_contract';

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
};

export interface MigrationClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<QueryResult<Row>>;
}

export interface MigrationRuntime {
  databaseUrl: string;
  bootstrapSpec?: MigrationSpec;
  migrationSpecs: MigrationSpec[];
  readText(filePath: string): Promise<string>;
  createClient(databaseUrl: string): MigrationClient;
}

export type MigrationSpec = {
  name: string;
  candidatePaths: string[];
};

export type MigrationOutcome = {
  status: 'applied' | 'already_applied';
  migration: string;
  sourcePath: string;
  sha256: string;
};

const CONSTITUTIONAL_BASELINE_RECEIPT_TABLE = 'public.hustlexp_constitutional_baseline_receipts';
const CONSTITUTIONAL_BASELINE_RECEIPT_VERSION = 1;
const CONSTITUTIONAL_BASELINE_APPLIED_FROM_EMPTY = 'APPLIED_FROM_EMPTY';
const CONSTITUTIONAL_BASELINE_LEGACY_RECONCILED = 'LEGACY_CATALOG_RECONCILED';
const SHA256_HEX = /^[0-9a-f]{64}$/u;

interface ConstitutionalBaselineReceiptRow extends Record<string, unknown> {
  receipt_count: number | string;
  singleton_true: boolean | null;
  receipt_version: number | string | null;
  baseline_name: string | null;
  baseline_sha256: string | null;
  provenance: string | null;
  reconciliation_sha256: string | null;
  schema_versions_exists: boolean;
  immutable_trigger_count: number | string;
  rejection_function_exists: boolean;
  applied_at_present: boolean | null;
}

function migrationSqlSha256(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function constitutionalBaselineReceiptTableExists(client: MigrationClient): Promise<boolean> {
  const result = await client.query<{ receipt_table_exists: boolean }>(
    `SELECT to_regclass('${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE}') IS NOT NULL
       AS receipt_table_exists`
  );
  if (result.rows.length !== 1 || typeof result.rows[0]?.receipt_table_exists !== 'boolean') {
    throw new Error('CONSTITUTIONAL_BASELINE_RECEIPT_TABLE_READBACK_INVALID');
  }
  return result.rows[0].receipt_table_exists;
}

async function assertExactConstitutionalBaselineReceipt(
  client: MigrationClient,
  baseline: MigrationExecutionPlanEntry
): Promise<void> {
  const result = await client.query<ConstitutionalBaselineReceiptRow>(`
    SELECT COUNT(*)::integer AS receipt_count,
           BOOL_AND(singleton IS TRUE) AS singleton_true,
           MIN(receipt_version)::integer AS receipt_version,
           MIN(baseline_name)::text AS baseline_name,
           MIN(baseline_sha256)::text AS baseline_sha256,
           MIN(provenance)::text AS provenance,
           MIN(reconciliation_sha256)::text AS reconciliation_sha256,
           to_regclass('public.schema_versions') IS NOT NULL AS schema_versions_exists,
           (
             SELECT COUNT(*)::integer
             FROM pg_catalog.pg_trigger
             WHERE tgrelid = '${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE}'::regclass
               AND NOT tgisinternal
               AND tgname IN (
                 'hustlexp_constitutional_baseline_receipts_no_update_delete',
                 'hustlexp_constitutional_baseline_receipts_no_truncate'
               )
           ) AS immutable_trigger_count,
           to_regprocedure(
             'public.reject_hustlexp_constitutional_baseline_receipt_mutation()'
           ) IS NOT NULL AS rejection_function_exists,
           BOOL_AND(applied_at IS NOT NULL) AS applied_at_present
    FROM ${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE}
  `);
  if (result.rows.length !== 1) {
    throw new Error('CONSTITUTIONAL_BASELINE_RECEIPT_READBACK_INVALID');
  }
  const row = result.rows[0];
  const receiptCount = Number(row?.receipt_count);
  const receiptVersion = Number(row?.receipt_version);
  const immutableTriggerCount = Number(row?.immutable_trigger_count);
  const provenanceValid =
    row?.provenance === CONSTITUTIONAL_BASELINE_APPLIED_FROM_EMPTY
      ? row.reconciliation_sha256 === null
      : row?.provenance === CONSTITUTIONAL_BASELINE_LEGACY_RECONCILED &&
        typeof row.reconciliation_sha256 === 'string' &&
        SHA256_HEX.test(row.reconciliation_sha256);
  if (
    receiptCount !== 1 ||
    row?.singleton_true !== true ||
    receiptVersion !== CONSTITUTIONAL_BASELINE_RECEIPT_VERSION ||
    row?.baseline_name !== baseline.name ||
    row?.baseline_sha256 !== migrationSqlSha256(baseline.sql) ||
    !provenanceValid ||
    row?.schema_versions_exists !== true ||
    immutableTriggerCount !== 2 ||
    row?.rejection_function_exists !== true ||
    row?.applied_at_present !== true
  ) {
    throw new Error('CONSTITUTIONAL_BASELINE_RECEIPT_MISMATCH');
  }
}

async function assertConstitutionalBaselineTargetIsEmpty(client: MigrationClient): Promise<void> {
  const result = await client.query<{ user_objects_exist: boolean }>(`
    SELECT (
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace
        WHERE nspname <> 'public'
          AND nspname <> 'information_schema'
          AND nspname !~ '^pg_'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc routine
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'public'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_type data_type
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = data_type.typnamespace
        WHERE namespace.nspname = 'public'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_extension
        WHERE extname <> 'plpgsql'
      )
    ) AS user_objects_exist
  `);
  if (result.rows.length !== 1 || typeof result.rows[0]?.user_objects_exist !== 'boolean') {
    throw new Error('CONSTITUTIONAL_BASELINE_EMPTY_CATALOG_READBACK_INVALID');
  }
  if (result.rows[0].user_objects_exist) {
    throw new Error(
      'CONSTITUTIONAL_BASELINE_PROVENANCE_MISSING:LEGACY_CATALOG_RECONCILIATION_REQUIRED'
    );
  }
}

const CONSTITUTIONAL_BASELINE_RECEIPT_DDL = `
  CREATE TABLE ${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE} (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE),
    receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
    baseline_name TEXT NOT NULL CHECK (length(baseline_name) BETWEEN 1 AND 256),
    baseline_sha256 CHAR(64) NOT NULL CHECK (baseline_sha256 ~ '^[0-9a-f]{64}$'),
    provenance TEXT NOT NULL CHECK (
      provenance IN ('APPLIED_FROM_EMPTY', 'LEGACY_CATALOG_RECONCILED')
    ),
    reconciliation_sha256 CHAR(64),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      (provenance = 'APPLIED_FROM_EMPTY' AND reconciliation_sha256 IS NULL)
      OR (
        provenance = 'LEGACY_CATALOG_RECONCILED'
        AND reconciliation_sha256 ~ '^[0-9a-f]{64}$'
      )
    )
  );

  CREATE FUNCTION public.reject_hustlexp_constitutional_baseline_receipt_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $baseline_receipt_guard$
  BEGIN
    RAISE EXCEPTION 'HXBASELINE1: constitutional baseline receipt is immutable'
      USING ERRCODE = 'P0001';
  END;
  $baseline_receipt_guard$;

  CREATE TRIGGER hustlexp_constitutional_baseline_receipts_no_update_delete
  BEFORE UPDATE OR DELETE ON ${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE}
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_hustlexp_constitutional_baseline_receipt_mutation();

  CREATE TRIGGER hustlexp_constitutional_baseline_receipts_no_truncate
  BEFORE TRUNCATE ON ${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE}
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.reject_hustlexp_constitutional_baseline_receipt_mutation();

  REVOKE INSERT, UPDATE, DELETE, TRUNCATE
    ON ${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE} FROM PUBLIC;
  REVOKE ALL
    ON FUNCTION public.reject_hustlexp_constitutional_baseline_receipt_mutation() FROM PUBLIC;
`;

export async function backfillLegacyTaskLocations(
  client: MigrationClient,
  session: MigrationExecutionSession
): Promise<number> {
  const permit = await beginLegacyLocationBackfillOperation(session, client);
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const legacy = await client.query<{ task_id: string; exact_location: string }>(
      `SELECT task_id::text, exact_location
       FROM task_location_vault
       WHERE exact_location IS NOT NULL
       ORDER BY task_id
       FOR UPDATE`
    );
    for (const row of legacy.rows) {
      const encrypted = encryptTaskLocation(row.task_id, row.exact_location);
      await client.query(
        `UPDATE task_location_vault
         SET exact_location = NULL,
             location_ciphertext = $2,
             location_nonce = $3,
             location_auth_tag = $4,
             location_key_id = $5,
             location_fingerprint = $6
         WHERE task_id = $1 AND exact_location IS NOT NULL`,
        [
          row.task_id,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyId,
          encrypted.fingerprint,
        ]
      );
    }
    // A failed COMMIT has an unknown server outcome. Clear rollback authority
    // before sending it so no later SQL is issued on an ambiguous session.
    transactionStarted = false;
    await client.query('COMMIT');
    completeMigrationOperation(session, permit, client);
    return legacy.rows.length;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    abortMigrationOperation(session, permit, client);
    throw error;
  }
}

export function productionMigrationRuntime(): MigrationRuntime {
  const cwd = process.cwd();
  return {
    databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
    bootstrapSpec: {
      name: 'constitutional_schema_v1',
      candidatePaths: [
        path.join(cwd, 'backend/database/constitutional-schema.sql'),
        path.join('/app/backend/database/constitutional-schema.sql'),
      ],
    },
    migrationSpecs: REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [
        path.join(cwd, 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ],
    })),
    readText: (filePath) => readFile(filePath, 'utf8'),
    createClient: (databaseUrl): MigrationClient => {
      const client = new Client({ connectionString: databaseUrl });
      return {
        connect: async () => {
          await client.connect();
        },
        end: () => client.end(),
        query: (sql, values) => client.query(sql, values),
      };
    },
  };
}

export async function ensureConstitutionalBaseline(
  client: MigrationClient,
  baseline: MigrationExecutionPlanEntry | undefined,
  session: MigrationExecutionSession
): Promise<void> {
  if (!baseline) return;
  const permit = await beginConstitutionalBaselineOperation(session, baseline, client);
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('hustlexp-constitutional-bootstrap'))`
    );

    if (await constitutionalBaselineReceiptTableExists(client)) {
      await assertExactConstitutionalBaselineReceipt(client, baseline);
      transactionStarted = false;
      await client.query('COMMIT');
      completeMigrationOperation(session, permit, client);
      return;
    }

    // schema_versions alone cannot attest which baseline bytes created the
    // catalog. Only an empty catalog may receive a new APPLIED_FROM_EMPTY
    // receipt here; legacy catalogs require a separately reviewed catalog
    // reconciler and LEGACY_CATALOG_RECONCILED receipt.
    await assertConstitutionalBaselineTargetIsEmpty(client);
    await client.query(baseline.sql);
    await client.query(CONSTITUTIONAL_BASELINE_RECEIPT_DDL);
    await client.query(
      `INSERT INTO ${CONSTITUTIONAL_BASELINE_RECEIPT_TABLE} (
         singleton,
         receipt_version,
         baseline_name,
         baseline_sha256,
         provenance,
         reconciliation_sha256
       ) VALUES (TRUE, $1, $2, $3, $4, NULL)`,
      [
        CONSTITUTIONAL_BASELINE_RECEIPT_VERSION,
        baseline.name,
        migrationSqlSha256(baseline.sql),
        CONSTITUTIONAL_BASELINE_APPLIED_FROM_EMPTY,
      ]
    );
    await assertExactConstitutionalBaselineReceipt(client, baseline);
    transactionStarted = false;
    await client.query('COMMIT');
    completeMigrationOperation(session, permit, client);
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    abortMigrationOperation(session, permit, client);
    throw error;
  }
}

export interface AuthorizedEngineMigrationPlan {
  session: MigrationExecutionSession;
  baseline?: MigrationExecutionPlanEntry;
  migrations: readonly MigrationExecutionPlanEntry[];
}

export interface EngineMigrationExecutionResult {
  outcomes: MigrationOutcome[];
  receipt: MigrationExecutionReceipt;
}

export async function loadMigrationSql(
  runtime: MigrationRuntime,
  spec: MigrationSpec = runtime.migrationSpecs[0]
): Promise<{ sql: string; sourcePath: string }> {
  const failures: Array<{ path: string; reason: string }> = [];
  for (const candidate of spec.candidatePaths) {
    try {
      const sql = await runtime.readText(candidate);
      if (sql.trim()) return { sql, sourcePath: candidate };
      failures.push({ path: candidate, reason: 'empty_file' });
    } catch (error) {
      failures.push({
        path: candidate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(`Required migration ${spec.name} is unavailable: ${JSON.stringify(failures)}`);
}

export async function applyEngineAutomationMigration(
  client: MigrationClient,
  sql: string,
  sourcePath: string,
  session: MigrationExecutionSession,
  migrationName: string = ENGINE_AUTOMATION_MIGRATION
): Promise<MigrationOutcome> {
  const permit = await beginMigrationArtifactOperation(
    session,
    { name: migrationName, sql, sourcePath },
    client
  );
  const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex');
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [migrationName]);
    await client.query(`CREATE TABLE IF NOT EXISTS public.applied_migrations (
      name TEXT PRIMARY KEY,
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(
      'ALTER TABLE public.applied_migrations ADD COLUMN IF NOT EXISTS sha256 CHAR(64)'
    );
    const existing = await client.query<{ name: string; sha256: string | null }>(
      'SELECT name, sha256 FROM public.applied_migrations WHERE name = $1',
      [migrationName]
    );
    if (existing.rows.length > 0) {
      const recordedSha256 = existing.rows[0]?.sha256?.trim();
      if (!recordedSha256) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISSING: ${migrationName} requires explicit checksum reconciliation`
        );
      }
      if (recordedSha256 !== sha256) {
        throw new Error(
          `MIGRATION_CHECKSUM_DRIFT: ${migrationName} recorded ${recordedSha256} but exact SQL is ${sha256}`
        );
      }
      transactionStarted = false;
      await client.query('COMMIT');
      completeMigrationOperation(session, permit, client);
      return { status: 'already_applied', migration: migrationName, sourcePath, sha256 };
    }

    await client.query(sql);
    await client.query(
      'INSERT INTO public.applied_migrations (name, sha256) VALUES ($1, $2)',
      [migrationName, sha256]
    );
    transactionStarted = false;
    await client.query('COMMIT');
    completeMigrationOperation(session, permit, client);
    return { status: 'applied', migration: migrationName, sourcePath, sha256 };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    abortMigrationOperation(session, permit, client);
    throw error;
  }
}

export async function authorizeEngineAutomationMigrationPlanOnConnectedClient(
  client: MigrationClient,
  runtime: MigrationRuntime,
  authority: MigrationExecutionAuthority
): Promise<AuthorizedEngineMigrationPlan> {
  assertIssuedMigrationExecutionAuthority(authority);
  const baseline = runtime.bootstrapSpec
    ? {
        name: runtime.bootstrapSpec.name,
        ...(await loadMigrationSql(runtime, runtime.bootstrapSpec)),
      }
    : undefined;
  const migrations = await Promise.all(
    runtime.migrationSpecs.map(async (spec) => ({
      name: spec.name,
      ...(await loadMigrationSql(runtime, spec)),
    }))
  );
  const session = authorizeMigrationExecutionPlan(authority, {
    databaseUrl: runtime.databaseUrl,
    client,
    migrations,
    ...(baseline ? { baseline } : {}),
  });
  assertMigrationExecutionSession(session);
  return Object.freeze({
    session,
    ...(baseline ? { baseline } : {}),
    migrations: Object.freeze(migrations),
  });
}

export async function runEngineAutomationMigrationsOnConnectedClientWithReceipt(
  client: MigrationClient,
  runtime: MigrationRuntime,
  authority: MigrationExecutionAuthority
): Promise<EngineMigrationExecutionResult> {
  const plan = await authorizeEngineAutomationMigrationPlanOnConnectedClient(
    client,
    runtime,
    authority
  );
  assertTaskLocationCryptoConfigured();
  await ensureConstitutionalBaseline(client, plan.baseline, plan.session);
  const outcomes: MigrationOutcome[] = [];
  for (const migration of plan.migrations) {
    const outcome = await applyEngineAutomationMigration(
      client,
      migration.sql,
      migration.sourcePath,
      plan.session,
      migration.name
    );
    outcomes.push(outcome);
    workerLogger.info(outcome, 'Required engine migration verified');
  }
  const backfilledLocationCount = await backfillLegacyTaskLocations(client, plan.session);
  workerLogger.info(
    { backfilledLocationCount },
    'Legacy exact-location encryption backfill verified'
  );
  const receipt = completeMigrationExecutionSession(plan.session, client);
  return { outcomes, receipt };
}

export async function runEngineAutomationMigrationsOnConnectedClient(
  client: MigrationClient,
  runtime: MigrationRuntime,
  authority: MigrationExecutionAuthority
): Promise<MigrationOutcome[]> {
  return (
    await runEngineAutomationMigrationsOnConnectedClientWithReceipt(client, runtime, authority)
  ).outcomes;
}

export async function runEngineAutomationMigrationWithReceipt(
  runtime: MigrationRuntime = productionMigrationRuntime()
): Promise<EngineMigrationExecutionResult> {
  if (!runtime.databaseUrl) {
    throw new Error('DATABASE_URL is required before applying engine automation contracts');
  }
  const migrationArtifactDigest = await engineMigrationArtifactDigest();
  const authority = assertMigrationExecutionAuthorized({
    migrationArtifactDigest,
    databaseUrl: runtime.databaseUrl,
  });
  assertTaskLocationCryptoConfigured();
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    return await runEngineAutomationMigrationsOnConnectedClientWithReceipt(
      client,
      runtime,
      authority
    );
  } catch (error) {
    workerLogger.fatal({ err: error }, 'Required engine migration failed');
    throw error;
  } finally {
    await client.end();
  }
}

export async function runEngineAutomationMigration(
  runtime: MigrationRuntime = productionMigrationRuntime()
): Promise<MigrationOutcome[]> {
  return (await runEngineAutomationMigrationWithReceipt(runtime)).outcomes;
}
