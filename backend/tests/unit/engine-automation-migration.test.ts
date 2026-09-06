import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADD_MISSING_TABLES_V2_MIGRATION,
  ENGINE_AUTOMATION_MIGRATION,
  EXPERTISE_SUPPLY_MIGRATION,
  PROOF_ALIGNMENT_MIGRATION,
  TASK_OUTCOME_CLASSIFICATION_MIGRATION,
  HUSTLER_IDENTITY_LINK_MIGRATION,
  DISPATCH_EXPIRY_PAYMENT_CANCEL_MIGRATION,
  DISPATCH_EXPIRY_NO_PAYMENT_RECONCILE_MIGRATION,
  PERFORMANCE_INDEX_ALIGNMENT_MIGRATION,
  CHARGEBACK_LIFECYCLE_MIGRATION,
  REVENUE_AUDIT_RAIL_MIGRATION,
  QUOTE_ECONOMICS_CONTRACT_MIGRATION,
  TASK_SCOPE_VERSIONS_MIGRATION,
  TASK_LOCATION_ENCRYPTION_MIGRATION,
  PROOF_SUBMISSION_ATOMICITY_MIGRATION,
  TASK_SAFETY_INCIDENT_CASES_MIGRATION,
  TASK_SAFETY_DELIVERY_CONTRACT_MIGRATION,
  TASK_SAFETY_CHECKINS_MIGRATION,
  TASK_SAFETY_LOCATION_ENCRYPTION_MIGRATION,
  ZONE_CATEGORY_LIQUIDITY_CELLS_MIGRATION,
  WORKER_OFFER_DECISION_CONTRACT_MIGRATION,
  WORKER_SCREENING_RIGHTS_CONTRACT_MIGRATION,
  REGION_POLICY_CONTRACT_MIGRATION,
  COMPLETION_RETENTION_CONTRACT_MIGRATION,
  TASK_PUBLIC_CLARIFICATIONS_MIGRATION,
  MARKETPLACE_REPUTATION_CONTRACT_MIGRATION,
  BUSINESS_WORKSPACE_CONTRACT_MIGRATION,
  BUSINESS_OPERATIONS_CONTRACT_MIGRATION,
  BUSINESS_EXECUTION_CONTRACT_MIGRATION,
  RECURRING_WORK_CONTRACT_MIGRATION,
  BUSINESS_RECURRING_CONTRACT_MIGRATION,
  RECOMMENDATION_CONTRACT_MIGRATION,
  HUSTLER_WALLET_CONTRACT_MIGRATION,
  WALLET_PROVIDER_EVENT_INTEGRITY_MIGRATION,
  WALLET_PROVIDER_EVENT_INTEGRITY_REPAIR_MIGRATION,
  LIFECYCLE_SERVICE_FOUNDATIONS_MIGRATION,
  TASK_WORKER_ELIGIBILITY_CONTRACT_MIGRATION,
  APPEND_ONLY_TRUNCATE_CONTRACT_MIGRATION,
  ADMIN_USER_SEARCH_TRIGRAM_CONTRACT_MIGRATION,
  ADMIN_CAPABILITY_CONTRACT_MIGRATION,
  TIER0_BROWSE_ONLY_CONTRACT_MIGRATION,
  TASK_TEMPLATE_POLICY_CONTRACT_MIGRATION,
  COMPLIANCE_GUARDIAN_PERSISTENCE_CONTRACT_MIGRATION,
  WORKER_OFFER_RETAKE_CONTRACT_MIGRATION,
  LIQUIDITY_EXPANSION_CONTRACT_MIGRATION,
  LIQUIDITY_EXPANSION_FK_REPAIR_MIGRATION,
  WORKER_COUNTER_OFFER_CONTRACT_MIGRATION,
  WORKER_COUNTER_OFFER_EXCLUSIVITY_MIGRATION,
  EXTERNAL_TASK_BRIDGE_CONTRACT_MIGRATION,
  TASK_GEOFENCE_EVENT_CONTRACT_MIGRATION,
  MAJOR_ACTION_TELEMETRY_CONTRACT_MIGRATION,
  MAJOR_ACTION_TELEMETRY_CONTRACT_REPAIR_MIGRATION,
  MAJOR_ACTION_SOURCE_REGISTRY_REPAIR_MIGRATION,
  OFFLINE_ACTION_SYNC_CONTRACT_MIGRATION,
  OFFLINE_ACTION_SYNC_CONTRACT_REPAIR_MIGRATION,
  PROOF_VERIFICATION_SIGNAL_CONTRACT_MIGRATION,
  PROOF_MEDIA_METADATA_MINIMIZATION_MIGRATION,
  MEDIA_UPLOAD_FINALIZATION_CONTRACT_MIGRATION,
  PRIVATE_MEDIA_DELIVERY_CONTRACT_MIGRATION,
  WORKER_STANDING_APPEALS_MIGRATION,
  OFFLINE_ACTION_RECONCILIATION_MIGRATION,
  DISPUTE_RELEASE_AUTHORITY_CONTRACT_MIGRATION,
  NOTIFICATION_DELIVERY_CONTRACT_MIGRATION,
  NOTIFICATION_DELIVERY_CONTRACT_REPAIR_MIGRATION,
  NOTIFICATION_FOCUS_SUPPRESSION_MIGRATION,
  SCHEMA_CONVERGENCE_REPAIR_MIGRATION,
  LOCAL_CERTIFICATION_PAYMENT_PROVIDER_MIGRATION,
  REGION_POLICY_PRICE_BOOK_ALIGNMENT_MIGRATION,
  LOCAL_CERTIFICATION_PAYOUT_PROVIDER_MIGRATION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER_MIGRATION,
  CONTROLLED_TEST_LIQUIDITY_CELL_MIGRATION,
  CONTROLLED_TEST_LIQUIDITY_MARKER_REPAIR_MIGRATION,
  CONTROLLED_TEST_LIQUIDITY_LIFECYCLE_REPAIR_MIGRATION,
  CONTROLLED_TEST_DURATION_EVIDENCE_MIGRATION,
  CONTROLLED_TEST_PROVIDER_CAPABILITY_MIGRATION,
  CONTROLLED_TEST_PROVIDER_CAPABILITY_EXPIRY_MIGRATION,
  CONTROLLED_TEST_PROVIDER_CAPABILITY_REFRESH_MIGRATION,
  CONTROLLED_TEST_PROVIDER_CAPABILITY_REFRESH_REPAIR_MIGRATION,
  CONTROLLED_TEST_OFFER_REVIEW_MIGRATION,
  TASK_SAFETY_STATE_INTEGRITY_MIGRATION,
  TASK_SAFETY_RESOLUTION_INTEGRITY_MIGRATION,
  TASK_SAFETY_CASE_ACCESS_INTEGRITY_MIGRATION,
  OPERATIONS_EXCEPTION_CONTRACT_MIGRATION,
  HUSTLER_TRUST_PROGRESSION_CONTRACT_MIGRATION,
  TASK_QUOTE_SHORTLIST_MESSAGING_CONTRACT_MIGRATION,
  UNIT_ECONOMICS_GUARDRAILS_MIGRATION,
  BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_MIGRATION,
  PRIVATE_IDENTITY_VERIFICATION_CONTRACT_MIGRATION,
  SENSITIVE_MEDIA_INGESTION_SHUTDOWN_MIGRATION,
  AI_OBSERVABILITY_CONTRACT_MIGRATION,
  CONTROLLED_TEST_RETAKE_ACCEPTANCE_REPAIR_MIGRATION,
  CONTROLLED_TEST_RETAKE_LIQUIDITY_REPAIR_MIGRATION,
  CONTROLLED_TEST_RETAKE_GUARD_CONVERGENCE_MIGRATION,
  SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION,
  REGION_POLICY_LEGAL_APPROVAL_ACTIVATION_MIGRATION,
  RECURRING_PAYMENT_DISPATCH_GATE_MIGRATION,
  SERVICE_BUSINESS_ASSIGNMENT_CONTRACT_MIGRATION,
  applyEngineAutomationMigration,
  backfillLegacyTaskLocations,
  ensureConstitutionalBaseline,
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigration,
  type MigrationClient,
  type MigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';
