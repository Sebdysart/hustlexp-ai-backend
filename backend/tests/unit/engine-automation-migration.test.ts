import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
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
  applyEngineAutomationMigration,
  backfillLegacyTaskLocations,
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigration,
  type MigrationClient,
  type MigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';

function clientWithQueries(existing = false): MigrationClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return {
        rows:
          sql.startsWith('SELECT name') && existing ? [{ name: ENGINE_AUTOMATION_MIGRATION }] : [],
      };
    }) as MigrationClient['query'],
  };
}

function runtime(overrides: Partial<MigrationRuntime> = {}): MigrationRuntime {
  return {
    databaseUrl: 'postgres://automation-test',
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
    ]);
    expect(actual.bootstrapSpec?.candidatePaths).toContain(
      '/app/backend/database/constitutional-schema.sql'
    );
    expect(actual.migrationSpecs[0].candidatePaths).toContain(
      '/app/backend/database/migrations/add_missing_tables_v2.sql'
    );
    expect(actual.migrationSpecs.at(-1)?.candidatePaths).toContain(
      '/app/backend/database/migrations/20260721_same_worker_retake_assignment_guard_repair.sql'
    );
    await expect(actual.readText(actual.migrationSpecs[1].candidatePaths[0]!)).resolves.toContain(
      'CREATE TABLE IF NOT EXISTS task_reservations'
    );
    expect(actual.createClient('postgres://runtime')).toBeInstanceOf(Client);
  });

  it('packages every required migration in the production image', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('/app/backend/database/constitutional-schema.sql');
    for (const spec of productionMigrationRuntime().migrationSpecs) {
      const fileName = spec.candidatePaths[0]!.split('/').at(-1)!;
      expect(dockerfile).toContain(`/app/backend/database/migrations/${fileName}`);
    }
  });

  it('keeps the fresh-upgrade convergence count aligned with the required chain', () => {
    const assertionSql = readFileSync(
      resolve(process.cwd(), 'backend/tests/integration/upgrade-convergence-assert.pg.sql'),
      'utf8'
    );
    const requiredCount = productionMigrationRuntime().migrationSpecs.length;
    expect(assertionSql).toContain(
      `count(*)=${requiredCount} AND count(DISTINCT name)=${requiredCount}`
    );
    expect(assertionSql).toContain(`the exact ${requiredCount}-migration engine chain`);
  });

  it('keeps the restored foundational-table migration PostgreSQL-valid', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'backend/database/migrations/add_missing_tables_v2.sql'),
      'utf8'
    );
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS worker_skills');
    expect(migrationSql).toContain(
      'ON plan_entitlements(user_id, risk_level, expires_at)'
    );
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

  it('applies and records the migration atomically', async () => {
    const client = clientWithQueries();
    const outcome = await applyEngineAutomationMigration(
      client,
      'ALTER TABLE tasks ADD COLUMN demo TEXT;',
      '/migration.sql'
    );
    expect(outcome.status).toBe('applied');
    expect(client.queries).toContain('ALTER TABLE tasks ADD COLUMN demo TEXT;');
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('replays without executing the migration SQL', async () => {
    const client = clientWithQueries(true);
    const outcome = await applyEngineAutomationMigration(
      client,
      'SHOULD NOT RUN',
      '/migration.sql'
    );
    expect(outcome.status).toBe('already_applied');
    expect(client.queries).not.toContain('SHOULD NOT RUN');
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('rolls back and preserves the original migration failure', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string) => {
      client.queries.push(sql);
      if (sql === 'BROKEN SQL') throw new Error('migration exploded');
      return { rows: [] };
    });
    await expect(
      applyEngineAutomationMigration(client, 'BROKEN SQL', '/migration.sql')
    ).rejects.toThrow('migration exploded');
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('atomically replaces legacy plaintext locations with authenticated ciphertext', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client: MigrationClient = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT task_id::text')) {
          return { rows: [{ task_id: 'task-legacy-1', exact_location: '123 Main St' }] };
        }
        return { rows: [] };
      }) as MigrationClient['query'],
    };

    await expect(backfillLegacyTaskLocations(client)).resolves.toBe(1);
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
