import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files.js';
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
export const PRIVATE_MEDIA_DELIVERY_CONTRACT_MIGRATION =
  '20260720_private_media_delivery_contract';
export const WORKER_STANDING_APPEALS_MIGRATION = '20260720_worker_standing_appeals';
export const OFFLINE_ACTION_RECONCILIATION_MIGRATION =
  '20260720_offline_action_reconciliation';
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
export const OPERATIONS_EXCEPTION_CONTRACT_MIGRATION =
  '20260720_operations_exception_contract';
export const HUSTLER_TRUST_PROGRESSION_CONTRACT_MIGRATION =
  '20260721_hustler_trust_progression_contract';
export const TASK_QUOTE_SHORTLIST_MESSAGING_CONTRACT_MIGRATION =
  '20260721_task_quote_shortlist_messaging_contract';
export const UNIT_ECONOMICS_GUARDRAILS_MIGRATION =
  '20260721_unit_economics_guardrails';
export const BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_MIGRATION =
  '20260721_build_now_spend_promotion_guardrails';
export const PRIVATE_IDENTITY_VERIFICATION_CONTRACT_MIGRATION =
  '20260721_private_identity_verification_contract';
export const SENSITIVE_MEDIA_INGESTION_SHUTDOWN_MIGRATION =
  '20260721_sensitive_media_ingestion_shutdown';
export const AI_OBSERVABILITY_CONTRACT_MIGRATION =
  '20260721_ai_observability_contract';
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
};

export async function backfillLegacyTaskLocations(client: MigrationClient): Promise<number> {
  await client.query('BEGIN');
  try {
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
    await client.query('COMMIT');
    return legacy.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
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
    createClient: (databaseUrl) => new Client({ connectionString: databaseUrl }) as MigrationClient,
  };
}

async function ensureConstitutionalBaseline(
  client: MigrationClient,
  runtime: MigrationRuntime
): Promise<void> {
  if (!runtime.bootstrapSpec) return;
  const present = await client.query<{ baseline_exists: boolean }>(
    `SELECT to_regclass('public.schema_versions') IS NOT NULL AS baseline_exists`
  );
  if (present.rows[0]?.baseline_exists) return;

  const baseline = await loadMigrationSql(runtime, runtime.bootstrapSpec);
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('hustlexp-constitutional-bootstrap'))`
    );
    const recheck = await client.query<{ baseline_exists: boolean }>(
      `SELECT to_regclass('public.schema_versions') IS NOT NULL AS baseline_exists`
    );
    if (!recheck.rows[0]?.baseline_exists) await client.query(baseline.sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
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
  migrationName: string = ENGINE_AUTOMATION_MIGRATION
): Promise<MigrationOutcome> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [migrationName]);
    await client.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const existing = await client.query<{ name: string }>(
      'SELECT name FROM applied_migrations WHERE name = $1',
      [migrationName]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { status: 'already_applied', migration: migrationName, sourcePath };
    }

    await client.query(sql);
    await client.query('INSERT INTO applied_migrations (name) VALUES ($1)', [migrationName]);
    await client.query('COMMIT');
    return { status: 'applied', migration: migrationName, sourcePath };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runEngineAutomationMigration(
  runtime: MigrationRuntime = productionMigrationRuntime()
): Promise<MigrationOutcome[]> {
  if (!runtime.databaseUrl) {
    throw new Error('DATABASE_URL is required before applying engine automation contracts');
  }
  assertTaskLocationCryptoConfigured();
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    await ensureConstitutionalBaseline(client, runtime);
    const outcomes: MigrationOutcome[] = [];
    for (const spec of runtime.migrationSpecs) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name
      );
      outcomes.push(outcome);
      workerLogger.info(outcome, 'Required engine migration verified');
    }
    const backfilledLocationCount = await backfillLegacyTaskLocations(client);
    workerLogger.info(
      { backfilledLocationCount },
      'Legacy exact-location encryption backfill verified'
    );
    return outcomes;
  } catch (error) {
    workerLogger.fatal({ err: error }, 'Required engine migration failed');
    throw error;
  } finally {
    await client.end();
  }
}