import {
  assertMigrationExecutionAuthorized,
  authorizeMigrationExecutionPlan,
} from '../../src/jobs/migration-execution-authority.js';

const LOCAL_DATABASE_URL = 'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test';

function localMigrationSession(
  client: MigrationClient,
  migrations: Array<{ name: string; sql: string; sourcePath: string }> = []
) {
  const authority = assertMigrationExecutionAuthorized({
    env: { HX_ENVIRONMENT: 'local', NODE_ENV: 'test', SERVICE_ROLE: 'migration' },
    migrationArtifactDigest: `sha256:${'a'.repeat(64)}`,
    databaseUrl: LOCAL_DATABASE_URL,
  });
  return authorizeMigrationExecutionPlan(authority, {
    databaseUrl: LOCAL_DATABASE_URL,
    client,
    migrations,
  });
}

function localBaselineSession(
  client: MigrationClient,
  baseline: { name: string; sql: string; sourcePath: string }
) {
  const authority = assertMigrationExecutionAuthorized({
    env: { HX_ENVIRONMENT: 'local', NODE_ENV: 'test', SERVICE_ROLE: 'migration' },
    migrationArtifactDigest: `sha256:${'a'.repeat(64)}`,
    databaseUrl: LOCAL_DATABASE_URL,
  });
  return authorizeMigrationExecutionPlan(authority, {
    databaseUrl: LOCAL_DATABASE_URL,
    client,
    baseline,
    migrations: [],
  });
}

function sha256(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function clientWithQueries(existingSha256?: string | null): MigrationClient & {
  queries: string[];
  connection: { backendPid: number; sessionMarker: string | null };
} {
  const queries: string[] = [];
  const connection = { backendPid: 17_001, sessionMarker: null as string | null };
  return {
    queries,
    connection,
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.includes("set_config('search_path', 'public', false)")) {
        return { rows: [{ set_config: 'public' }] };
      }
      if (sql.includes('current_database()::text AS database_name')) {
        return {
          rows: [
            {
              database_name: 'hx_ci_system_test',
              role_name: 'hx_ci_runner',
              session_role_name: 'hx_ci_runner',
              server_address: '127.0.0.1',
              server_port: 5432,
              schema_name: 'public',
              search_path: 'public',
              effective_schemas: ['public'],
            },
          ],
        };
      }
      if (sql.includes("set_config('hustlexp.migration_session', $1, false)")) {
        connection.sessionMarker = String(values?.[0] ?? '');
        return {
          rows: [
            {
              backend_pid: connection.backendPid,
              session_marker: connection.sessionMarker,
            },
          ],
        };
      }
      if (sql.includes("current_setting('hustlexp.migration_session', true)")) {
        return {
          rows: [
            {
              backend_pid: connection.backendPid,
              session_marker: connection.sessionMarker,
            },
          ],
        };
      }
      return {
        rows:
          sql.startsWith('SELECT name, sha256') && existingSha256 !== undefined
            ? [{ name: ENGINE_AUTOMATION_MIGRATION, sha256: existingSha256 }]
            : [],
      };
    }) as MigrationClient['query'],
  };
}

const BASELINE_ENTRY = Object.freeze({
  name: 'constitutional_schema_v1',
  sql: 'CREATE TABLE schema_versions(version TEXT PRIMARY KEY);',
  sourcePath: '/constitutional-schema.sql',
});

