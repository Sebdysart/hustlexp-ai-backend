import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { validateMigrationConfig } from '../config.js';
import {
  CONSTITUTIONAL_BOOTSTRAP_FILE,
  REQUIRED_MIGRATION_FILES,
} from './engine-automation-migration-files.js';
import { workerLogger } from '../logger.js';

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
  runtimeDatabaseUrl: string;
  migrationDatabaseUrl: string;
  expectedDatabaseIdentity?: Readonly<{
    database: string;
    databaseOid: string;
    clusterSystemIdentifier: string;
  }>;
  requireExpectedDatabaseIdentity?: boolean;
  bootstrapSpec?: MigrationSpec;
  migrationSpecs: MigrationSpec[];
  requireCanonicalMigrationInventory?: boolean;
  readText(filePath: string): Promise<string>;
  createClient(databaseUrl: string): MigrationClient;
}

export type MigrationSpec = {
  name: string;
  candidatePaths: string[];
};

export type LoadedMigrationSql = {
  sql: string;
  sourcePath: string;
  sourceSha256: string;
};

export type MigrationOutcome = {
  status: 'applied' | 'already_applied';
  migration: string;
  sourcePath: string;
};

export const LEGACY_OUTER_TRANSACTION_MIGRATIONS = Object.freeze({
  '20260718_business_workspace_contract': { fileName: '20260718_business_workspace_contract.sql', sha256: 'a22965906807502d81f7fc6fb085b1f71ee4cf8171986eb61be292dccc137c45' },
  '20260718_business_operations_contract': { fileName: '20260718_business_operations_contract.sql', sha256: '23fdb635e6768e7cfabc299ba4babab7aa37e29d319f124e8cf96e152ff7a0cb' },
  '20260718_business_execution_contract': { fileName: '20260718_business_execution_contract.sql', sha256: 'b4bad697897f51aa69f4c435d194bcb0730e1c357110c56aeeeccc61ec0c8d2d' },
  '20260718_recurring_work_contract': { fileName: '20260718_recurring_work_contract.sql', sha256: '65bbbe96e1af6d909cd9a454c201bf4e62c99e60ec6bddbaa2454a3e3de4ed4b' },
  '20260718_business_recurring_contract': { fileName: '20260718_business_recurring_contract.sql', sha256: 'e068a0aa68b7baf4a7c13f217536251708913b854119a3da350455230355f5d3' },
  '20260719_admin_capability_contract': { fileName: '20260719_admin_capability_contract.sql', sha256: 'cacc11cfe40b498767acbbaa736f2462e21a758018bcda1a667430a3c441c0f4' },
  '20260720_proof_verification_signal_contract': { fileName: '20260720_proof_verification_signal_contract.sql', sha256: '7956522e446ae42141b204c0f32d6cc1843c8deb54d474f5bc3d5687577e18fb' },
  '20260720_proof_media_metadata_minimization': { fileName: '20260720_proof_media_metadata_minimization.sql', sha256: 'd8b3f516a303744ab8bfe467d528f552f0c444466d64ab1e881d6ae5f422e396' },
  '20260720_media_upload_finalization_contract': { fileName: '20260720_media_upload_finalization_contract.sql', sha256: 'c7cb31234baeb3ec101b44a73df6fd93198d3c442ceaa0713188e912bae10715' },
  '20260720_private_media_delivery_contract': { fileName: '20260720_private_media_delivery_contract.sql', sha256: 'dab4cace45c99879d1a6f3e978198fe8ec4e1840607319522b8addfc20cda608' },
  '20260720_schema_convergence_repair': { fileName: '20260720_schema_convergence_repair.sql', sha256: '5151894b324679c19cc7a70179aec8f0248a3c66c5325b97d8bdcf618f684da2' },
  '20260720_controlled_test_liquidity_lifecycle_repair': { fileName: '20260720_controlled_test_liquidity_lifecycle_repair.sql', sha256: 'f921c0c7a374e4a7f4bd0b0a81af34667c52f1264d3f3c0ad57b017e0583e0cc' },
  '20260720_controlled_test_duration_evidence': { fileName: '20260720_controlled_test_duration_evidence.sql', sha256: '9b2b0630d0fa0e24552547940c5ee1097e6b7a32cb5b90f5cc5426a25606ae77' },
  '20260720_controlled_test_provider_capability': { fileName: '20260720_controlled_test_provider_capability.sql', sha256: '079baedf700badc9c00e1e91f83f96d409bee7f713c9e7d349767a92c112fcc1' },
  '20260720_controlled_test_provider_capability_expiry': { fileName: '20260720_controlled_test_provider_capability_expiry.sql', sha256: '770a9973510b499f6e9c1b3428f5ba8dccbbca45c6aef62e463372dcdd2640a5' },
  '20260720_controlled_test_provider_capability_refresh': { fileName: '20260720_controlled_test_provider_capability_refresh.sql', sha256: 'fce9cbe6df1865581bc414ee1d102afe140899a4b3d0f35697c894edfb375011' },
  '20260720_controlled_test_provider_capability_refresh_repair': { fileName: '20260720_controlled_test_provider_capability_refresh_repair.sql', sha256: 'fa0600c70a92f0c25112bded13e6e45c5402bfca9aaea45540c08a9a83edcb9d' },
  '20260720_controlled_test_offer_review': { fileName: '20260720_controlled_test_offer_review.sql', sha256: '29f42e272b46974910354ed0c32db10744ab771aae92bc83b5c70b84aba9d6e1' },
  '20260721_unit_economics_guardrails': { fileName: '20260721_unit_economics_guardrails.sql', sha256: 'f0139e1a336cb37bd3a0a92c64d1aabad7adc2cf11527034b50bf5e3007ea720' },
  '20260721_build_now_spend_promotion_guardrails': { fileName: '20260721_build_now_spend_promotion_guardrails.sql', sha256: 'eff21cecd9f2d714168e989e9bb712ac7b30286f8b0de724f4ca7a7cef8a661d' },
  '20260721_sensitive_media_ingestion_shutdown': { fileName: '20260721_sensitive_media_ingestion_shutdown.sql', sha256: 'c83366b0b5f4c8ccca98ee5a31d95febaa0107f75e0e0ce60cb2d735c503fc20' },
  '20260721_controlled_test_retake_acceptance_repair': { fileName: '20260721_controlled_test_retake_acceptance_repair.sql', sha256: 'a1b2a9eb450a0ac4add500620bbcb6738d708603e794a86fcb8ce311adec8fe5' },
  '20260721_controlled_test_retake_liquidity_repair': { fileName: '20260721_controlled_test_retake_liquidity_repair.sql', sha256: 'edc5ca1a19dbb27ed4ae60efcdfedf2d91a09a86cb2bc0f5cee94bb39837f490' },
  '20260721_controlled_test_retake_guard_convergence': { fileName: '20260721_controlled_test_retake_guard_convergence.sql', sha256: '6a2b108d6fe844e4a0235162f25066427eebb1952dbe41e29e7b483c267472b1' },
  '20260721_same_worker_retake_assignment_guard_repair': { fileName: '20260721_same_worker_retake_assignment_guard_repair.sql', sha256: 'c3500b95949b80004262a9c638f2eca8ef19ad5b446d430aecbe83bc628c7863' },
  '20260722_recurring_payment_dispatch_gate': { fileName: '20260722_recurring_payment_dispatch_gate.sql', sha256: '47c04b2e55a275220c6c1a01fa283628e43fcea869096acd13db8bb59b659c8e' },
  '20260722_service_business_assignment_contract': { fileName: '20260722_service_business_assignment_contract.sql', sha256: '258e56009e35228a4e2ad294d879143f4985bdbae7853d1c3c2c9fcda61777af' },
  '20260814_quote_price_book': { fileName: '20260814_quote_price_book.sql', sha256: '4d49f31e83b6ba5352ee1c16da45e2b7ce8f84a4d5d9ee0b50bee57e2cafed69' },
  '20260814_price_book_quote_decisions': { fileName: '20260814_price_book_quote_decisions.sql', sha256: '77d1a1e17e300f83c1dc7e6f5e57e3ecef617a69066f1806d9d44aea3cf6a4f1' },
  '20260814_task_supply_confidence': { fileName: '20260814_task_supply_confidence.sql', sha256: '5c64425fef6a52b4abb7e00f42f2c7322be9d777b58c1efbb1d8f5bd71815e9e' },
  '20260815_quote_columns_extra_v4': { fileName: '20260815_quote_columns_extra_v4.sql', sha256: '2c45fbed303842c44ee20d24df090e54de05519d9e7ff5e8f74d4283763be7ee' },
  '20260823_business_fulfiller_lifecycle': { fileName: '20260823_business_fulfiller_lifecycle.sql', sha256: '7243c0fa649eea1d7812d5e706b1d9e00c1ecea41536e614fb5848f3afd306dc' },
  '20260823_business_payout_tables': { fileName: '20260823_business_payout_tables.sql', sha256: '6896c70249c363d955fdb3674aac56e0e484262484470f6b9de3316c92f04d1b' },
  '20260824_business_controlled_test_acceptance': { fileName: '20260824_business_controlled_test_acceptance.sql', sha256: '05f363a4581b6488aabd7267bfa1091d884b3e2cd4fb192dcff137a646c33729' },
  '20260824_orchestration_mode': { fileName: '20260824_orchestration_mode.sql', sha256: 'a803c82c5d9f66ccfb70712ef9b9064a5d50d7a710bb65fe7561219ababe6f2c' },
} as const);

