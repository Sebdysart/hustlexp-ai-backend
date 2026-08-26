import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  LEGACY_OUTER_TRANSACTION_MIGRATIONS,
  LEGACY_OUTER_TRANSACTION_MIGRATION_COUNT,
  LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES,
  applyEngineAutomationMigration,
  loadMigrationSql,
  normalizeMigrationSqlForAtomicApply,
  productionMigrationRuntime,
  readDatabaseIdentity,
  reconcileLegacyOuterTransactionMigrations,
  runEngineAutomationMigration,
  verifyMigrationDatabasePrivilegeBoundary,
  type MigrationClient,
  type MigrationRuntime,
  type VerifiedDatabaseRole,
} from '../../src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const verifiedRuntimeRole = 'hx_runtime' as VerifiedDatabaseRole;

type RuntimeBoundaryFixture = Partial<{
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
}>;

type MigrationBoundaryFixture = Partial<{
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
}>;

function clientWithQueries(
  existing: boolean | 'drift' | 'legacy' = false,
  identity: Partial<{
    database_name: string;
    database_oid: string;
    cluster_system_identifier: string;
    database_role: string;
    session_role: string;
  }> = {
    database_name: 'hx_test',
    database_role: 'hx_migrator',
  },
  recordedIdentity: false | Partial<{
    database_name: string;
    database_oid: string;
    cluster_system_identifier: string;
    migration_owner: string;
  }> = false,
  existingSourceSha256?: string,
  baselineExists: boolean | boolean[] = true,
  runtimeBoundary: RuntimeBoundaryFixture = {},
  trustedSessionSearchPath = 'pg_catalog, public',
  migrationBoundary: MigrationBoundaryFixture = {}
): MigrationClient & { queries: string[] } {
  const queries: string[] = [];
  let baselineCheckIndex = 0;
  const completeIdentity = {
    database_name: 'hx_test',
    database_oid: '16384',
    cluster_system_identifier: '7623456789012345678',
    database_role: 'hx_migrator',
    ...identity,
    session_role: identity.session_role ?? identity.database_role ?? 'hx_migrator',
  };
  return {
    queries,
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      return {
        rows:
          sql.includes("set_config(\n       'search_path'") && sql.includes('false')
            ? [{ trusted_search_path: trustedSessionSearchPath }]
          : sql.includes('current_database() AS database_name')
            ? [completeIdentity]
            : sql.includes("to_regclass('public.hx_database_identity')")
              ? [{ identity_exists: recordedIdentity !== false }]
            : sql.includes('FROM public.hx_database_identity')
              ? [{
                  database_name: 'hx_test',
                  database_oid: '16384',
                  cluster_system_identifier: '7623456789012345678',
                  migration_owner: 'hx_migrator',
                  ...(recordedIdentity || {}),
                }]
            : sql.includes('migration_role.rolcanlogin AS login_enabled')
              ? [{
                  direct_session_identity: true,
                  login_enabled: true,
                  inherit_enabled: false,
                  elevated_role: false,
                  has_role_memberships: false,
                  owns_database: true,
                  owns_public_schema: true,
                  owns_public_objects: true,
                  owns_foreign_public_objects: false,
                  can_connect_database: true,
                  can_create_database_objects: true,
                  can_create_temporary_objects: true,
                  can_use_public_schema: true,
                  can_create_public_objects: true,
                  can_set_session_replication_role: false,
                  replication_role_is_origin: true,
                  ...migrationBoundary,
                }]
            : sql.includes("to_regclass('public.schema_versions')")
              ? [{
                  baseline_exists: Array.isArray(baselineExists)
                    ? baselineExists[Math.min(baselineCheckIndex++, baselineExists.length - 1)]
                    : baselineExists,
                }]
            : sql.includes('current_user = session_user AS direct_session_identity')
              ? [{
                  direct_session_identity: true,
                  trusted_search_path: true,
                  replication_role_is_origin: true,
                }]
            : sql.includes('AS elevated_role')
              ? [{
                  elevated_role: false,
                  can_create_database_objects: false,
                  can_create_public_objects: false,
                  can_create_temporary_objects: false,
                  can_create_triggers: false,
                  can_set_session_replication_role: false,
                  has_role_memberships: false,
                  owns_database: false,
                  owns_public_schema: false,
                  owns_public_objects: false,
                  replication_role_is_origin: true,
                  ...runtimeBoundary,
                }]
            : sql.includes('FROM public.applied_migrations') && existing
              ? [{
                  name: values?.[0],
                  ordinal: existing === 'legacy' ? null : values?.[1],
                  source_sha256: existing === 'legacy'
                    ? null
                    : existing === 'drift'
                      ? '0'.repeat(64)
                      : existingSourceSha256,
                }]
              : [],
      };
    }) as MigrationClient['query'],
  };
}