type BaselineReceiptFixture = {
  receiptCount: number;
  singletonTrue: boolean;
  receiptVersion: number;
  baselineName: string;
  baselineSha256: string;
  provenance: 'APPLIED_FROM_EMPTY' | 'LEGACY_CATALOG_RECONCILED';
  reconciliationSha256: string | null;
  schemaVersionsExists: boolean;
  immutableTriggerCount: number;
  rejectionFunctionExists: boolean;
  appliedAtPresent: boolean;
};

function clientWithBaselineCatalog(
  options: {
    receipt?: Partial<BaselineReceiptFixture> | null;
    userObjectsExist?: boolean;
  } = {}
): MigrationClient & { queries: string[] } {
  const client = clientWithQueries();
  const query = client.query as ReturnType<typeof vi.fn>;
  const baseQuery = query.getMockImplementation()!;
  let receiptTableExists = options.receipt !== undefined && options.receipt !== null;
  let schemaVersionsExists = options.receipt?.schemaVersionsExists ?? false;
  let receipt: BaselineReceiptFixture | null = receiptTableExists
    ? {
        receiptCount: 1,
        singletonTrue: true,
        receiptVersion: 1,
        baselineName: BASELINE_ENTRY.name,
        baselineSha256: sha256(BASELINE_ENTRY.sql),
        provenance: 'APPLIED_FROM_EMPTY',
        reconciliationSha256: null,
        schemaVersionsExists: true,
        immutableTriggerCount: 2,
        rejectionFunctionExists: true,
        appliedAtPresent: true,
        ...options.receipt,
      }
    : null;

  query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes('AS receipt_table_exists')) {
      client.queries.push(sql);
      return { rows: [{ receipt_table_exists: receiptTableExists }] };
    }
    if (sql.includes('AS user_objects_exist')) {
      client.queries.push(sql);
      return { rows: [{ user_objects_exist: options.userObjectsExist ?? false }] };
    }
    if (sql === BASELINE_ENTRY.sql) {
      schemaVersionsExists = true;
      return baseQuery(sql, values);
    }
    if (sql.includes('CREATE TABLE public.hustlexp_constitutional_baseline_receipts')) {
      client.queries.push(sql);
      receiptTableExists = true;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO public.hustlexp_constitutional_baseline_receipts')) {
      client.queries.push(sql);
      receipt = {
        receiptCount: 1,
        singletonTrue: true,
        receiptVersion: Number(values?.[0]),
        baselineName: String(values?.[1]),
        baselineSha256: String(values?.[2]),
        provenance: String(values?.[3]) as BaselineReceiptFixture['provenance'],
        reconciliationSha256: null,
        schemaVersionsExists,
        immutableTriggerCount: 2,
        rejectionFunctionExists: true,
        appliedAtPresent: true,
      };
      return { rows: [] };
    }
    if (sql.includes('AS receipt_count')) {
      client.queries.push(sql);
      return {
        rows: [
          {
            receipt_count: receipt?.receiptCount ?? 0,
            singleton_true: receipt?.singletonTrue ?? null,
            receipt_version: receipt?.receiptVersion ?? null,
            baseline_name: receipt?.baselineName ?? null,
            baseline_sha256: receipt?.baselineSha256 ?? null,
            provenance: receipt?.provenance ?? null,
            reconciliation_sha256: receipt?.reconciliationSha256 ?? null,
            schema_versions_exists: receipt?.schemaVersionsExists ?? schemaVersionsExists,
            immutable_trigger_count: receipt?.immutableTriggerCount ?? 0,
            rejection_function_exists: receipt?.rejectionFunctionExists ?? false,
            applied_at_present: receipt?.appliedAtPresent ?? null,
          },
        ],
      };
    }
    return baseQuery(sql, values);
  });
  return client;
}

function runtime(overrides: Partial<MigrationRuntime> = {}): MigrationRuntime {
  return {
    databaseUrl: LOCAL_DATABASE_URL,
    migrationSpecs: [
      {
        name: ENGINE_AUTOMATION_MIGRATION,
        candidatePaths: ['/missing.sql', '/migration.sql'],
      },
    ],
    readText: vi.fn(async (filePath: string) => {
      if (filePath === '/migration.sql') return 'SELECT 1;';
      throw new Error('not found');
    }),
    createClient: vi.fn(() => clientWithQueries()),
    ...overrides,
  };
}