export const LEGACY_OUTER_TRANSACTION_MIGRATION_COUNT =
  Object.keys(LEGACY_OUTER_TRANSACTION_MIGRATIONS).length;

type LegacyOuterTransactionMigrationName = keyof typeof LEGACY_OUTER_TRANSACTION_MIGRATIONS;

export const LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES = Object.freeze(
  Object.keys(LEGACY_OUTER_TRANSACTION_MIGRATIONS).sort()
) as readonly LegacyOuterTransactionMigrationName[];

export const LEGACY_OUTER_TRANSACTION_MIGRATION_SHA256 = Object.freeze(
  Object.fromEntries(
    Object.entries(LEGACY_OUTER_TRANSACTION_MIGRATIONS).map(([name, entry]) => [name, entry.sha256])
  )
) as Readonly<Record<LegacyOuterTransactionMigrationName, string>>;

type TopLevelSqlStatement = { text: string; start: number; codeStart: number; end: number };

function sqlParseError(reason: string): never {
  throw new Error(`Migration SQL parsing failed: ${reason}`);
}

function isSqlIdentifierCharacter(value: string | undefined): boolean {
  if (!value) return false;
  const codePoint = value.codePointAt(0);
  return /[A-Za-z0-9_$]/.test(value) || (codePoint !== undefined && codePoint > 0x7f);
}