function runtime(overrides: Partial<MigrationRuntime> = {}): MigrationRuntime {
  return {
    runtimeDatabaseUrl: 'postgres://hx_runtime:runtime@db/hx_test',
    migrationDatabaseUrl: 'postgres://hx_migrator:migrator@db/hx_test',
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
    createClient: vi.fn((databaseUrl: string) =>
      clientWithQueries(false, {
        database_name: 'hx_test',
        database_role: databaseUrl.includes('hx_runtime') ? 'hx_runtime' : 'hx_migrator',
      })
    ),
    ...overrides,
  };
}

describe('required engine automation migration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
  const originalExpectedDatabaseName = process.env.HX_MIGRATION_EXPECTED_DATABASE_NAME;
  const originalExpectedDatabaseOid = process.env.HX_MIGRATION_EXPECTED_DATABASE_OID;
  const originalExpectedCluster = process.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER;
  const originalLocationKey = process.env.TASK_LOCATION_ENCRYPTION_KEY;
  const originalLocationKeyId = process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalMigrationDatabaseUrl === undefined) delete process.env.MIGRATION_DATABASE_URL;
    else process.env.MIGRATION_DATABASE_URL = originalMigrationDatabaseUrl;
    if (originalExpectedDatabaseName === undefined) {
      delete process.env.HX_MIGRATION_EXPECTED_DATABASE_NAME;
    } else process.env.HX_MIGRATION_EXPECTED_DATABASE_NAME = originalExpectedDatabaseName;
    if (originalExpectedDatabaseOid === undefined) {
      delete process.env.HX_MIGRATION_EXPECTED_DATABASE_OID;
    } else process.env.HX_MIGRATION_EXPECTED_DATABASE_OID = originalExpectedDatabaseOid;
    if (originalExpectedCluster === undefined) {
      delete process.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER;
    } else process.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER = originalExpectedCluster;
    if (originalLocationKey === undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY;
    else process.env.TASK_LOCATION_ENCRYPTION_KEY = originalLocationKey;
    if (originalLocationKeyId === undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;
    else process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = originalLocationKeyId;
  });

  it('builds production filesystem and PostgreSQL adapters without opening a connection', async () => {
    process.env.DATABASE_URL = 'postgres://hx_runtime:runtime@db/hx';
    process.env.MIGRATION_DATABASE_URL = 'postgres://hx_migrator:migrator@db/hx';
    process.env.HX_MIGRATION_EXPECTED_DATABASE_NAME = 'hx';
    process.env.HX_MIGRATION_EXPECTED_DATABASE_OID = '16384';
    process.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER = '7623456789012345678';
    const actual = productionMigrationRuntime();
    expect(actual.runtimeDatabaseUrl).toBe('postgres://hx_runtime:runtime@db/hx');
    expect(actual.migrationDatabaseUrl).toBe('postgres://hx_migrator:migrator@db/hx');
    expect(actual.requireExpectedDatabaseIdentity).toBe(true);
    expect(actual.expectedDatabaseIdentity).toEqual({
      database: 'hx',
      databaseOid: '16384',
      clusterSystemIdentifier: '7623456789012345678',
    });
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
      '20260819_ops_web_hardening',
      '20260821_ops_business_claim_links',
      '20260821_business_ownership',
      '20260821_business_claim_links_extra',
      '20260823_business_fulfiller_lifecycle',
      '20260823_business_payout_tables',
      '20260824_enforce_controlled_test_business_acceptance',
      '20260824_business_controlled_test_acceptance',
      '20260824_orchestration_mode',
      '20260823_quote_payment_recovery',
      '20260825_pr276_incident_containment',
    ]);
    expect(actual.requireCanonicalMigrationInventory).toBe(true);
    expect(actual.bootstrapSpec?.candidatePaths).toContain(
      '/app/backend/database/constitutional-schema.sql'
    );
    expect(actual.migrationSpecs[0].candidatePaths).toContain(
      '/app/backend/database/migrations/add_missing_tables_v2.sql'
    );
    expect(actual.migrationSpecs.find(
      (spec) => spec.name === SERVICE_BUSINESS_ASSIGNMENT_CONTRACT_MIGRATION,
    )?.candidatePaths).toContain(
      '/app/backend/database/migrations/20260722_service_business_assignment_contract.sql'
    );
    expect(actual.migrationSpecs.at(-1)?.candidatePaths).toContain(
      '/app/backend/database/migrations/20260825_pr276_incident_containment.sql'
    );
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
      expect(spec.candidatePaths).toEqual(
        expect.arrayContaining([expect.stringMatching(/^\/app\/backend\/database\/migrations\//)])
      );
    }
  });

  it('keeps the fresh-upgrade convergence count aligned with the required chain', () => {
    const assertionSql = readFileSync(
      resolve(process.cwd(), 'backend/tests/integration/upgrade-convergence-assert.pg.sql'),
      'utf8'
    );
    const requiredCount = productionMigrationRuntime().migrationSpecs.length + 1;
    expect(assertionSql).toContain(
      `count(*)=${requiredCount} AND count(DISTINCT name)=${requiredCount}`
    );
    expect(assertionSql).toContain(
      `constitutional bootstrap plus exact ${requiredCount - 1}-migration engine chain`
    );
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
    ).resolves.toEqual({
      sql: 'SELECT 1;',
      sourcePath: '/good.sql',
      sourceSha256: createHash('sha256').update('SELECT 1;', 'utf8').digest('hex'),
    });
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

  it('parses and records the constitutional bootstrap as ordinal zero with its exact source hash', async () => {
    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    }, false, undefined, [false, true]);
    const bootstrapSql = 'SELECT 42;';
    await expect(
      runEngineAutomationMigration(runtime({
        bootstrapSpec: {
          name: 'constitutional_schema_v1',
          candidatePaths: ['/bootstrap.sql'],
        },
        readText: vi.fn(async (filePath: string) =>
          filePath === '/bootstrap.sql' ? bootstrapSql : 'SELECT 1;'
        ),
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).resolves.toEqual([expect.objectContaining({ status: 'applied' })]);
    const bootstrapInsert = (migrationClient.query as ReturnType<typeof vi.fn>).mock.calls.find(
      ([sql, values]) => String(sql).includes('INSERT INTO public.applied_migrations')
        && Array.isArray(values)
        && values[1] === 0
    );
    expect(bootstrapInsert?.[1]).toEqual([
      'constitutional_schema_v1',
      0,
      createHash('sha256').update(bootstrapSql, 'utf8').digest('hex'),
    ]);
    expect(migrationClient.queries).toContain(bootstrapSql);
  });

  it('refuses to stamp an existing unledgered schema as the packaged bootstrap', async () => {
    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });
    const bootstrapSql = 'SELECT 42;';

    await expect(
      runEngineAutomationMigration(runtime({
        bootstrapSpec: {
          name: 'constitutional_schema_v1',
          candidatePaths: ['/bootstrap.sql'],
        },
        readText: vi.fn(async (filePath: string) =>
          filePath === '/bootstrap.sql' ? bootstrapSql : 'SELECT 1;'
        ),
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Required engine migration failed');
    expect(migrationClient.queries).not.toContain(bootstrapSql);
    expect(migrationClient.queries.some((sql) =>
      sql.includes('INSERT INTO public.applied_migrations')
    )).toBe(false);
    expect(migrationClient.queries.at(-1)).toBe('ROLLBACK');
  });

  it('rejects transaction control in the constitutional bootstrap before opening a client', async () => {
    const createClient = vi.fn(() => clientWithQueries());
    await expect(
      runEngineAutomationMigration(runtime({
        bootstrapSpec: { name: 'constitutional_schema_v1', candidatePaths: ['/bootstrap.sql'] },
        readText: vi.fn(async (filePath: string) =>
          filePath === '/bootstrap.sql' ? 'COMMIT;' : 'SELECT 1;'
        ),
        createClient,
      }))
    ).rejects.toThrow('Non-allowlisted migration contains top-level transaction control');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('applies and records the migration atomically', async () => {
    const client = clientWithQueries();
    const outcome = await applyEngineAutomationMigration(
      client,
      'ALTER TABLE tasks ADD COLUMN demo TEXT;',
      '/migration.sql',
      verifiedRuntimeRole
    );
    expect(outcome.status).toBe('applied');
    expect(client.queries).toContain('ALTER TABLE tasks ADD COLUMN demo TEXT;');
    expect(client.queries.indexOf('ALTER TABLE tasks ADD COLUMN demo TEXT;')).toBeLessThan(
      client.queries.findIndex((query) => query.includes('INSERT INTO public.applied_migrations'))
    );
    expect(client.queries.findIndex((query) => query.includes('INSERT INTO public.applied_migrations')))
      .toBeLessThan(client.queries.lastIndexOf('COMMIT'));
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('binds the SQL-aware registered-wrapper inventory to the exact immutable allowlist', () => {
    expect(LEGACY_OUTER_TRANSACTION_MIGRATION_COUNT).toBe(35);
    expect(Object.keys(LEGACY_OUTER_TRANSACTION_MIGRATIONS)).toHaveLength(35);
    const inventory = REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      sourcePath: resolve(process.cwd(), `backend/database/migrations/${fileName}`),
      sql: readFileSync(
        resolve(process.cwd(), `backend/database/migrations/${fileName}`),
        'utf8'
      ),
    }));
    expect(reconcileLegacyOuterTransactionMigrations(inventory)).toEqual({
      registeredMigrationCount: 115,
      wrappedMigrationCount: 35,
      allowlistedMigrationCount: 35,
      wrappedMigrationNames: LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES,
    });

    for (const [name, entry] of Object.entries(LEGACY_OUTER_TRANSACTION_MIGRATIONS)) {
      expect(REQUIRED_MIGRATION_FILES).toContainEqual({ name, fileName: entry.fileName });
      const sql = readFileSync(
        resolve(process.cwd(), `backend/database/migrations/${entry.fileName}`),
        'utf8'
      );
      expect(createHash('sha256').update(sql, 'utf8').digest('hex')).toBe(entry.sha256);
      const normalized = normalizeMigrationSqlForAtomicApply(name, sql, entry.fileName);
      expect(normalized).not.toBe(sql);
    }
  });

  it('fails canonical reconciliation on duplicates, missing exceptions, and source drift', () => {
    const canonical = REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      sourcePath: fileName,
      sql: readFileSync(
        resolve(process.cwd(), `backend/database/migrations/${fileName}`),
        'utf8'
      ),
    }));
    expect(() => reconcileLegacyOuterTransactionMigrations([...canonical, canonical[0]!]))
      .toThrow('Registered migration inventory contains duplicate names');
    const firstAllowlisted = canonical.find(({ name }) =>
      LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES.includes(
        name as (typeof LEGACY_OUTER_TRANSACTION_MIGRATION_NAMES)[number]
      )
    )!;
    expect(() => reconcileLegacyOuterTransactionMigrations(
      canonical.filter(({ name }) => name !== firstAllowlisted.name)
    )).toThrow('Registered migration transaction-wrapper inventory mismatch');
    expect(() => reconcileLegacyOuterTransactionMigrations(
      canonical.map((entry) => entry.name === firstAllowlisted.name
        ? { ...entry, sourcePath: 'renamed.sql' }
        : entry)
    )).toThrow('Immutable legacy migration source-file mismatch');
  });

  it('rejects wrapped-but-unregistered, future, drifted, extra, and nested transaction control', () => {
    const [name, entry] = Object.entries(LEGACY_OUTER_TRANSACTION_MIGRATIONS)[0]!;
    const sql = readFileSync(
      resolve(process.cwd(), `backend/database/migrations/${entry.fileName}`),
      'utf8'
    );
    expect(() => normalizeMigrationSqlForAtomicApply(name, `${sql}\n-- drift`, entry.fileName)).toThrow(
      'Immutable legacy migration hash mismatch'
    );
    expect(() => normalizeMigrationSqlForAtomicApply(name, `BEGIN;${sql}COMMIT;`, entry.fileName)).toThrow(
      'Immutable legacy migration hash mismatch'
    );
    expect(() => normalizeMigrationSqlForAtomicApply('not_allowlisted', 'BEGIN; SELECT 1; COMMIT;', 'not_allowlisted.sql'))
      .toThrow('Non-allowlisted migration contains top-level transaction control');
    expect(() => normalizeMigrationSqlForAtomicApply('future_migration', 'SAVEPOINT future;', 'future_migration.sql'))
      .toThrow('Non-allowlisted migration contains top-level transaction control');
    expect(() => normalizeMigrationSqlForAtomicApply('nested_wrapper', 'BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;', 'nested_wrapper.sql'))
      .toThrow('Non-allowlisted migration contains top-level transaction control');
    expect(normalizeMigrationSqlForAtomicApply('ordinary', 'SELECT $$ BEGIN; COMMIT; $$;', 'ordinary.sql'))
      .toBe('SELECT $$ BEGIN; COMMIT; $$;');

    const wrappedButUnregistered = [
      'add_plan_entitlements_table.sql',
      'add_stripe_connect_tables.sql',
      'add_stripe_events_table.sql',
      'add_task_progress_tracking.sql',
      'add_user_plans.sql',
      'migrate_flagged_phrase_counter_to_object.sql',
      'task_template_system.sql',
      'task_template_v2_7.sql',
    ];
    for (const fileName of wrappedButUnregistered) {
      const source = readFileSync(
        resolve(process.cwd(), 'backend/database/migrations', fileName),
        'utf8'
      );
      expect(() => normalizeMigrationSqlForAtomicApply(fileName.slice(0, -4), source, fileName)).toThrow(
        'Non-allowlisted migration contains top-level transaction control'
      );
    }
  });

  it.each([
    ['uppercase escape string before COMMIT', "SELECT E'\\''; COMMIT;"],
    ['lowercase escape string before ROLLBACK', "SELECT e'\\''; ROLLBACK;"],
    ['escape string before SAVEPOINT', "SELECT E'escaped\\\\value'; SAVEPOINT hidden;"],
    ['escape string before RELEASE SAVEPOINT', "SELECT E'escaped\\\\value'; RELEASE SAVEPOINT hidden;"],
  ])('rejects hidden transaction control after %s', (_label, sql) => {
    expect(() => normalizeMigrationSqlForAtomicApply('adversarial', sql, 'adversarial.sql'))
      .toThrow('Non-allowlisted migration contains top-level transaction control');
  });

  it.each([
    ['string literal', "SELECT 'unterminated; COMMIT;"],
    ['escape string literal', "SELECT E'unterminated\\'; COMMIT;"],
    ['ambiguous ordinary backslash-quote', "SELECT '\\''; COMMIT;"],
    ['quoted identifier', 'SELECT "unterminated; ROLLBACK;'],
    ['block comment', 'SELECT 1; /* unterminated COMMIT;'],
    ['dollar quote', 'SELECT $migration$unterminated; SAVEPOINT hidden;'],
  ])('fails closed on an unterminated %s', (_label, sql) => {
    expect(() => normalizeMigrationSqlForAtomicApply('malformed', sql, 'malformed.sql'))
      .toThrow('Migration SQL parsing failed');
  });

  it('rejects COPY FROM STDIN instead of interpreting its payload as migration SQL', () => {
    const sql = 'COPY public.tasks (id) FROM STDIN;\nCOMMIT;\n\\.\n';
    expect(() => normalizeMigrationSqlForAtomicApply('copy_stdin', sql, 'copy_stdin.sql'))
      .toThrow('Migration SQL parsing failed: COPY FROM STDIN is not supported');
  });

  it('treats carriage return as a line-comment terminator and exposes following COMMIT', () => {
    const sql = 'SELECT 1; -- comment\rCOMMIT;';
    expect(() => normalizeMigrationSqlForAtomicApply('cr_comment', sql, 'cr_comment.sql'))
      .toThrow('Non-allowlisted migration contains top-level transaction control');
  });

  it('treats every non-ASCII code point as an identifier character at dollar-quote boundaries', () => {
    const sql = 'SELECT é$txn$; COMMIT; SELECT 1;';
    expect(() => normalizeMigrationSqlForAtomicApply('unicode_boundary', sql, 'unicode.sql'))
      .toThrow('Non-allowlisted migration contains top-level transaction control');
  });

  it('accepts transaction words inside valid strings, dollar quotes, and nested comments', () => {
    for (const sql of [
      "SELECT E'COMMIT;\\''; SELECT 1;",
      "SELECT 'ROLLBACK; SAVEPOINT hidden';",
      'DO $body$ BEGIN RAISE NOTICE \'COMMIT;\'; END $body$;',
      'SELECT 1; /* outer /* ROLLBACK; */ SAVEPOINT hidden; */ SELECT 2;',
    ]) {
      expect(normalizeMigrationSqlForAtomicApply('safe_literals', sql, 'safe_literals.sql'))
        .toBe(sql);
    }
  });

  it('executes every normalized legacy SQL and ledger write inside one outer transaction', async () => {
    for (const [name, entry] of Object.entries(LEGACY_OUTER_TRANSACTION_MIGRATIONS)) {
      const sql = readFileSync(
        resolve(process.cwd(), `backend/database/migrations/${entry.fileName}`),
        'utf8'
      );
      const normalized = normalizeMigrationSqlForAtomicApply(name, sql, entry.fileName);
      const client = clientWithQueries();
      await applyEngineAutomationMigration(
        client,
        normalized,
        `/migration/${entry.fileName}`,
        verifiedRuntimeRole,
        name
      );
      const migrationIndex = client.queries.indexOf(normalized);
      const ledgerIndex = client.queries.findIndex((query) =>
        query.includes('INSERT INTO public.applied_migrations')
      );
      expect(client.queries[0]).toBe('BEGIN');
      expect(client.queries).not.toContain(sql);
      expect(migrationIndex).toBeGreaterThan(0);
      expect(ledgerIndex).toBeGreaterThan(migrationIndex);
      expect(client.queries.at(-1)).toBe('COMMIT');
    }
  });

  it('replays without executing the migration SQL', async () => {
    const sql = 'SHOULD NOT RUN';
    const client = clientWithQueries(
      true,
      undefined,
      false,
      createHash('sha256').update(sql, 'utf8').digest('hex')
    );
    const outcome = await applyEngineAutomationMigration(
      client,
      sql,
      '/migration.sql',
      verifiedRuntimeRole
    );
    expect(outcome.status).toBe('already_applied');
    expect(client.queries).not.toContain('SHOULD NOT RUN');
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('rejects legacy name-only ledger rows and any source identity drift', async () => {
    const legacyClient = clientWithQueries('legacy');
    await expect(
      applyEngineAutomationMigration(
        legacyClient,
        'SELECT 1;',
        '/migration.sql',
        verifiedRuntimeRole
      )
    ).rejects.toThrow('Migration ledger entry lacks exact source identity');
    expect(legacyClient.queries.at(-1)).toBe('ROLLBACK');

    const driftClient = clientWithQueries('drift');
    await expect(
      applyEngineAutomationMigration(
        driftClient,
        'SELECT 1;',
        '/migration.sql',
        verifiedRuntimeRole
      )
    ).rejects.toThrow('Migration ledger source identity drift');
    expect(driftClient.queries.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back and preserves the original migration failure', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string) => {
      client.queries.push(sql);
      if (sql === 'BROKEN SQL') throw new Error('migration exploded');
      if (sql.includes('current_user = session_user AS direct_session_identity')) {
        return {
          rows: [{
            direct_session_identity: true,
            trusted_search_path: true,
            replication_role_is_origin: true,
          }],
        };
      }
      return { rows: [] };
    });
    await expect(
      applyEngineAutomationMigration(client, 'BROKEN SQL', '/migration.sql', verifiedRuntimeRole)
    ).rejects.toThrow('migration exploded');
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('reads the database and authenticated role from PostgreSQL rather than trusting a URL', async () => {
    const client = clientWithQueries(false, {
      database_name: 'hx_identity_test',
      database_role: 'hx_runtime_observed',
    });
    await expect(readDatabaseIdentity(client)).resolves.toEqual({
      database: 'hx_identity_test',
      databaseOid: '16384',
      clusterSystemIdentifier: '7623456789012345678',
      role: 'hx_runtime_observed',
      sessionRole: 'hx_runtime_observed',
    });
    expect(client.queries.some((query) =>
      query.includes('control.system_identifier::text AS cluster_system_identifier')
      && query.includes('session_user AS session_role')
    )).toBe(true);
  });

  it('rejects SET ROLE even when the database and cluster identities otherwise match', async () => {
    const client = clientWithQueries(false, {
      database_name: 'hx_identity_test',
      database_role: 'hx_migrator',
      session_role: 'login_admin',
    });
    await expect(readDatabaseIdentity(client)).rejects.toThrow(
      'Database identity verification rejected SET ROLE session'
    );
  });

  it('accepts only the direct non-inheriting migration owner with exact required capabilities', async () => {
    const client = clientWithQueries();
    await expect(verifyMigrationDatabasePrivilegeBoundary(client)).resolves.toBeUndefined();
    expect(client.queries).not.toContain('BEGIN');
    expect(client.queries[0]).toContain('migration_role.rolcanlogin AS login_enabled');
    expect(client.queries[0]).toContain('target_database.datdba = migration_role.oid');
    expect(client.queries[0]).toContain("role_row.rolname = 'pg_database_owner'");
    expect(client.queries[0]).toContain('class_row.relowner <> migration_role.oid');
  });

  it('rejects every migration-role escalation, ownership drift, and missing capability before BEGIN', async () => {
    const unsafeBoundaries: MigrationBoundaryFixture[] = [
      { direct_session_identity: false },
      { login_enabled: false },
      { inherit_enabled: true },
      { elevated_role: true },
      { has_role_memberships: true },
      { owns_database: false },
      { owns_public_schema: false },
      { owns_public_objects: false },
      { owns_foreign_public_objects: true },
      { can_connect_database: false },
      { can_create_database_objects: false },
      { can_create_temporary_objects: false },
      { can_use_public_schema: false },
      { can_create_public_objects: false },
      { can_set_session_replication_role: true },
      { replication_role_is_origin: false },
    ];

    for (const unsafeBoundary of unsafeBoundaries) {
      const client = clientWithQueries(
        false,
        undefined,
        false,
        undefined,
        true,
        {},
        'pg_catalog, public',
        unsafeBoundary
      );
      await expect(verifyMigrationDatabasePrivilegeBoundary(client)).rejects.toThrow(
        'Migration database privilege boundary verification failed'
      );
      expect(client.queries).not.toContain('BEGIN');
    }
  });

  it('does not require a runtime vault key or perform an unledgered location rewrite', async () => {
    delete process.env.TASK_LOCATION_ENCRYPTION_KEY;
    delete process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;
    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });
    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).resolves.toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(migrationClient.queries.join('\n')).not.toMatch(
      /task_location_vault|exact_location|Legacy exact-location encryption backfill/i
    );
  });

  it('reconciles the canonical inventory before creating either database client', async () => {
    const createClient = vi.fn(() => clientWithQueries());
    await expect(
      runEngineAutomationMigration(runtime({
        requireCanonicalMigrationInventory: true,
        createClient,
      }))
    ).rejects.toThrow('Registered migration transaction-wrapper inventory mismatch');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('connects through distinct identities, applies, and always closes both clients', async () => {
    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });
    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).resolves.toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(runtimeClient.connect).toHaveBeenCalledOnce();
    expect(runtimeClient.end).toHaveBeenCalledOnce();
    expect(migrationClient.connect).toHaveBeenCalledOnce();
    expect(migrationClient.end).toHaveBeenCalledOnce();
    expect(runtimeClient.queries[0]).toContain("pg_catalog.set_config(\n       'search_path'");
    expect(runtimeClient.queries[0]).toContain('false');
    expect(migrationClient.queries[0]).toContain("pg_catalog.set_config(\n       'search_path'");
    expect(migrationClient.queries[0]).toContain('false');
    expect(migrationClient.queries).toContain(
      `SELECT pg_catalog.set_config('hustlexp.runtime_database_role', $1, true)`
    );
  });

  it('rejects a failed session search_path pin before identity reads or effects', async () => {
    const runtimeClient = clientWithQueries(
      false,
      { database_name: 'hx_test', database_role: 'hx_runtime' },
      false,
      undefined,
      true,
      {},
      'public'
    );
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });

    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Runtime database identity verification failed');
    expect(runtimeClient.queries).toHaveLength(1);
    expect(runtimeClient.queries[0]).toContain('pg_catalog.set_config');
    expect(migrationClient.connect).not.toHaveBeenCalled();
  });

  it('schema-qualifies every builtin used before the trusted search path is proven', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration.ts'),
      'utf8'
    );
    expect(source).toContain('pg_catalog.set_config');
    expect(source).toContain('pg_catalog.current_setting');
    expect(source).toContain('pg_catalog.current_database');
    expect(source).toContain('pg_catalog.to_regclass');
    expect(source).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(source).toContain('pg_catalog.hashtext');
    expect(source).not.toMatch(/(?<!pg_catalog\.)\bset_config\s*\(/);
    expect(source).not.toMatch(/(?<!pg_catalog\.)\bcurrent_setting\s*\(/);
    expect(source).not.toMatch(/(?<!pg_catalog\.)\bcurrent_database\s*\(/);
    expect(source).not.toMatch(/(?<!pg_catalog\.)\bto_regclass\s*\(/);
  });

  it('applies every required migration in declared order', async () => {
    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });
    const migrationSpecs = [
      { name: 'first', candidatePaths: ['/first.sql'] },
      { name: 'second', candidatePaths: ['/second.sql'] },
    ];
    const actual = await runEngineAutomationMigration(
      runtime({
        migrationSpecs,
        readText: vi.fn(async (filePath: string) => `SELECT '${filePath}';`),
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      })
    );
    expect(actual.map((outcome) => outcome.migration)).toEqual(['first', 'second']);
    expect(migrationClient.queries).toContain("SELECT '/first.sql';");
    expect(migrationClient.queries).toContain("SELECT '/second.sql';");
  });

  it('closes the client after an application failure', async () => {
    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });
    const query = migrationClient.query as ReturnType<typeof vi.fn>;
    query.mockRejectedValueOnce(new Error('identity failed'));
    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Required engine migration failed');
    expect(runtimeClient.end).toHaveBeenCalledOnce();
    expect(migrationClient.end).toHaveBeenCalledOnce();
  });

  it('refuses to create a client without either required migration boundary URL', async () => {
    const createClient = vi.fn(() => clientWithQueries());
    await expect(
      runEngineAutomationMigration(runtime({ runtimeDatabaseUrl: '', createClient }))
    ).rejects.toThrow('Migration database configuration rejected');
    await expect(
      runEngineAutomationMigration(runtime({ migrationDatabaseUrl: '', createClient }))
    ).rejects.toThrow('Migration database configuration rejected');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('requires an external immutable endpoint anchor for canonical migration execution', async () => {
    const createClient = vi.fn(() => clientWithQueries());
    await expect(
      runEngineAutomationMigration(runtime({
        requireExpectedDatabaseIdentity: true,
        expectedDatabaseIdentity: undefined,
        createClient,
      }))
    ).rejects.toThrow('Expected migration database identity is required');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('fails closed when independently queried identities collapse or target different databases', async () => {
    const sameRoleClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_runtime',
    });
    await expect(
      runEngineAutomationMigration(runtime({ createClient: () => sameRoleClient }))
    ).rejects.toThrow('Required engine migration failed');

    const runtimeClient = clientWithQueries(false, {
      database_name: 'hx_runtime_db',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_migration_db',
      database_role: 'hx_migrator',
    });
    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Required engine migration failed');

    const wrongClusterRuntime = clientWithQueries(false, {
      database_name: 'hx_test',
      database_oid: '16384',
      cluster_system_identifier: '1111111111111111111',
      database_role: 'hx_runtime',
    });
    const wrongClusterMigrator = clientWithQueries(false, {
      database_name: 'hx_test',
      database_oid: '16384',
      cluster_system_identifier: '2222222222222222222',
      database_role: 'hx_migrator',
    });
    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime')
          ? wrongClusterRuntime
          : wrongClusterMigrator,
      }))
    ).rejects.toThrow('Required engine migration failed');
  });

  it('rejects every unsafe runtime privilege path before the migrator connects or effects begin', async () => {
    const unsafeBoundaries: RuntimeBoundaryFixture[] = [
      { elevated_role: true },
      { can_create_database_objects: true },
      { can_create_public_objects: true },
      { can_create_temporary_objects: true },
      { can_create_triggers: true },
      { can_set_session_replication_role: true },
      { has_role_memberships: true },
      { owns_database: true },
      { owns_public_schema: true },
      { owns_public_objects: true },
      { replication_role_is_origin: false },
    ];

    for (const unsafeBoundary of unsafeBoundaries) {
      const runtimeClient = clientWithQueries(
        false,
        { database_name: 'hx_test', database_role: 'hx_runtime' },
        false,
        undefined,
        true,
        unsafeBoundary
      );
      const migrationClient = clientWithQueries(false, {
        database_name: 'hx_test',
        database_role: 'hx_migrator',
      });

      await expect(
        runEngineAutomationMigration(runtime({
          createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
        }))
      ).rejects.toThrow('Runtime database identity verification failed');
      expect(runtimeClient.queries).not.toContain('BEGIN');
      expect(migrationClient.connect).not.toHaveBeenCalled();
    }
  });

  it('rejects a live connection that disagrees with the immutable recorded endpoint before effects', async () => {
    const runtimeClient = clientWithQueries(
      false,
      { database_name: 'hx_test', database_role: 'hx_runtime' },
      { database_name: 'wrong_database' }
    );
    const migrationClient = clientWithQueries(false, {
      database_name: 'hx_test',
      database_role: 'hx_migrator',
    });

    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Runtime database identity verification failed');
    expect(runtimeClient.queries).not.toContain('BEGIN');
    expect(migrationClient.connect).not.toHaveBeenCalled();
  });

  it('rejects an unrecorded wrong endpoint against the external anchor before effects', async () => {
    const runtimeClient = clientWithQueries(false, {
      database_name: 'wrong_database',
      database_oid: '99999',
      cluster_system_identifier: '1111111111111111111',
      database_role: 'hx_runtime',
    });
    const migrationClient = clientWithQueries(false, {
      database_name: 'wrong_database',
      database_oid: '99999',
      cluster_system_identifier: '1111111111111111111',
      database_role: 'hx_migrator',
    });

    await expect(
      runEngineAutomationMigration(runtime({
        requireExpectedDatabaseIdentity: true,
        expectedDatabaseIdentity: {
          database: 'hx_test',
          databaseOid: '16384',
          clusterSystemIdentifier: '7623456789012345678',
        },
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Runtime database identity verification failed');
    expect(runtimeClient.queries).not.toContain('BEGIN');
    expect(migrationClient.connect).not.toHaveBeenCalled();
  });

  it('rejects a migrator that is not the immutable recorded migration owner before effects', async () => {
    const runtimeClient = clientWithQueries(
      false,
      { database_name: 'hx_test', database_role: 'hx_runtime' },
      { migration_owner: 'different_migrator' }
    );
    const migrationClient = clientWithQueries(
      false,
      { database_name: 'hx_test', database_role: 'hx_migrator' },
      { migration_owner: 'different_migrator' }
    );

    await expect(
      runEngineAutomationMigration(runtime({
        createClient: (url) => url.includes('hx_runtime') ? runtimeClient : migrationClient,
      }))
    ).rejects.toThrow('Required engine migration failed');
    expect(migrationClient.queries).not.toContain('BEGIN');
  });
});