describe('required engine automation migration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLocationKey = process.env.TASK_LOCATION_ENCRYPTION_KEY;
  const originalLocationKeyId = process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;

  beforeEach(() => {
    process.env.TASK_LOCATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = 'location-test-v1';
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalLocationKey === undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY;
    else process.env.TASK_LOCATION_ENCRYPTION_KEY = originalLocationKey;
    if (originalLocationKeyId === undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;
    else process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = originalLocationKeyId;
  });

  it('builds production filesystem and PostgreSQL adapters without opening a connection', async () => {
    process.env.DATABASE_URL = 'postgres://runtime';
    const actual = productionMigrationRuntime();
    expect(actual.databaseUrl).toBe('postgres://runtime');
    expect(actual.migrationSpecs.map((spec) => spec.name)).toEqual([
      ADD_MISSING_TABLES_V2_MIGRATION,
      ENGINE_AUTOMATION_MIGRATION,
      PROOF_ALIGNMENT_MIGRATION,
      EXPERTISE_SUPPLY_MIGRATION,
      TASK_OUTCOME_CLASSIFICATION_MIGRATION,
      HUSTLER_IDENTITY_LINK_MIGRATION,
      DISPATCH_EXPIRY_PAYMENT_CANCEL_MIGRATION,
      DISPATCH_EXPIRY_NO_PAYMENT_RECONCILE_MIGRATION,
      PERFORMANCE_INDEX_ALIGNMENT_MIGRATION,
      CHARGEBACK_LIFECYCLE_MIGRATION,
      REVENUE_AUDIT_RAIL_MIGRATION,
      QUOTE_ECONOMICS_CONTRACT_MIGRATION,
      TASK_SCOPE_VERSIONS_MIGRATION,
      TASK_LOCATION_ENCRYPTION_MIGRATION,
      PROOF_SUBMISSION_ATOMICITY_MIGRATION,
      TASK_SAFETY_INCIDENT_CASES_MIGRATION,
      TASK_SAFETY_DELIVERY_CONTRACT_MIGRATION,
      TASK_SAFETY_CHECKINS_MIGRATION,
      TASK_SAFETY_LOCATION_ENCRYPTION_MIGRATION,
      ZONE_CATEGORY_LIQUIDITY_CELLS_MIGRATION,
      WORKER_OFFER_DECISION_CONTRACT_MIGRATION,
      WORKER_SCREENING_RIGHTS_CONTRACT_MIGRATION,
      REGION_POLICY_CONTRACT_MIGRATION,
      COMPLETION_RETENTION_CONTRACT_MIGRATION,
      TASK_PUBLIC_CLARIFICATIONS_MIGRATION,
      MARKETPLACE_REPUTATION_CONTRACT_MIGRATION,
      BUSINESS_WORKSPACE_CONTRACT_MIGRATION,
      BUSINESS_OPERATIONS_CONTRACT_MIGRATION,
      BUSINESS_EXECUTION_CONTRACT_MIGRATION,
      RECURRING_WORK_CONTRACT_MIGRATION,
      BUSINESS_RECURRING_CONTRACT_MIGRATION,
      RECOMMENDATION_CONTRACT_MIGRATION,
      HUSTLER_WALLET_CONTRACT_MIGRATION,
      WALLET_PROVIDER_EVENT_INTEGRITY_MIGRATION,
      WALLET_PROVIDER_EVENT_INTEGRITY_REPAIR_MIGRATION,
      LIFECYCLE_SERVICE_FOUNDATIONS_MIGRATION,
      TASK_WORKER_ELIGIBILITY_CONTRACT_MIGRATION,
      APPEND_ONLY_TRUNCATE_CONTRACT_MIGRATION,
      ADMIN_USER_SEARCH_TRIGRAM_CONTRACT_MIGRATION,
      ADMIN_CAPABILITY_CONTRACT_MIGRATION,
      TIER0_BROWSE_ONLY_CONTRACT_MIGRATION,
      TASK_TEMPLATE_POLICY_CONTRACT_MIGRATION,
      COMPLIANCE_GUARDIAN_PERSISTENCE_CONTRACT_MIGRATION,
      WORKER_OFFER_RETAKE_CONTRACT_MIGRATION,
      LIQUIDITY_EXPANSION_CONTRACT_MIGRATION,
      LIQUIDITY_EXPANSION_FK_REPAIR_MIGRATION,
      WORKER_COUNTER_OFFER_CONTRACT_MIGRATION,
      WORKER_COUNTER_OFFER_EXCLUSIVITY_MIGRATION,
      EXTERNAL_TASK_BRIDGE_CONTRACT_MIGRATION,
      TASK_GEOFENCE_EVENT_CONTRACT_MIGRATION,
      MAJOR_ACTION_TELEMETRY_CONTRACT_MIGRATION,
      MAJOR_ACTION_TELEMETRY_CONTRACT_REPAIR_MIGRATION,
      MAJOR_ACTION_SOURCE_REGISTRY_REPAIR_MIGRATION,
      OFFLINE_ACTION_SYNC_CONTRACT_MIGRATION,
      OFFLINE_ACTION_SYNC_CONTRACT_REPAIR_MIGRATION,
      PROOF_VERIFICATION_SIGNAL_CONTRACT_MIGRATION,
      PROOF_MEDIA_METADATA_MINIMIZATION_MIGRATION,
      MEDIA_UPLOAD_FINALIZATION_CONTRACT_MIGRATION,
      PRIVATE_MEDIA_DELIVERY_CONTRACT_MIGRATION,
      WORKER_STANDING_APPEALS_MIGRATION,
      OFFLINE_ACTION_RECONCILIATION_MIGRATION,
      DISPUTE_RELEASE_AUTHORITY_CONTRACT_MIGRATION,
      NOTIFICATION_DELIVERY_CONTRACT_MIGRATION,
      NOTIFICATION_DELIVERY_CONTRACT_REPAIR_MIGRATION,
      NOTIFICATION_FOCUS_SUPPRESSION_MIGRATION,
      SCHEMA_CONVERGENCE_REPAIR_MIGRATION,
      LOCAL_CERTIFICATION_PAYMENT_PROVIDER_MIGRATION,
      REGION_POLICY_PRICE_BOOK_ALIGNMENT_MIGRATION,
      LOCAL_CERTIFICATION_PAYOUT_PROVIDER_MIGRATION,
      LOCAL_CERTIFICATION_SCREENING_PROVIDER_MIGRATION,
      CONTROLLED_TEST_LIQUIDITY_CELL_MIGRATION,
      CONTROLLED_TEST_LIQUIDITY_MARKER_REPAIR_MIGRATION,
      CONTROLLED_TEST_LIQUIDITY_LIFECYCLE_REPAIR_MIGRATION,
      CONTROLLED_TEST_DURATION_EVIDENCE_MIGRATION,
      CONTROLLED_TEST_PROVIDER_CAPABILITY_MIGRATION,
      CONTROLLED_TEST_PROVIDER_CAPABILITY_EXPIRY_MIGRATION,
      CONTROLLED_TEST_PROVIDER_CAPABILITY_REFRESH_MIGRATION,
      CONTROLLED_TEST_PROVIDER_CAPABILITY_REFRESH_REPAIR_MIGRATION,
      CONTROLLED_TEST_OFFER_REVIEW_MIGRATION,
      TASK_SAFETY_STATE_INTEGRITY_MIGRATION,
      TASK_SAFETY_RESOLUTION_INTEGRITY_MIGRATION,
      TASK_SAFETY_CASE_ACCESS_INTEGRITY_MIGRATION,
      OPERATIONS_EXCEPTION_CONTRACT_MIGRATION,
      HUSTLER_TRUST_PROGRESSION_CONTRACT_MIGRATION,
      TASK_QUOTE_SHORTLIST_MESSAGING_CONTRACT_MIGRATION,
      UNIT_ECONOMICS_GUARDRAILS_MIGRATION,
      BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_MIGRATION,
      PRIVATE_IDENTITY_VERIFICATION_CONTRACT_MIGRATION,
      SENSITIVE_MEDIA_INGESTION_SHUTDOWN_MIGRATION,
      AI_OBSERVABILITY_CONTRACT_MIGRATION,
      CONTROLLED_TEST_RETAKE_ACCEPTANCE_REPAIR_MIGRATION,
      CONTROLLED_TEST_RETAKE_LIQUIDITY_REPAIR_MIGRATION,
      CONTROLLED_TEST_RETAKE_GUARD_CONVERGENCE_MIGRATION,
      SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION,
      REGION_POLICY_LEGAL_APPROVAL_ACTIVATION_MIGRATION,
      RECURRING_PAYMENT_DISPATCH_GATE_MIGRATION,
      SERVICE_BUSINESS_ASSIGNMENT_CONTRACT_MIGRATION,
      '010_web_platform_tables',
      '20260814_quote_price_book',
      '20260814_price_book_quote_decisions',
      '20260814_task_supply_confidence',
      '20260815_quote_columns_extra_v4',
      '20260819_quote_payments',
      '20260823_quote_payment_recovery',
      '20260827_universal_v1_lifecycle_contract',
      '20260828_operator_authority_contract',
      '20260829_task_matching_state_contract',
      '20260830_ai_agent_judge_audit_convergence',
      '20260831_provider_neutral_outbound_communication',
      '20260901_universal_v1_lead_ingress_port',
      '20260902_universal_v1_task_draft_public_port',
      '20260903_universal_v1_task_draft_account_claim',
      '20260904_canonical_user_email_identity',
      '20260905_universal_v1_task_draft_legacy_claim_import_repair',
      '20260906_universal_v1_estimate_acceptance_materialization',
      '20260907_universal_v1_provider_estimate_invitation',
      '20260908_universal_v1_provider_work_order_authority',
      '20260909_universal_v1_reconciliation_alias_repair',
      '20260911_universal_v1_change_order_application',
      '20260912_universal_v1_work_order_execution_facts',
      '20260913_universal_v1_completion_delivery_receipt',
      '20260914_notification_provider_in_flight',
      '20260915_ai_spend_attempt_ledger',
      '20260916_provider_event_inbox_v1',
      '20260917_financial_provider_command_journal_v1',
      '20260918_universal_v1_prepared_financial_command_v1',
      '20260919_provider_event_processing_v1',
      '20260920_financial_provider_command_recovery_v1',
      '20260923_legacy_escrow_insert_containment_v1',
      '20260924_universal_v1_task_draft_route_context_v1',
      '20260925_universal_v1_work_order_compensation_v1',
      '20260928_provider_observation_normalization_v1',
      '20260929_universal_v1_double_entry_ledger_v1',
      '20260930_universal_v1_ops_cases_v1',
      '20261001_universal_v1_relationship_origin_v1',
      '20261002_universal_v1_dispute_recovery_v1',
      '20261003_universal_v1_task_opportunities_v1',
      '20261004_universal_v1_completion_notice_dispatch_v1',
      '20261005_universal_v1_occurrence_access_audit_v1',
      '20261006_stage1_legacy_authority_containment_v1',
      '20261007_subscription_cancellation_recovery_v1',
      '20261008_universal_v1_work_order_task_state_containment_v1',
      '20261009_universal_v1_standardized_quote_readiness_v1',
      '20261010_universal_v1_financial_security_event_expiry_v1',
      '20261012_universal_v1_work_order_command_authority_v2',
      '20261014_universal_v1_work_order_command_ports_v1',
    ]);
    const normalizePath = (candidatePath: string) => candidatePath.replaceAll('\\', '/');
    expect(actual.bootstrapSpec?.candidatePaths.map(normalizePath)).toContain(
      '/app/backend/database/constitutional-schema.sql'
    );
    expect(actual.migrationSpecs[0].candidatePaths.map(normalizePath)).toContain(
      '/app/backend/database/migrations/add_missing_tables_v2.sql'
    );
    expect(
      actual.migrationSpecs
        .find((spec) => spec.name === SERVICE_BUSINESS_ASSIGNMENT_CONTRACT_MIGRATION)
        ?.candidatePaths.map(normalizePath)
    ).toContain(
      '/app/backend/database/migrations/20260722_service_business_assignment_contract.sql'
    );
    expect(
      actual.migrationSpecs
        .find((spec) => spec.name === '20260823_quote_payment_recovery')
        ?.candidatePaths.map(normalizePath)
    ).toContain('/app/backend/database/migrations/20260823_quote_payment_recovery.sql');
    await expect(actual.readText(actual.migrationSpecs[1].candidatePaths[0]!)).resolves.toContain(
      'CREATE TABLE IF NOT EXISTS task_reservations'
    );
    expect(actual.createClient('postgres://runtime')).toEqual({
      connect: expect.any(Function),
      end: expect.any(Function),
      query: expect.any(Function),
    });
  });

  it('packages every required migration in the production image', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'COPY --from=builder /app/backend/database/migrations ./backend/database/migrations'
    );
    for (const spec of productionMigrationRuntime().migrationSpecs) {
      expect(
        spec.candidatePaths.map((candidatePath) => candidatePath.replaceAll('\\', '/'))
      ).toEqual(
        expect.arrayContaining([expect.stringMatching(/^\/app\/backend\/database\/migrations\//)])
      );
    }
  });

  it('keeps the frozen pre-audit upgrade convergence count aligned with its predecessor chain', () => {
    const assertionSql = readFileSync(
      resolve(process.cwd(), 'backend/tests/integration/upgrade-convergence-assert.pg.sql'),
      'utf8'
    );
    const migrationSpecs = productionMigrationRuntime().migrationSpecs;
    const occurrenceAuditIndex = migrationSpecs.findIndex(
      ({ name }) => name === '20261005_universal_v1_occurrence_access_audit_v1'
    );
    expect(occurrenceAuditIndex).toBe(migrationSpecs.length - 8);
    expect(migrationSpecs.slice(occurrenceAuditIndex).map(({ name }) => name)).toEqual([
      '20261005_universal_v1_occurrence_access_audit_v1',
      '20261006_stage1_legacy_authority_containment_v1',
      '20261007_subscription_cancellation_recovery_v1',
      '20261008_universal_v1_work_order_task_state_containment_v1',
      '20261009_universal_v1_standardized_quote_readiness_v1',
      '20261010_universal_v1_financial_security_event_expiry_v1',
      '20261012_universal_v1_work_order_command_authority_v2',
      '20261014_universal_v1_work_order_command_ports_v1',
    ]);
    expect(assertionSql).toContain(
      `count(*)=${occurrenceAuditIndex} AND count(DISTINCT name)=${occurrenceAuditIndex}`
    );
    expect(assertionSql).toContain(`the exact ${occurrenceAuditIndex}-migration engine chain`);
  });

  it('keeps the restored foundational-table migration PostgreSQL-valid', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'backend/database/migrations/add_missing_tables_v2.sql'),
      'utf8'
    );
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS worker_skills');
    expect(migrationSql).toContain('ON plan_entitlements(user_id, risk_level, expires_at)');
    expect(migrationSql).not.toContain('WHERE expires_at > NOW()');
  });

  it('loads the first non-empty migration and records failed candidates', async () => {
    const readText = vi.fn(async (filePath: string) => {
      if (filePath === '/empty.sql') return '  ';
      if (filePath === '/good.sql') return 'SELECT 1;';
      throw new Error('missing');
    });
    await expect(
      loadMigrationSql(
        runtime({
          migrationSpecs: [
            {
              name: ENGINE_AUTOMATION_MIGRATION,
              candidatePaths: ['/missing.sql', '/empty.sql', '/good.sql'],
            },
          ],
          readText,
        })
      )
    ).resolves.toEqual({ sql: 'SELECT 1;', sourcePath: '/good.sql' });
    expect(readText).toHaveBeenCalledTimes(3);
  });

  it('fails closed when every migration candidate is unusable', async () => {
    await expect(
      loadMigrationSql(
        runtime({
          migrationSpecs: [
            {
              name: ENGINE_AUTOMATION_MIGRATION,
              candidatePaths: ['/missing.sql', '/empty.sql'],
            },
          ],
          readText: vi.fn(async (filePath: string) =>
            filePath === '/empty.sql' ? '' : Promise.reject('missing')
          ),
        })
      )
    ).rejects.toThrow(`Required migration ${ENGINE_AUTOMATION_MIGRATION} is unavailable`);
  });

  it('executes the exact baseline only on an empty catalog and atomically writes its immutable receipt', async () => {
    const client = clientWithBaselineCatalog();
    await expect(
      ensureConstitutionalBaseline(
        client,
        BASELINE_ENTRY,
        localBaselineSession(client, BASELINE_ENTRY)
      )
    ).resolves.toBeUndefined();

    const beginIndex = client.queries.indexOf('BEGIN');
    const lockIndex = client.queries.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock(hashtext('hustlexp-constitutional-bootstrap'))")
    );
    const emptyReadbackIndex = client.queries.findIndex((sql) =>
      sql.includes('AS user_objects_exist')
    );
    const baselineIndex = client.queries.indexOf(BASELINE_ENTRY.sql);
    const receiptDdlIndex = client.queries.findIndex((sql) =>
      sql.includes('CREATE TABLE public.hustlexp_constitutional_baseline_receipts')
    );
    const receiptInsertIndex = client.queries.findIndex((sql) =>
      sql.includes('INSERT INTO public.hustlexp_constitutional_baseline_receipts')
    );
    const receiptReadbackIndex = client.queries.findLastIndex((sql) =>
      sql.includes('AS receipt_count')
    );
    const commitIndex = client.queries.lastIndexOf('COMMIT');
    expect([
      beginIndex,
      lockIndex,
      emptyReadbackIndex,
      baselineIndex,
      receiptDdlIndex,
      receiptInsertIndex,
      receiptReadbackIndex,
      commitIndex,
    ]).toEqual(
      [
        ...[
          beginIndex,
          lockIndex,
          emptyReadbackIndex,
          baselineIndex,
          receiptDdlIndex,
          receiptInsertIndex,
          receiptReadbackIndex,
          commitIndex,
        ],
      ].sort((left, right) => left - right)
    );
    expect(receiptDdlIndex).toBeGreaterThan(baselineIndex);
    expect(client.queries[receiptDdlIndex]).toContain(
      'BEFORE UPDATE OR DELETE ON public.hustlexp_constitutional_baseline_receipts'
    );
    expect(client.queries[receiptDdlIndex]).toContain(
      'BEFORE TRUNCATE ON public.hustlexp_constitutional_baseline_receipts'
    );
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('replays only from an exact baseline SHA receipt under the advisory lock', async () => {
    const client = clientWithBaselineCatalog({ receipt: {} });
    await expect(
      ensureConstitutionalBaseline(
        client,
        BASELINE_ENTRY,
        localBaselineSession(client, BASELINE_ENTRY)
      )
    ).resolves.toBeUndefined();

    expect(client.queries).not.toContain(BASELINE_ENTRY.sql);
    expect(client.queries.some((sql) => sql.includes('AS user_objects_exist'))).toBe(false);
    expect(
      client.queries.some((sql) =>
        sql.includes('CREATE TABLE public.hustlexp_constitutional_baseline_receipts')
      )
    ).toBe(false);
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('accepts only a separately reconciled legacy receipt carrying a catalog digest', async () => {
    const client = clientWithBaselineCatalog({
      receipt: {
        provenance: 'LEGACY_CATALOG_RECONCILED',
        reconciliationSha256: 'b'.repeat(64),
      },
    });
    await expect(
      ensureConstitutionalBaseline(
        client,
        BASELINE_ENTRY,
        localBaselineSession(client, BASELINE_ENTRY)
      )
    ).resolves.toBeUndefined();
    expect(client.queries).not.toContain(BASELINE_ENTRY.sql);
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('holds a legacy or partially initialized catalog that has no exact receipt', async () => {
    const client = clientWithBaselineCatalog({ userObjectsExist: true });
    await expect(
      ensureConstitutionalBaseline(
        client,
        BASELINE_ENTRY,
        localBaselineSession(client, BASELINE_ENTRY)
      )
    ).rejects.toThrow(
      'CONSTITUTIONAL_BASELINE_PROVENANCE_MISSING:LEGACY_CATALOG_RECONCILIATION_REQUIRED'
    );
    expect(client.queries).not.toContain(BASELINE_ENTRY.sql);
    expect(
      client.queries.some((sql) =>
        sql.includes('CREATE TABLE public.hustlexp_constitutional_baseline_receipts')
      )
    ).toBe(false);
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it.each([
    ['baseline SHA drift', { baselineSha256: 'f'.repeat(64) }],
    ['multiple receipt rows', { receiptCount: 2 }],
    ['non-singleton receipt', { singletonTrue: false }],
    ['missing immutable trigger', { immutableTriggerCount: 1 }],
    ['missing schema_versions', { schemaVersionsExists: false }],
    [
      'unattested legacy reconciliation',
      { provenance: 'LEGACY_CATALOG_RECONCILED', reconciliationSha256: null },
    ],
  ] as const)('rejects %s without executing baseline bytes', async (_label, receipt) => {
    const client = clientWithBaselineCatalog({ receipt });
    await expect(
      ensureConstitutionalBaseline(
        client,
        BASELINE_ENTRY,
        localBaselineSession(client, BASELINE_ENTRY)
      )
    ).rejects.toThrow('CONSTITUTIONAL_BASELINE_RECEIPT_MISMATCH');
    expect(client.queries).not.toContain(BASELINE_ENTRY.sql);
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('refuses direct raw writers before their first query without an issued session', async () => {
    const migrationClient = clientWithQueries();
    const fabricated = {} as ReturnType<typeof localMigrationSession>;

    await expect(
      applyEngineAutomationMigration(migrationClient, 'SELECT 1;', '/migration.sql', fabricated)
    ).rejects.toThrow('MIGRATION_EXECUTION_REFUSED:OPAQUE_EXECUTION_SESSION_REQUIRED');
    await expect(backfillLegacyTaskLocations(migrationClient, fabricated)).rejects.toThrow(
      'MIGRATION_EXECUTION_REFUSED:OPAQUE_EXECUTION_SESSION_REQUIRED'
    );
    expect(migrationClient.query).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'SQL hash drift',
      sql: 'SELECT 2;',
      sourcePath: '/migration.sql',
      migrationName: ENGINE_AUTOMATION_MIGRATION,
    },
    {
      label: 'source-path substitution',
      sql: 'SELECT 1;',
      sourcePath: '/substituted.sql',
      migrationName: ENGINE_AUTOMATION_MIGRATION,
    },
    {
      label: 'migration-name substitution',
      sql: 'SELECT 1;',
      sourcePath: '/migration.sql',
      migrationName: 'unauthorized_migration',
    },
  ])('refuses $label before BEGIN or any query', async ({ sql, sourcePath, migrationName }) => {
    const migrationClient = clientWithQueries();
    const session = localMigrationSession(migrationClient, [
      {
        name: ENGINE_AUTOMATION_MIGRATION,
        sql: 'SELECT 1;',
        sourcePath: '/migration.sql',
      },
    ]);

    await expect(
      applyEngineAutomationMigration(migrationClient, sql, sourcePath, session, migrationName)
    ).rejects.toThrow('MIGRATION_NOT_IN_EXACT_AUTHORIZED_ARTIFACT');
    expect(migrationClient.query).not.toHaveBeenCalled();
  });

  it('refuses an exact operation when the opaque session is rebound to another client', async () => {
    const authorizedClient = clientWithQueries();
    const substitutedClient = clientWithQueries();
    const session = localMigrationSession(authorizedClient, [
      {
        name: ENGINE_AUTOMATION_MIGRATION,
        sql: 'SELECT 1;',
        sourcePath: '/migration.sql',
      },
    ]);

    await expect(
      applyEngineAutomationMigration(substitutedClient, 'SELECT 1;', '/migration.sql', session)
    ).rejects.toThrow('CONNECTED_MIGRATION_CLIENT_MISMATCH');
    expect(substitutedClient.query).not.toHaveBeenCalled();
  });

  it('applies and records the migration atomically', async () => {
    const client = clientWithQueries();
    const sql = 'ALTER TABLE tasks ADD COLUMN demo TEXT;';
    const outcome = await applyEngineAutomationMigration(
      client,
      sql,
      '/migration.sql',
      localMigrationSession(client, [
        { name: ENGINE_AUTOMATION_MIGRATION, sql, sourcePath: '/migration.sql' },
      ])
    );
    expect(outcome.status).toBe('applied');
    expect(outcome.sha256).toBe(sha256(sql));
    expect(client.queries).toContain(sql);
    expect(client.queries).toContain(
      'INSERT INTO public.applied_migrations (name, sha256) VALUES ($1, $2)'
    );
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('issues no SQL after an ambiguous migration COMMIT', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    const baseQuery = query.getMockImplementation()!;
    const commitError = new Error('commit outcome ambiguous');
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'COMMIT') {
        client.queries.push(sql);
        throw commitError;
      }
      return baseQuery(sql, values);
    });
    const sql = 'ALTER TABLE tasks ADD COLUMN ambiguous_demo TEXT;';

    await expect(
      applyEngineAutomationMigration(
        client,
        sql,
        '/migration.sql',
        localMigrationSession(client, [
          { name: ENGINE_AUTOMATION_MIGRATION, sql, sourcePath: '/migration.sql' },
        ])
      )
    ).rejects.toBe(commitError);

    expect(client.queries.at(-1)).toBe('COMMIT');
    expect(client.queries).not.toContain('ROLLBACK');
  });

  it('replays without executing the migration SQL', async () => {
    const sql = 'SHOULD NOT RUN';
    const client = clientWithQueries(sha256(sql));
    const outcome = await applyEngineAutomationMigration(
      client,
      sql,
      '/migration.sql',
      localMigrationSession(client, [
        { name: ENGINE_AUTOMATION_MIGRATION, sql, sourcePath: '/migration.sql' },
      ])
    );
    expect(outcome.status).toBe('already_applied');
    expect(outcome.sha256).toBe(sha256(sql));
    expect(client.queries).not.toContain(sql);
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('fails closed when a legacy applied migration has no checksum evidence', async () => {
    const client = clientWithQueries(null);
    await expect(
      applyEngineAutomationMigration(
        client,
        'SELECT 1;',
        '/migration.sql',
        localMigrationSession(client, [
          { name: ENGINE_AUTOMATION_MIGRATION, sql: 'SELECT 1;', sourcePath: '/migration.sql' },
        ])
      )
    ).rejects.toThrow('MIGRATION_CHECKSUM_MISSING');
    expect(client.queries).not.toContain('SELECT 1;');
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('fails closed when the exact migration SQL drifts after application', async () => {
    const client = clientWithQueries(sha256('SELECT original;'));
    await expect(
      applyEngineAutomationMigration(
        client,
        'SELECT changed;',
        '/migration.sql',
        localMigrationSession(client, [
          {
            name: ENGINE_AUTOMATION_MIGRATION,
            sql: 'SELECT changed;',
            sourcePath: '/migration.sql',
          },
        ])
      )
    ).rejects.toThrow('MIGRATION_CHECKSUM_DRIFT');
    expect(client.queries).not.toContain('SELECT changed;');
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back, preserves the original failure, and permits an exact retry', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    const baseQuery = query.getMockImplementation()!;
    let failMigration = true;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BROKEN SQL' && failMigration) {
        client.queries.push(sql);
        failMigration = false;
        throw new Error('migration exploded');
      }
      return baseQuery(sql, values);
    });
    const session = localMigrationSession(client, [
      {
        name: ENGINE_AUTOMATION_MIGRATION,
        sql: 'BROKEN SQL',
        sourcePath: '/migration.sql',
      },
    ]);
    await expect(
      applyEngineAutomationMigration(client, 'BROKEN SQL', '/migration.sql', session)
    ).rejects.toThrow('migration exploded');
    expect(client.queries.at(-1)).toBe('ROLLBACK');

    await expect(
      applyEngineAutomationMigration(client, 'BROKEN SQL', '/migration.sql', session)
    ).resolves.toMatchObject({ status: 'applied', migration: ENGINE_AUTOMATION_MIGRATION });
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('atomically replaces legacy plaintext locations with authenticated ciphertext', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    const baseQuery = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('SELECT task_id::text')) {
        return { rows: [{ task_id: 'task-legacy-1', exact_location: '123 Main St' }] };
      }
      return baseQuery(sql, values);
    });

    await expect(backfillLegacyTaskLocations(client, localMigrationSession(client))).resolves.toBe(
      1
    );
    const update = queries.find(({ sql }) => sql.includes('UPDATE task_location_vault'));
    expect(update?.values?.[0]).toBe('task-legacy-1');
    expect(update?.values).not.toContain('123 Main St');
    expect(update?.values?.[4]).toBe('location-test-v1');
    expect(queries.at(-1)?.sql).toBe('COMMIT');
  });

  it('fails startup before opening the database when the vault key is unavailable', async () => {
    delete process.env.TASK_LOCATION_ENCRYPTION_KEY;
    const createClient = vi.fn(() => clientWithQueries());
    await expect(runEngineAutomationMigration(runtime({ createClient }))).rejects.toThrow(
      'TASK_LOCATION_ENCRYPTION_KEY'
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it('connects, applies, logs, and always closes the runtime client', async () => {
    const client = clientWithQueries();
    await expect(
      runEngineAutomationMigration(runtime({ createClient: () => client }))
    ).resolves.toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('applies every required migration in declared order', async () => {
    const client = clientWithQueries();
    const migrationSpecs = [
      { name: 'first', candidatePaths: ['/first.sql'] },
      { name: 'second', candidatePaths: ['/second.sql'] },
    ];
    const actual = await runEngineAutomationMigration(
      runtime({
        migrationSpecs,
        readText: vi.fn(async (filePath: string) => `SELECT '${filePath}';`),
        createClient: () => client,
      })
    );
    expect(actual.map((outcome) => outcome.migration)).toEqual(['first', 'second']);
    expect(client.queries).toContain("SELECT '/first.sql';");
    expect(client.queries).toContain("SELECT '/second.sql';");
  });

  it('closes the client after an application failure', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    query.mockRejectedValueOnce(new Error('begin failed'));
    await expect(
      runEngineAutomationMigration(runtime({ createClient: () => client }))
    ).rejects.toThrow('begin failed');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('refuses to create a client without DATABASE_URL', async () => {
    const createClient = vi.fn(() => clientWithQueries());
    await expect(
      runEngineAutomationMigration(runtime({ databaseUrl: '', createClient }))
    ).rejects.toThrow('DATABASE_URL is required');
    expect(createClient).not.toHaveBeenCalled();
  });
});