function topLevelSqlStatements(sql: string): TopLevelSqlStatement[] {
  let masked = '';
  for (let index = 0; index < sql.length;) {
    const start = index;
    const current = sql[index];
    const next = sql[index + 1];
    if (current === '-' && next === '-') {
      const lineTerminator = sql.slice(index + 2).search(/[\r\n]/);
      index = lineTerminator === -1 ? sql.length : index + 2 + lineTerminator;
      masked += ' '.repeat(index - start);
      continue;
    }
    if (current === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) sqlParseError('unterminated block comment');
      masked += ' '.repeat(index - start);
      continue;
    }
    if (current === "'") {
      const prefix = sql[index - 1];
      const beforePrefix = sql[index - 2];
      const escapeString =
        (prefix === 'E' || prefix === 'e')
        && (index === 1 || !isSqlIdentifierCharacter(beforePrefix));
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (escapeString && sql[index] === '\\') {
          if (index + 1 >= sql.length) sqlParseError('unterminated escape string literal');
          index += 2;
        } else if (!escapeString && sql[index] === '\\' && sql[index + 1] === "'") {
          sqlParseError('ambiguous backslash-quote in ordinary string literal');
        } else if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) {
        sqlParseError(
          escapeString ? 'unterminated escape string literal' : 'unterminated string literal'
        );
      }
      masked += ' '.repeat(index - start);
      continue;
    }
    if (current === '"') {
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) sqlParseError('unterminated quoted identifier');
      masked += ' '.repeat(index - start);
      continue;
    }
    if (current === '$') {
      const previous = sql[index - 1];
      const hasTokenBoundary = index === 0 || !isSqlIdentifierCharacter(previous);
      const delimiter = hasTokenBoundary
        ? sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
        : undefined;
      if (delimiter) {
        const closing = sql.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) sqlParseError(`unterminated dollar quote ${delimiter}`);
        index = closing + delimiter.length;
        masked += ' '.repeat(index - start);
        continue;
      }
    }
    masked += current;
    index += 1;
  }

  const statements: TopLevelSqlStatement[] = [];
  let statementStart = 0;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== ';') continue;
    const segment = masked.slice(statementStart, index);
    const text = segment.replace(/\s+/g, ' ').trim();
    const relativeCodeStart = segment.search(/\S/);
    if (text) {
      statements.push({
        text,
        start: statementStart,
        codeStart: statementStart + relativeCodeStart,
        end: index + 1,
      });
    }
    statementStart = index + 1;
  }
  const remainder = masked.slice(statementStart).replace(/\s+/g, ' ').trim();
  if (remainder) {
    const relativeCodeStart = masked.slice(statementStart).search(/\S/);
    statements.push({
      text: remainder,
      start: statementStart,
      codeStart: statementStart + relativeCodeStart,
      end: masked.length,
    });
  }
  if (
    statements.some((statement) =>
      /^COPY\b[\s\S]*\bFROM\s+STDIN(?:\s|$)/i.test(statement.text)
    )
  ) {
    sqlParseError('COPY FROM STDIN is not supported in registered migrations');
  }
  return statements;
}

function transactionControlKind(statement: string): string | null {
  const normalized = statement.toUpperCase();
  const direct = normalized.match(/^(BEGIN|COMMIT|ROLLBACK|ABORT|END|SAVEPOINT)(?:\s|$)/)?.[1];
  if (direct) return direct;
  if (/^(START|PREPARE|SET)\s+TRANSACTION(?:\s|$)/.test(normalized)) {
    return normalized.split(' ', 1)[0];
  }
  if (/^RELEASE\s+SAVEPOINT(?:\s|$)/.test(normalized)) return 'RELEASE';
  return null;
}

function assertNoTopLevelTransactionControl(sql: string): void {
  if (
    topLevelSqlStatements(sql).some(
      (statement) => transactionControlKind(statement.text) !== null
    )
  ) {
    throw new Error('Migration SQL contains top-level transaction control');
  }
}

/**
 * Preserve migration bytes unless an immutable, hash-bound legacy wrapper is
 * removed so the runner's outer transaction remains the sole commit boundary.
 */
export function normalizeMigrationSqlForAtomicApply(
  migrationName: string,
  sql: string,
  sourcePath: string
): string {
  const expected = Object.prototype.hasOwnProperty.call(
    LEGACY_OUTER_TRANSACTION_MIGRATIONS,
    migrationName
  )
    ? LEGACY_OUTER_TRANSACTION_MIGRATIONS[
        migrationName as LegacyOuterTransactionMigrationName
      ]
    : null;
  const statements = topLevelSqlStatements(sql);
  const controls = statements
    .map((statement, index) => ({ statement, index, kind: transactionControlKind(statement.text) }))
    .filter(
      (entry): entry is { statement: TopLevelSqlStatement; index: number; kind: string } =>
        entry.kind !== null
    );

  if (!expected) {
    if (controls.length > 0) {
      throw new Error('Non-allowlisted migration contains top-level transaction control');
    }
    return sql;
  }

  if (path.basename(sourcePath) !== expected.fileName) {
    throw new Error('Immutable legacy migration source-file mismatch');
  }
  const actualHash = createHash('sha256').update(sql, 'utf8').digest('hex');
  if (actualHash !== expected.sha256) {
    throw new Error('Immutable legacy migration hash mismatch');
  }
  if (
    controls.length !== 2
    || controls[0].index !== 0
    || controls[0].kind !== 'BEGIN'
    || controls[0].statement.text.toUpperCase() !== 'BEGIN'
    || controls[1].index !== statements.length - 1
    || controls[1].kind !== 'COMMIT'
    || controls[1].statement.text.toUpperCase() !== 'COMMIT'
  ) {
    throw new Error('Immutable legacy migration transaction wrapper drift');
  }
  return (
    sql.slice(0, controls[0].statement.codeStart)
    + sql.slice(controls[0].statement.end, controls[1].statement.codeStart)
    + sql.slice(controls[1].statement.end)
  );
}

export type RegisteredMigrationSql = Readonly<{
  name: string;
  sourcePath: string;
  sql: string;
}>;

export type LegacyOuterTransactionReconciliation = Readonly<{
  registeredMigrationCount: number;
  wrappedMigrationCount: number;
  allowlistedMigrationCount: number;
  wrappedMigrationNames: readonly string[];
}>;

/**
 * Prove that the immutable exception list is exactly the set of registered
 * files whose parsed SQL has an outer transaction wrapper. Normalization also
 * verifies every exception's source filename and SHA-256, and rejects any
 * other registered file containing top-level transaction control.
 */
export function reconcileLegacyOuterTransactionMigrations(
  migrations: readonly RegisteredMigrationSql[]
): LegacyOuterTransactionReconciliation {
  const registeredNames = new Set<string>();
  const wrappedMigrationNames: string[] = [];
  for (const migration of migrations) {
    if (registeredNames.has(migration.name)) {
      throw new Error('Registered migration inventory contains duplicate names');
    }
    registeredNames.add(migration.name);
    const normalized = normalizeMigrationSqlForAtomicApply(
      migration.name,
      migration.sql,
      migration.sourcePath
    );
    if (normalized !== migration.sql) wrappedMigrationNames.push(migration.name);
  }

  wrappedMigrationNames.sort();
  if (
    wrappedMigrationNames.length !== LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES.length
    || wrappedMigrationNames.some(
      (name, index) => name !== LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES[index]
    )
  ) {
    throw new Error('Registered migration transaction-wrapper inventory mismatch');
  }

  return Object.freeze({
    registeredMigrationCount: migrations.length,
    wrappedMigrationCount: wrappedMigrationNames.length,
    allowlistedMigrationCount: LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES.length,
    wrappedMigrationNames: Object.freeze([...wrappedMigrationNames]),
  });
}

declare const verifiedDatabaseRole: unique symbol;

export type VerifiedDatabaseRole = string & { readonly [verifiedDatabaseRole]: true };

export type DatabaseIdentity = {
  database: string;
  databaseOid: string;
  clusterSystemIdentifier: string;
  role: VerifiedDatabaseRole;
  sessionRole: VerifiedDatabaseRole;
};

async function pinTrustedSessionSearchPath(client: MigrationClient): Promise<void> {
  const result = await client.query<{ trusted_search_path: string }>(
    `SELECT pg_catalog.set_config(
       'search_path',
       'pg_catalog, public',
       false
     ) AS trusted_search_path`
  );
  if (
    result.rows.length !== 1
    || result.rows[0]?.trusted_search_path !== 'pg_catalog, public'
  ) {
    throw new Error('Migration session search_path pin failed');
  }
}

type RecordedDatabaseIdentity = {
  database: string;
  databaseOid: string;
  clusterSystemIdentifier: string;
  migrationOwner: string;
};

export async function readDatabaseIdentity(client: MigrationClient): Promise<DatabaseIdentity> {
  const result = await client.query<{
    database_name: string;
    database_oid: string;
    cluster_system_identifier: string;
    database_role: string;
    session_role: string;
  }>(
    `SELECT
       pg_catalog.current_database() AS database_name,
       database_row.oid::text AS database_oid,
       control.system_identifier::text AS cluster_system_identifier,
       current_user AS database_role,
       session_user AS session_role
     FROM pg_catalog.pg_database database_row
     CROSS JOIN pg_catalog.pg_control_system() control
     WHERE database_row.datname = pg_catalog.current_database()`
  );
  const database = result.rows[0]?.database_name?.trim();
  const databaseOid = result.rows[0]?.database_oid?.trim();
  const clusterSystemIdentifier = result.rows[0]?.cluster_system_identifier?.trim();
  const role = result.rows[0]?.database_role?.trim();
  const sessionRole = result.rows[0]?.session_role?.trim();
  if (!database || !databaseOid || !clusterSystemIdentifier || !role || !sessionRole) {
    throw new Error('Database identity verification failed');
  }
  if (role !== sessionRole) {
    throw new Error('Database identity verification rejected SET ROLE session');
  }
  return {
    database,
    databaseOid,
    clusterSystemIdentifier,
    role: role as VerifiedDatabaseRole,
    sessionRole: sessionRole as VerifiedDatabaseRole,
  };
}

type RuntimeDatabasePrivilegeBoundary = {
  elevated_role: boolean;
  can_create_database_objects: boolean;
  can_create_public_objects: boolean;
  can_create_temporary_objects: boolean;
  can_create_triggers: boolean;
  can_set_session_replication_role: boolean;
  has_role_memberships: boolean;
  owns_database: boolean;
  owns_public_schema: boolean;
  owns_public_objects: boolean;
  replication_role_is_origin: boolean;
};

type MigrationDatabasePrivilegeBoundary = {
  direct_session_identity: boolean;
  login_enabled: boolean;
  inherit_enabled: boolean;
  elevated_role: boolean;
  has_role_memberships: boolean;
  owns_database: boolean;
  owns_public_schema: boolean;
  owns_public_objects: boolean;
  owns_foreign_public_objects: boolean;
  can_connect_database: boolean;
  can_create_database_objects: boolean;
  can_create_temporary_objects: boolean;
  can_use_public_schema: boolean;
  can_create_public_objects: boolean;
  can_set_session_replication_role: boolean;
  replication_role_is_origin: boolean;
};

/**
 * Prove that the authenticated migration login is the only authority in the
 * session, owns the exact target and application catalog, and has no role
 * membership or superuser-style escape hatch. This check deliberately runs
 * before any BEGIN, bootstrap DDL, or ledger mutation.
 */
export async function verifyMigrationDatabasePrivilegeBoundary(
  client: MigrationClient
): Promise<void> {
  const result = await client.query<MigrationDatabasePrivilegeBoundary>(`
    SELECT
      current_user = session_user AS direct_session_identity,
      migration_role.rolcanlogin AS login_enabled,
      migration_role.rolinherit AS inherit_enabled,
      (migration_role.rolsuper
        OR migration_role.rolcreatedb
        OR migration_role.rolcreaterole
        OR migration_role.rolreplication
        OR migration_role.rolbypassrls) AS elevated_role,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members membership
        WHERE membership.member = migration_role.oid
      ) AS has_role_memberships,
      target_database.datdba = migration_role.oid AS owns_database,
      public_schema.nspowner IN (
        migration_role.oid,
        (SELECT role_row.oid
         FROM pg_catalog.pg_roles role_row
         WHERE role_row.rolname = 'pg_database_owner')
      ) AS owns_public_schema,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class class_row
        WHERE class_row.relnamespace = public_schema.oid
          AND class_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND class_row.relowner <> migration_role.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc procedure_row
        WHERE procedure_row.pronamespace = public_schema.oid
          AND procedure_row.proowner <> migration_role.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_type type_row
        WHERE type_row.typnamespace = public_schema.oid
          AND type_row.typrelid = 0
          AND type_row.typcategory <> 'A'
          AND type_row.typowner <> migration_role.oid
      ) AS owns_public_objects,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class class_row
        WHERE class_row.relnamespace = public_schema.oid
          AND class_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND class_row.relowner <> migration_role.oid
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc procedure_row
        WHERE procedure_row.pronamespace = public_schema.oid
          AND procedure_row.proowner <> migration_role.oid
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_type type_row
        WHERE type_row.typnamespace = public_schema.oid
          AND type_row.typrelid = 0
          AND type_row.typcategory <> 'A'
          AND type_row.typowner <> migration_role.oid
      ) AS owns_foreign_public_objects,
      pg_catalog.has_database_privilege(
        current_user,
        pg_catalog.current_database(),
        'CONNECT'
      ) AS can_connect_database,
      pg_catalog.has_database_privilege(
        current_user,
        pg_catalog.current_database(),
        'CREATE'
      ) AS can_create_database_objects,
      pg_catalog.has_database_privilege(
        current_user,
        pg_catalog.current_database(),
        'TEMPORARY'
      ) AS can_create_temporary_objects,
      pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
        AS can_use_public_schema,
      pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
        AS can_create_public_objects,
      pg_catalog.has_parameter_privilege(
        current_user,
        'session_replication_role',
        'SET'
      ) AS can_set_session_replication_role,
      pg_catalog.current_setting('session_replication_role') = 'origin'
        AS replication_role_is_origin
    FROM pg_catalog.pg_roles migration_role
    JOIN pg_catalog.pg_database target_database
      ON target_database.datname = pg_catalog.current_database()
    JOIN pg_catalog.pg_namespace public_schema
      ON public_schema.nspname = 'public'
    WHERE migration_role.rolname = current_user
  `);
  const boundary = result.rows[0];
  if (
    result.rows.length !== 1
    || !boundary
    || !boundary.direct_session_identity
    || !boundary.login_enabled
    || boundary.inherit_enabled
    || boundary.elevated_role
    || boundary.has_role_memberships
    || !boundary.owns_database
    || !boundary.owns_public_schema
    || !boundary.owns_public_objects
    || boundary.owns_foreign_public_objects
    || !boundary.can_connect_database
    || !boundary.can_create_database_objects
    || !boundary.can_create_temporary_objects
    || !boundary.can_use_public_schema
    || !boundary.can_create_public_objects
    || boundary.can_set_session_replication_role
    || !boundary.replication_role_is_origin
  ) {
    throw new Error('Migration database privilege boundary verification failed');
  }
}

/**
 * Reject an unsafe application role before the migrator connects or any
 * bootstrap/migration transaction can begin. The containment migration repeats
 * this boundary after its revocations as defense in depth.
 */
export async function verifyRuntimeDatabasePrivilegeBoundary(
  client: MigrationClient
): Promise<void> {
  const result = await client.query<RuntimeDatabasePrivilegeBoundary>(`
    SELECT
      (runtime_role.rolsuper
        OR runtime_role.rolcreatedb
        OR runtime_role.rolcreaterole
        OR runtime_role.rolreplication
        OR runtime_role.rolbypassrls) AS elevated_role,
      pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE')
        AS can_create_database_objects,
      pg_catalog.has_schema_privilege('public', 'CREATE') AS can_create_public_objects,
      pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMPORARY')
        AS can_create_temporary_objects,
      pg_catalog.has_parameter_privilege(current_user, 'session_replication_role', 'SET')
        AS can_set_session_replication_role,
      pg_catalog.current_setting('session_replication_role') = 'origin'
        AS replication_role_is_origin,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class trigger_target
        JOIN pg_catalog.pg_namespace trigger_namespace
          ON trigger_namespace.oid = trigger_target.relnamespace
        WHERE trigger_namespace.nspname = 'public'
          AND trigger_target.relkind IN ('r', 'p')
          AND pg_catalog.has_table_privilege(current_user, trigger_target.oid, 'TRIGGER')
      ) AS can_create_triggers,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members membership
        WHERE membership.member = runtime_role.oid
      ) AS has_role_memberships,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_database database_row
        WHERE database_row.datname = pg_catalog.current_database()
          AND database_row.datdba = runtime_role.oid
      ) AS owns_database,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace namespace_row
        WHERE namespace_row.nspname = 'public'
          AND namespace_row.nspowner = runtime_role.oid
      ) AS owns_public_schema,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class class_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = class_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND class_row.relowner = runtime_role.oid
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = procedure_row.pronamespace
        WHERE namespace_row.nspname = 'public'
          AND procedure_row.proowner = runtime_role.oid
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_type type_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = type_row.typnamespace
        WHERE namespace_row.nspname = 'public'
          AND type_row.typowner = runtime_role.oid
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_collation collation_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = collation_row.collnamespace
        WHERE namespace_row.nspname = 'public'
          AND collation_row.collowner = runtime_role.oid
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_conversion conversion_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = conversion_row.connamespace
        WHERE namespace_row.nspname = 'public'
          AND conversion_row.conowner = runtime_role.oid
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_operator operator_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = operator_row.oprnamespace
        WHERE namespace_row.nspname = 'public'
          AND operator_row.oprowner = runtime_role.oid
      ) AS owns_public_objects
    FROM pg_catalog.pg_roles runtime_role
    WHERE runtime_role.rolname = current_user
  `);
  const boundary = result.rows[0];
  if (
    result.rows.length !== 1
    || !boundary
    || boundary.elevated_role
    || boundary.can_create_database_objects
    || boundary.can_create_public_objects
    || boundary.can_create_temporary_objects
    || boundary.can_create_triggers
    || boundary.can_set_session_replication_role
    || boundary.has_role_memberships
    || boundary.owns_database
    || boundary.owns_public_schema
    || boundary.owns_public_objects
    || !boundary.replication_role_is_origin
  ) {
    throw new Error('Runtime database privilege boundary verification failed');
  }
}

async function readRecordedDatabaseIdentity(
  client: MigrationClient
): Promise<RecordedDatabaseIdentity | null> {
  const existence = await client.query<{ identity_exists: boolean }>(
    `SELECT pg_catalog.to_regclass('public.hx_database_identity') IS NOT NULL AS identity_exists`
  );
  if (!existence.rows[0]?.identity_exists) return null;
  const result = await client.query<{
    database_name: string;
    database_oid: string;
    cluster_system_identifier: string;
    migration_owner: string;
  }>(
    `SELECT
       database_name::text AS database_name,
       database_oid::text AS database_oid,
       cluster_system_identifier,
       migration_owner::text AS migration_owner
     FROM public.hx_database_identity
     WHERE singleton IS TRUE`
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || !row?.database_name?.trim()
    || !row.database_oid?.trim()
    || !row.cluster_system_identifier?.trim()
    || !row.migration_owner?.trim()
  ) {
    throw new Error('Recorded database identity is malformed');
  }
  return {
    database: row.database_name.trim(),
    databaseOid: row.database_oid.trim(),
    clusterSystemIdentifier: row.cluster_system_identifier.trim(),
    migrationOwner: row.migration_owner.trim(),
  };
}

function assertRecordedDatabaseIdentity(
  live: DatabaseIdentity,
  recorded: RecordedDatabaseIdentity | null
): void {
  if (!recorded) return;
  if (
    live.database !== recorded.database
    || live.databaseOid !== recorded.databaseOid
    || live.clusterSystemIdentifier !== recorded.clusterSystemIdentifier
  ) {
    throw new Error('Connection target does not match recorded database identity');
  }
}

async function setRuntimeDatabaseRole(
  client: MigrationClient,
  runtimeDatabaseRole: VerifiedDatabaseRole
): Promise<void> {
  if (!runtimeDatabaseRole.trim()) throw new Error('Verified runtime database identity is required');
  await client.query(
    `SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true)`
  );
  const boundary = await client.query<{
    direct_session_identity: boolean;
    trusted_search_path: boolean;
    replication_role_is_origin: boolean;
  }>(`
    SELECT
      current_user = session_user AS direct_session_identity,
      pg_catalog.current_setting('search_path') = 'pg_catalog, public' AS trusted_search_path,
      pg_catalog.current_setting('session_replication_role') = 'origin'
        AS replication_role_is_origin
  `);
  const verified = boundary.rows[0];
  if (
    !verified
    || !verified.direct_session_identity
    || !verified.trusted_search_path
    || !verified.replication_role_is_origin
  ) {
    throw new Error('Migration session boundary verification failed');
  }
  await client.query(
    `SELECT pg_catalog.set_config('hustlexp.runtime_database_role', $1, true)`,
    [runtimeDatabaseRole]
  );
}

export function productionMigrationRuntime(): MigrationRuntime {
  const cwd = process.cwd();
  const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim() ?? '';
  const expectedDatabase = process.env.HX_MIGRATION_EXPECTED_DATABASE_NAME?.trim() ?? '';
  const expectedDatabaseOid = process.env.HX_MIGRATION_EXPECTED_DATABASE_OID?.trim() ?? '';
  const expectedClusterSystemIdentifier =
    process.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER?.trim() ?? '';
  const expectedDatabaseIdentity =
    expectedDatabase
    && /^\d+$/.test(expectedDatabaseOid)
    && /^\d+$/.test(expectedClusterSystemIdentifier)
      ? {
          database: expectedDatabase,
          databaseOid: expectedDatabaseOid,
          clusterSystemIdentifier: expectedClusterSystemIdentifier,
        }
      : undefined;
  return {
    runtimeDatabaseUrl,
    migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL?.trim() ?? '',
    expectedDatabaseIdentity,
    requireExpectedDatabaseIdentity: true,
    bootstrapSpec: {
      name: CONSTITUTIONAL_BOOTSTRAP_FILE.name,
      candidatePaths: [
        path.join(cwd, 'backend/database', CONSTITUTIONAL_BOOTSTRAP_FILE.fileName),
        path.join('/app/backend/database', CONSTITUTIONAL_BOOTSTRAP_FILE.fileName),
      ],
    },
    migrationSpecs: REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [
        path.join(cwd, 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ],
    })),
    requireCanonicalMigrationInventory: true,
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

type MigrationLedgerRow = {
  name: string;
  ordinal: number | null;
  source_sha256: string | null;
};

async function ensureMigrationLedgerSchema(client: MigrationClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS public.applied_migrations (
    name TEXT PRIMARY KEY,
    ordinal INTEGER,
    source_sha256 TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
  )`);
  await client.query(
    'ALTER TABLE public.applied_migrations ADD COLUMN IF NOT EXISTS ordinal INTEGER'
  );
  await client.query(
    'ALTER TABLE public.applied_migrations ADD COLUMN IF NOT EXISTS source_sha256 TEXT'
  );
}

async function verifyMigrationLedgerEntry(
  client: MigrationClient,
  migrationName: string,
  ordinal: number,
  sourceSha256: string
): Promise<boolean> {
  const existing = await client.query<MigrationLedgerRow>(
    `SELECT name, ordinal, source_sha256
     FROM public.applied_migrations
     WHERE name = $1 OR ordinal = $2
     ORDER BY name
     FOR UPDATE`,
    [migrationName, ordinal]
  );
  if (existing.rows.length > 1 || (existing.rows[0] && existing.rows[0].name !== migrationName)) {
    throw new Error('Migration ledger ordinal collision');
  }
  const row = existing.rows[0];
  if (!row) return false;
  if (row.ordinal === null && row.source_sha256 === null) {
    throw new Error('Migration ledger entry lacks exact source identity');
  }
  if (row.ordinal !== ordinal || row.source_sha256 !== sourceSha256) {
    throw new Error('Migration ledger source identity drift');
  }
  return true;
}

async function ensureConstitutionalBaseline(
  client: MigrationClient,
  runtime: MigrationRuntime,
  runtimeDatabaseRole: VerifiedDatabaseRole,
  baseline: LoadedMigrationSql
): Promise<void> {
  if (!runtime.bootstrapSpec) return;
  const normalized = normalizeMigrationSqlForAtomicApply(
    runtime.bootstrapSpec.name,
    baseline.sql,
    baseline.sourcePath
  );
  await client.query('BEGIN');
  try {
    await setRuntimeDatabaseRole(client, runtimeDatabaseRole);
    await client.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtext('hustlexp-engine-migration-ledger-v2')
       )`
    );
    await ensureMigrationLedgerSchema(client);
    const recheck = await client.query<{ baseline_exists: boolean }>(
      `SELECT pg_catalog.to_regclass('public.schema_versions') IS NOT NULL AS baseline_exists`
    );
    const recorded = await verifyMigrationLedgerEntry(
      client,
      runtime.bootstrapSpec.name,
      0,
      baseline.sourceSha256
    );
    if (recorded && !recheck.rows[0]?.baseline_exists) {
      throw new Error('Constitutional bootstrap ledger exists without schema baseline');
    }
    if (!recorded) {
      if (recheck.rows[0]?.baseline_exists) {
        throw new Error('Constitutional schema exists without exact bootstrap source identity');
      }
      await client.query(normalized);
      const applied = await client.query<{ baseline_exists: boolean }>(
        `SELECT pg_catalog.to_regclass('public.schema_versions') IS NOT NULL AS baseline_exists`
      );
      if (!applied.rows[0]?.baseline_exists) {
        throw new Error('Constitutional bootstrap did not materialize schema_versions');
      }
      await client.query(
        `INSERT INTO public.applied_migrations (name, ordinal, source_sha256)
         VALUES ($1, $2, $3)`,
        [runtime.bootstrapSpec.name, 0, baseline.sourceSha256]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function loadMigrationSql(
  runtime: MigrationRuntime,
  spec: MigrationSpec = runtime.migrationSpecs[0]
): Promise<LoadedMigrationSql> {
  const failures: Array<{ path: string; reason: string }> = [];
  for (const candidate of spec.candidatePaths) {
    try {
      const sql = await runtime.readText(candidate);
      if (sql.trim()) {
        return {
          sql,
          sourcePath: candidate,
          sourceSha256: createHash('sha256').update(sql, 'utf8').digest('hex'),
        };
      }
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
  runtimeDatabaseRole: VerifiedDatabaseRole,
  migrationName: string = ENGINE_AUTOMATION_MIGRATION,
  ordinal: number = 1,
  sourceSha256: string = createHash('sha256').update(sql, 'utf8').digest('hex')
): Promise<MigrationOutcome> {
  assertNoTopLevelTransactionControl(sql);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error('Migration ordinal is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error('Migration source SHA-256 is invalid');
  }
  await client.query('BEGIN');
  try {
    await setRuntimeDatabaseRole(client, runtimeDatabaseRole);
    await client.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtext('hustlexp-engine-migration-ledger-v2')
       )`
    );
    await ensureMigrationLedgerSchema(client);
    if (await verifyMigrationLedgerEntry(
      client,
      migrationName,
      ordinal,
      sourceSha256
    )) {
      await client.query('COMMIT');
      return { status: 'already_applied', migration: migrationName, sourcePath };
    }

    await client.query(sql);
    await client.query(
      `INSERT INTO public.applied_migrations (name, ordinal, source_sha256)
       VALUES ($1, $2, $3)`,
      [migrationName, ordinal, sourceSha256]
    );
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
  const runtimeDatabaseUrl = runtime.runtimeDatabaseUrl.trim();
  const migrationDatabaseUrl = runtime.migrationDatabaseUrl.trim();
  const validation = validateMigrationConfig(runtimeDatabaseUrl, migrationDatabaseUrl);
  if (!validation.valid) {
    throw new Error(`Migration database configuration rejected: ${validation.errors.join('; ')}`);
  }
  if (runtime.requireExpectedDatabaseIdentity && !runtime.expectedDatabaseIdentity) {
    throw new Error('Expected migration database identity is required');
  }
  const loadedBootstrap = runtime.bootstrapSpec
    ? await loadMigrationSql(runtime, runtime.bootstrapSpec)
    : undefined;
  if (loadedBootstrap && runtime.bootstrapSpec) {
    normalizeMigrationSqlForAtomicApply(
      runtime.bootstrapSpec.name,
      loadedBootstrap.sql,
      loadedBootstrap.sourcePath
    );
  }
  const loadedMigrations = await Promise.all(
    runtime.migrationSpecs.map(async (spec) => ({
      spec,
      migration: await loadMigrationSql(runtime, spec),
    }))
  );
  if (runtime.requireCanonicalMigrationInventory) {
    reconcileLegacyOuterTransactionMigrations(
      loadedMigrations.map(({ spec, migration }) => ({
        name: spec.name,
        sourcePath: migration.sourcePath,
        sql: migration.sql,
      }))
    );
  }
  const normalizedMigrations = loadedMigrations.map(({ spec, migration }) => ({
    spec,
    migration,
    sql: normalizeMigrationSqlForAtomicApply(spec.name, migration.sql, migration.sourcePath),
  }));
  const runtimeIdentityClient = runtime.createClient(runtimeDatabaseUrl);
  const runtimeIdentity = await (async (): Promise<DatabaseIdentity> => {
    try {
      await runtimeIdentityClient.connect();
      await pinTrustedSessionSearchPath(runtimeIdentityClient);
      const identity = await readDatabaseIdentity(runtimeIdentityClient);
      if (
        runtime.expectedDatabaseIdentity
        && (
          identity.database !== runtime.expectedDatabaseIdentity.database
          || identity.databaseOid !== runtime.expectedDatabaseIdentity.databaseOid
          || identity.clusterSystemIdentifier
            !== runtime.expectedDatabaseIdentity.clusterSystemIdentifier
        )
      ) {
        throw new Error('Runtime connection does not match expected database identity');
      }
      assertRecordedDatabaseIdentity(
        identity,
        await readRecordedDatabaseIdentity(runtimeIdentityClient)
      );
      await verifyRuntimeDatabasePrivilegeBoundary(runtimeIdentityClient);
      return identity;
    } catch {
      throw new Error('Runtime database identity verification failed');
    } finally {
      await runtimeIdentityClient.end().catch(() => undefined);
    }
  })();

  const client = runtime.createClient(migrationDatabaseUrl);
  try {
    await client.connect();
    await pinTrustedSessionSearchPath(client);
    const migrationIdentity = await readDatabaseIdentity(client);
    if (
      runtime.expectedDatabaseIdentity
      && (
        migrationIdentity.database !== runtime.expectedDatabaseIdentity.database
        || migrationIdentity.databaseOid !== runtime.expectedDatabaseIdentity.databaseOid
        || migrationIdentity.clusterSystemIdentifier
          !== runtime.expectedDatabaseIdentity.clusterSystemIdentifier
      )
    ) {
      throw new Error('Migration connection does not match expected database identity');
    }
    if (
      migrationIdentity.database !== runtimeIdentity.database
      || migrationIdentity.databaseOid !== runtimeIdentity.databaseOid
      || migrationIdentity.clusterSystemIdentifier !== runtimeIdentity.clusterSystemIdentifier
    ) {
      throw new Error('Runtime and migration connections target different databases');
    }
    if (migrationIdentity.role === runtimeIdentity.role) {
      throw new Error('Runtime and migration database identities must be distinct');
    }
    await verifyMigrationDatabasePrivilegeBoundary(client);
    const recordedIdentity = await readRecordedDatabaseIdentity(client);
    assertRecordedDatabaseIdentity(migrationIdentity, recordedIdentity);
    if (recordedIdentity && recordedIdentity.migrationOwner !== migrationIdentity.role) {
      throw new Error('Migration role does not own the recorded database identity');
    }
    if (loadedBootstrap) {
      await ensureConstitutionalBaseline(
        client,
        runtime,
        runtimeIdentity.role,
        loadedBootstrap
      );
    }
    const outcomes: MigrationOutcome[] = [];
    for (const [index, { spec, migration, sql }] of normalizedMigrations.entries()) {
      const outcome = await applyEngineAutomationMigration(
        client,
        sql,
        migration.sourcePath,
        runtimeIdentity.role,
        spec.name,
        index + 1,
        migration.sourceSha256
      );
      outcomes.push(outcome);
      workerLogger.info(outcome, 'Required engine migration verified');
    }
    return outcomes;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    workerLogger.fatal(
      { code: typeof code === 'string' ? code : undefined },
      'Required engine migration failed'
    );
    throw new Error('Required engine migration failed');
  } finally {
    await client.end().catch(() => undefined);
  }
}
