import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CONDITIONAL_RUNTIME_CONTAINMENT_CHECKS,
  OPTIONAL_RUNTIME_FROZEN_TABLES,
  REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS,
  REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS,
  REQUIRED_RUNTIME_INVARIANT_TRIGGER_MANIFEST,
  REQUIRED_RUNTIME_INVARIANT_TRIGGERS,
  REQUIRED_RUNTIME_CONTROL_TABLES,
  REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST,
  REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS,
  REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST,
  REQUIRED_RUNTIME_PINNED_FUNCTIONS,
  REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT,
  RUNTIME_MIGRATION_MANIFEST,
  runtimeDatabaseIdentityDigest,
  runtimeMigrationLedgerDigest,
  verifyRuntimeSchema,
  type StartupSchemaQuery,
} from '../../src/serverStartupMigrations.js';
import {
  engineMigrationArtifactDigest,
  engineMigrationManifest,
} from '../../src/jobs/engine-migration-manifest.js';

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

type InvariantTriggerFixture = {
  trigger_name: string;
  relation_name: string;
  function_name: string;
  enabled: string;
  trigger_type: number;
  qualification: string | null;
  argument_count: number;
  definition: string;
};

function invariantTriggerFixtures(): InvariantTriggerFixture[] {
  return Object.entries(REQUIRED_RUNTIME_INVARIANT_TRIGGER_MANIFEST).map(
    ([trigger_name, expected]) => ({
      trigger_name,
      relation_name: expected.relation,
      function_name: expected.function,
      enabled: expected.enabled,
      trigger_type: expected.triggerType,
      qualification: expected.qualification,
      argument_count: expected.argumentCount,
      definition: expected.definition,
    })
  );
}

function queryFixture(options: {
  databaseIdentity?: Partial<{
    database_name: string;
    database_oid: string;
    cluster_system_identifier: string;
    database_role: string;
    session_role: string;
    recorded_database_name: string;
    recorded_database_oid: string;
    recorded_cluster_system_identifier: string;
    migration_owner: string;
    can_assume_migration_owner: boolean;
  }>;
  elevatedRole?: boolean;
  canCreateDatabaseObjects?: boolean;
  canCreatePublicObjects?: boolean;
  canCreateTemporaryObjects?: boolean;
  canCreateTriggers?: boolean;
  canSetSessionReplicationRole?: boolean;
  hasRoleMemberships?: boolean;
  ownsDatabase?: boolean;
  ownsPublicSchema?: boolean;
  ownsPublicObjects?: boolean;
  trustedSearchPath?: boolean;
  replicationRoleIsOrigin?: boolean;
  migrationNames?: string[];
  migrationRows?: Array<{ name: string; ordinal: number; source_sha256: string }>;
  invariantTriggers?: InvariantTriggerFixture[];
  acceptanceTriggers?: Array<{ trigger_name: string; enabled: string; definition: string }>;
  pinnedFunctions?: Array<{
    function_name: string;
    configuration: string[] | null;
    owner_name: string;
    language_name: string;
    security_definer: boolean;
    volatility: string;
    argument_count: number;
    body_sha256: string;
  }>;
  pinnedHelperFunctions?: Array<{
    function_identity: string;
    configuration: string[] | null;
    owner_name: string;
    language_name: string;
    security_definer: boolean;
    volatility: string;
    parallel_safety: string;
    argument_count: number;
    is_strict: boolean;
    returns_set: boolean;
    returns_boolean: boolean;
    function_kind: string;
    body_sha256: string;
  }>;
  containmentChecks?: Array<{
    check_name: string;
    column_exists: boolean;
    constraint_exists: boolean;
    convalidated: boolean | null;
    definition: string | null;
  }>;
  providerTransferStatusConstraint?: Array<{
    relation_name: string;
    constraint_name: string;
    convalidated: boolean;
    definition: string;
  }>;
  frozenTables?: Array<{
    relation_name: string;
    relation_exists: boolean;
    guards_valid: boolean;
  }>;
  controlTables?: Array<{
    relation_name: string;
    relation_exists: boolean;
    owner_valid: boolean;
    runtime_mutation_privileges: boolean;
    guards_valid: boolean;
    ledger_ordinal_unique: boolean;
  }>;
  schemaVersion?: string | null;
} = {}) {
  const sql: string[] = [];
  const query = vi.fn(async (statement: string) => {
    sql.push(statement);
    if (statement.includes('CROSS JOIN public.hx_database_identity')) {
      return {
        rows: [{
          database_name: 'hx_test',
          database_oid: '16384',
          cluster_system_identifier: '7623456789012345678',
          database_role: 'hx_runtime',
          session_role: 'hx_runtime',
          recorded_database_name: 'hx_test',
          recorded_database_oid: '16384',
          recorded_cluster_system_identifier: '7623456789012345678',
          migration_owner: 'hx_migrator',
          can_assume_migration_owner: false,
          ...options.databaseIdentity,
        }],
      };
    }
    if (statement.includes('FROM pg_catalog.pg_roles')) {
      return {
        rows: [{
          elevated_role: options.elevatedRole ?? false,
          can_create_database_objects: options.canCreateDatabaseObjects ?? false,
          can_create_public_objects: options.canCreatePublicObjects ?? false,
          can_create_temporary_objects: options.canCreateTemporaryObjects ?? false,
          can_create_triggers: options.canCreateTriggers ?? false,
          can_set_session_replication_role: options.canSetSessionReplicationRole ?? false,
          has_role_memberships: options.hasRoleMemberships ?? false,
          owns_database: options.ownsDatabase ?? false,
          owns_public_schema: options.ownsPublicSchema ?? false,
          owns_public_objects: options.ownsPublicObjects ?? false,
          trusted_search_path: options.trustedSearchPath ?? true,
          replication_role_is_origin: options.replicationRoleIsOrigin ?? true,
        }],
      };
    }
    if (statement.includes("tgrelid = 'public.tasks'::regclass")) {
      return {
        rows: options.acceptanceTriggers ?? Object.entries(REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS)
          .map(([trigger_name, enabled]) => ({
            trigger_name,
            enabled,
            definition: REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS[
              trigger_name as keyof typeof REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS
            ],
          })),
      };
    }
    if (statement.includes('proname AS function_name')) {
      return {
        rows: options.pinnedFunctions ?? REQUIRED_RUNTIME_PINNED_FUNCTIONS.map(
          (function_name) => ({
            function_name,
            configuration: ['search_path=pg_catalog, public'],
            owner_name: 'hx_migrator',
            language_name: 'plpgsql',
            security_definer: false,
            volatility: 'v',
            argument_count: 0,
            body_sha256: REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST[function_name],
          })
        ),
      };
    }
    if (statement.includes('AS function_identity')) {
      return {
        rows: options.pinnedHelperFunctions ?? REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS.map(
          (function_identity) => {
            const expected = REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST[function_identity];
            return {
              function_identity,
              configuration: ['search_path=pg_catalog, public'],
              owner_name: 'hx_migrator',
              language_name: expected.language,
              security_definer: false,
              volatility: expected.volatility,
              parallel_safety: expected.parallelSafety,
              argument_count: expected.argumentCount,
              is_strict: expected.strict,
              returns_set: expected.returnsSet,
              returns_boolean: expected.returnsBoolean,
              function_kind: expected.functionKind,
              body_sha256: expected.bodySha256,
            };
          }
        ),
      };
    }
    if (statement.includes('WITH expected(check_name, relation_name')) {
      return {
        rows: options.containmentChecks ?? Object.entries(CONDITIONAL_RUNTIME_CONTAINMENT_CHECKS)
          .map(([check_name, expected]) => ({
            check_name,
            column_exists: true,
            constraint_exists: true,
            convalidated: false,
            definition: expected.definition,
          })),
      };
    }
    if (statement.includes('WITH expected(relation_name)')) {
      return {
        rows: options.frozenTables ?? OPTIONAL_RUNTIME_FROZEN_TABLES.map((relation_name) => ({
          relation_name,
          relation_exists: true,
          guards_valid: true,
        })),
      };
    }
    if (statement.includes("constraint_row.conname = 'escrows_provider_transfer_status_ck'")) {
      return {
        rows: options.providerTransferStatusConstraint ?? [{
          relation_name: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.relation,
          constraint_name: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.constraint,
          convalidated: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.validated,
          definition: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.definition,
        }],
      };
    }
    if (statement.includes('WITH expected_control(relation_name)')) {
      return {
        rows: options.controlTables ?? REQUIRED_RUNTIME_CONTROL_TABLES.map((relation_name) => ({
          relation_name,
          relation_exists: true,
          owner_valid: true,
          runtime_mutation_privileges: false,
          guards_valid: true,
          ledger_ordinal_unique: true,
        })),
      };
    }
    if (statement.includes('FROM public.applied_migrations')) {
      const manifest = await engineMigrationManifest();
      if (options.migrationRows) return { rows: options.migrationRows };
      const names = options.migrationNames ?? manifest.map(({ name }) => name);
      return {
        rows: names.map((name, ordinal) => ({
          name,
          ordinal,
          source_sha256: manifest.find((entry) => entry.name === name)?.sha256 ?? '0'.repeat(64),
        })),
      };
    }
    if (statement.includes('FROM public.schema_versions')) {
      return { rows: options.schemaVersion === null ? [] : [{ version: options.schemaVersion ?? '1.0.0' }] };
    }
    if (statement.includes('FROM pg_trigger invariant_trigger')) {
      return {
        rows: options.invariantTriggers ?? invariantTriggerFixtures(),
      };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }) as unknown as StartupSchemaQuery;
  return { query, sql };
}

describe('runtime schema role boundary', () => {
  it('admits a non-owner runtime through read-only manifest and invariant queries', async () => {
    const startLog = logger();
    const fixture = queryFixture();
    const ledger = (await engineMigrationManifest()).map(({ name, ordinal, sha256 }) => ({
      name,
      ordinal,
      source_sha256: sha256,
    }));

    await expect(verifyRuntimeSchema(startLog, fixture.query)).resolves.toEqual({
      migrationCount: ledger.length,
      schemaVersion: '1.0.0',
      invariantTriggerCount: REQUIRED_RUNTIME_INVARIANT_TRIGGERS.length,
      acceptanceTriggerCount: Object.keys(REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS).length,
      pinnedFunctionCount:
        REQUIRED_RUNTIME_PINNED_FUNCTIONS.length
        + REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS.length,
      frozenTableCount: OPTIONAL_RUNTIME_FROZEN_TABLES.length,
      databaseIdentitySha256: runtimeDatabaseIdentityDigest({
        databaseName: 'hx_test',
        databaseOid: '16384',
        clusterSystemIdentifier: '7623456789012345678',
      }),
      migrationLedgerSha256: runtimeMigrationLedgerDigest(ledger),
      migrationArtifactSha256: await engineMigrationArtifactDigest(),
    });
    expect(fixture.sql).toHaveLength(12);
    expect(fixture.sql.join('\n')).toContain('has_any_column_privilege');
    expect(fixture.sql.join('\n')).toContain('index_row.indpred IS NULL');
    expect(fixture.sql.join('\n')).toContain('index_row.indexprs IS NULL');
    expect(fixture.sql.join('\n')).toContain('index_row.indislive');
    const prePinSql = fixture.sql.slice(0, 2).join('\n');
    expect(prePinSql).toContain('pg_catalog.current_database');
    expect(prePinSql).toContain('pg_catalog.current_setting');
    expect(prePinSql).toContain('pg_catalog.has_database_privilege');
    expect(prePinSql).not.toMatch(/(?<!pg_catalog\.)\bcurrent_database\s*\(/);
    expect(prePinSql).not.toMatch(/(?<!pg_catalog\.)\bcurrent_setting\s*\(/);
    expect(prePinSql).not.toMatch(/(?<!pg_catalog\.)\bhas_database_privilege\s*\(/);
    for (const statement of fixture.sql) {
      expect(statement).not.toMatch(
        /(?:^|;)\s*(?:ALTER|CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|CALL)\b/im
      );
    }
    expect(startLog.info).toHaveBeenCalledOnce();
  });

  it.each([
    [{ elevatedRole: true }, 'elevated runtime role'],
    [{ canCreateDatabaseObjects: true }, 'runtime database CREATE privilege'],
    [{ canCreatePublicObjects: true }, 'runtime schema CREATE privilege'],
    [{ canCreateTemporaryObjects: true }, 'runtime database TEMPORARY privilege'],
    [{ canCreateTriggers: true }, 'effective explicit or inherited TRIGGER privilege'],
    [{ canSetSessionReplicationRole: true }, 'session_replication_role SET privilege'],
    [{ hasRoleMemberships: true }, 'SET ROLE or inherited role-membership path'],
    [{ ownsDatabase: true }, 'runtime database owner'],
    [{ ownsPublicSchema: true }, 'runtime public-schema owner'],
    [{ ownsPublicObjects: true }, 'runtime public-object owner'],
    [{ trustedSearchPath: false }, 'runtime search_path drift'],
    [{ replicationRoleIsOrigin: false }, 'runtime replica-mode session'],
  ] as const)('rejects %s (%s)', async (options) => {
    const startLog = logger();
    const fixture = queryFixture(options);
    await expect(verifyRuntimeSchema(startLog, fixture.query)).rejects.toThrow(
      'Runtime database schema verification failed'
    );
    expect(startLog.error).toHaveBeenCalledOnce();
  });

  it('rejects SET ROLE and any database or cluster identity mismatch', async () => {
    for (const databaseIdentity of [
      { session_role: 'login_role' },
      { recorded_database_name: 'decoy' },
      { recorded_database_oid: '99999' },
      { recorded_cluster_system_identifier: '9999999999999999999' },
      { migration_owner: 'hx_runtime' },
      { can_assume_migration_owner: true },
    ]) {
      await expect(
        verifyRuntimeSchema(logger(), queryFixture({ databaseIdentity }).query)
      ).rejects.toThrow('Runtime database schema verification failed');
    }
  });

  it('fails closed on a missing, unexpected, duplicated, or stale migration ledger', async () => {
    const cases = [
      RUNTIME_MIGRATION_MANIFEST.slice(1),
      [...RUNTIME_MIGRATION_MANIFEST, 'unexpected_migration'],
      [...RUNTIME_MIGRATION_MANIFEST, RUNTIME_MIGRATION_MANIFEST[0]!],
    ];
    for (const migrationNames of cases) {
      const fixture = queryFixture({ migrationNames });
      await expect(verifyRuntimeSchema(logger(), fixture.query)).rejects.toThrow(
        'Runtime database schema verification failed'
      );
    }

    const manifest = (await engineMigrationManifest()).map((entry) => ({
      name: entry.name,
      ordinal: entry.ordinal,
      source_sha256: entry.sha256,
    }));
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          migrationRows: manifest.map((entry, index) =>
            index === 1 ? { ...entry, source_sha256: '0'.repeat(64) } : entry
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          migrationRows: manifest.map((entry, index) =>
            index === 1 ? { ...entry, ordinal: 99 } : entry
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
  });

  it('fails closed when the schema version or an invariant trigger is absent', async () => {
    await expect(
      verifyRuntimeSchema(logger(), queryFixture({ schemaVersion: null }).query)
    ).rejects.toThrow('Runtime database schema verification failed');
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({ invariantTriggers: invariantTriggerFixtures().slice(1) }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
  });

  it('binds every invariant trigger to its exact catalog identity and structure', async () => {
    const valid = invariantTriggerFixtures();
    const corruptions: Array<Partial<InvariantTriggerFixture>> = [
      { relation_name: 'public.inert_decoy' },
      { function_name: 'public.prevent_escrow_terminal_mutation()' },
      { enabled: 'D' },
      { trigger_type: 23 },
      { qualification: '(new.state IS NOT NULL)' },
      { argument_count: 1 },
      {
        definition:
          'CREATE TRIGGER task_terminal_guard BEFORE UPDATE ON inert_decoy FOR EACH ROW EXECUTE FUNCTION prevent_task_terminal_mutation()',
      },
    ];

    for (const corruption of corruptions) {
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            invariantTriggers: valid.map((entry, index) =>
              index === 0 ? { ...entry, ...corruption } : entry
            ),
          }).query
        )
      ).rejects.toThrow('Runtime database schema verification failed');
    }

    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({ invariantTriggers: [...valid, { ...valid[0]! }] }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
  });

  it('refuses startup when either immutable audit ledger guard is missing or altered', async () => {
    const auditTriggerNames = [
      'escrow_events_destructive_guard',
      'escrow_events_truncate_guard',
      'admin_actions_destructive_guard',
      'admin_actions_truncate_guard',
    ];
    const valid = invariantTriggerFixtures();
    for (const triggerName of auditTriggerNames) {
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            invariantTriggers: valid.filter((entry) => entry.trigger_name !== triggerName),
          }).query,
        ),
      ).rejects.toThrow('Runtime database schema verification failed');

      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            invariantTriggers: valid.map((entry) => entry.trigger_name === triggerName
              ? { ...entry,definition: `${entry.definition} -- drift` }
              : entry),
          }).query,
        ),
      ).rejects.toThrow('Runtime database schema verification failed');
    }

    for (const functionName of [
      'reject_escrow_event_destructive_mutation',
      'reject_admin_action_destructive_mutation',
    ] as const) {
      const validFunctions = REQUIRED_RUNTIME_PINNED_FUNCTIONS.map((name) => ({
        function_name:name,
        configuration:['search_path=pg_catalog, public'],
        owner_name:'hx_migrator',
        language_name:'plpgsql',
        security_definer:false,
        volatility:'v',
        argument_count:0,
        body_sha256:REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST[name],
      }));
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            pinnedFunctions:validFunctions.filter((entry) => entry.function_name !== functionName),
          }).query,
        ),
      ).rejects.toThrow('Runtime database schema verification failed');
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            pinnedFunctions:validFunctions.map((entry) => entry.function_name === functionName
              ? { ...entry,body_sha256:'0'.repeat(64) }
              : entry),
          }).query,
        ),
      ).rejects.toThrow('Runtime database schema verification failed');
    }
  });

  it('requires all nine exact baseline and refund-claim acceptance gates in ALWAYS mode', async () => {
    const acceptance = Object.entries(REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS).map(
      ([trigger_name, enabled]) => ({
        trigger_name,
        enabled,
        definition: REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS[
          trigger_name as keyof typeof REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS
        ],
      })
    );
    await expect(
      verifyRuntimeSchema(logger(), queryFixture({ acceptanceTriggers: acceptance.slice(1) }).query)
    ).rejects.toThrow('Runtime database schema verification failed');
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          acceptanceTriggers: acceptance.map((entry, index) =>
            index === 0 ? { ...entry, enabled: 'D' } : entry
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          acceptanceTriggers: acceptance.map((entry, index) =>
            index === 0 ? { ...entry, definition: 'CREATE TRIGGER drifted' } : entry
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');

    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          acceptanceTriggers: acceptance.map((entry) => ({
            ...entry,
            definition: entry.definition
              .replace(/new\.state/g, '(new.state)::text')
              .replace(/old\.state/g, '(old.state)::text'),
          })),
        }).query
      )
    ).resolves.toEqual(expect.objectContaining({ acceptanceTriggerCount: 9 }));
  });

  it('binds every trigger function to exact body, owner, language, security, volatility, and search path', async () => {
    const pinned = REQUIRED_RUNTIME_PINNED_FUNCTIONS.map((function_name) => ({
      function_name,
      configuration: ['search_path=pg_catalog, public'],
      owner_name: 'hx_migrator',
      language_name: 'plpgsql',
      security_definer: false,
      volatility: 'v',
      argument_count: 0,
      body_sha256: REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST[function_name],
    }));
    await expect(
      verifyRuntimeSchema(logger(), queryFixture({ pinnedFunctions: pinned.slice(1) }).query)
    ).rejects.toThrow('Runtime database schema verification failed');

    for (const corruption of [
      { owner_name: 'hx_runtime' },
      { language_name: 'sql' },
      { security_definer: true },
      { volatility: 's' },
      { argument_count: 1 },
      { body_sha256: '0'.repeat(64) },
    ]) {
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            pinnedFunctions: pinned.map((entry, index) =>
              index === 0 ? { ...entry, ...corruption } : entry
            ),
          }).query
        )
      ).rejects.toThrow('Runtime database schema verification failed');
    }
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          pinnedFunctions: pinned.map((entry, index) =>
            index === 0 ? { ...entry, configuration: ['search_path=public'] } : entry
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
  });

  it('binds every transitive decision helper to its exact signature and catalog identity', async () => {
    const pinnedHelpers = REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS.map((function_identity) => {
      const expected = REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST[function_identity];
      return {
        function_identity,
        configuration: ['search_path=pg_catalog, public'],
        owner_name: 'hx_migrator',
        language_name: expected.language,
        security_definer: false,
        volatility: expected.volatility,
        parallel_safety: expected.parallelSafety,
        argument_count: expected.argumentCount,
        is_strict: expected.strict,
        returns_set: expected.returnsSet,
        returns_boolean: expected.returnsBoolean,
        function_kind: expected.functionKind,
        body_sha256: expected.bodySha256,
      };
    });
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({ pinnedHelperFunctions: pinnedHelpers }).query
      )
    ).resolves.toEqual(expect.objectContaining({
      pinnedFunctionCount:
        REQUIRED_RUNTIME_PINNED_FUNCTIONS.length
        + REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS.length,
    }));
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({ pinnedHelperFunctions: pinnedHelpers.slice(1) }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');

    for (const corruption of [
      { function_identity: 'public.inert_helper(uuid)' },
      { configuration: ['search_path=public'] },
      { owner_name: 'hx_runtime' },
      { language_name: 'plpgsql' },
      { security_definer: true },
      { volatility: 'v' },
      { parallel_safety: 'r' },
      { argument_count: 99 },
      { is_strict: true },
      { returns_set: true },
      { returns_boolean: false },
      { function_kind: 'p' },
      { body_sha256: '0'.repeat(64) },
    ]) {
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            pinnedHelperFunctions: pinnedHelpers.map((entry, index) =>
              index === 0 ? { ...entry, ...corruption } : entry
            ),
          }).query
        )
      ).rejects.toThrow('Runtime database schema verification failed');
    }
  });

  it('requires each present containment column to have its exact unvalidated check', async () => {
    const valid = Object.entries(CONDITIONAL_RUNTIME_CONTAINMENT_CHECKS).map(
      ([check_name, expected]) => ({
        check_name,
        column_exists: true,
        constraint_exists: true,
        convalidated: false,
        definition: expected.definition,
      })
    );
    const absentColumn = valid.map((row, index) =>
      index === 0
        ? { ...row, column_exists: false, constraint_exists: false, convalidated: null, definition: null }
        : row
    );
    await expect(
      verifyRuntimeSchema(logger(), queryFixture({ containmentChecks: absentColumn }).query)
    ).rejects.toThrow('Runtime database schema verification failed');

    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          containmentChecks: valid.map((row) =>
            row.check_name === 'task_orchestration'
              ? {
                  ...row,
                  definition: row.definition.replace(
                    'orchestration_mode',
                    '(orchestration_mode)::text'
                  ),
                }
              : row
          ),
        }).query
      )
    ).resolves.toEqual(expect.objectContaining({ migrationCount: 116 }));

    for (const corruption of [
      { constraint_exists: false },
      { convalidated: true },
      { definition: 'CHECK (true) NOT VALID' },
    ]) {
      const drifted = valid.map((row, index) => index === 0 ? { ...row, ...corruption } : row);
      await expect(
        verifyRuntimeSchema(logger(), queryFixture({ containmentChecks: drifted }).query)
      ).rejects.toThrow('Runtime database schema verification failed');
    }
  });

  it('requires the exact validated closed provider-transfer status contract', async () => {
    const valid = {
      relation_name: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.relation,
      constraint_name: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.constraint,
      convalidated: true,
      definition: REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.definition,
    };
    for (const rows of [
      [],
      [{ ...valid, convalidated: false }],
      [{ ...valid, definition: valid.definition.replace(", 'reversed'::text", '') }],
      [{ ...valid, definition: `${valid.definition.slice(0, -1)} OR true)` }],
    ]) {
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({ providerTransferStatusConstraint: rows }).query
        )
      ).rejects.toThrow('Runtime database schema verification failed');
    }
  });

  it('requires every incident table and its ENABLE ALWAYS DML and truncate guards', async () => {
    const valid = OPTIONAL_RUNTIME_FROZEN_TABLES.map((relation_name) => ({
      relation_name,
      relation_exists: true,
      guards_valid: true,
    }));
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          frozenTables: valid.map((row, index) =>
            index === 1 ? { ...row, relation_exists: false, guards_valid: false } : row
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
    await expect(
      verifyRuntimeSchema(
        logger(),
        queryFixture({
          frozenTables: valid.map((row, index) =>
            index === 1 ? { ...row, guards_valid: false } : row
          ),
        }).query
      )
    ).rejects.toThrow('Runtime database schema verification failed');
  });

  it('requires migrator-owned, append-only control tables with no runtime mutation path', async () => {
    const valid = REQUIRED_RUNTIME_CONTROL_TABLES.map((relation_name) => ({
      relation_name,
      relation_exists: true,
      owner_valid: true,
      runtime_mutation_privileges: false,
      guards_valid: true,
      ledger_ordinal_unique: true,
    }));
    for (const corruption of [
      { relation_exists: false },
      { owner_valid: false },
      { runtime_mutation_privileges: true },
      { guards_valid: false },
      { ledger_ordinal_unique: false },
    ]) {
      await expect(
        verifyRuntimeSchema(
          logger(),
          queryFixture({
            controlTables: valid.map((entry, index) =>
              index === 0 ? { ...entry, ...corruption } : entry
            ),
          }).query
        )
      ).rejects.toThrow('Runtime database schema verification failed');
    }
  });

  it('keeps API and worker startup on verification and out of the migration runner', () => {
    for (const fileName of ['backend/src/serverStartup.ts', 'backend/src/jobs/workers.ts']) {
      const source = readFileSync(fileName, 'utf8');
      expect(source).toContain('verifyRuntimeSchema');
      expect(source).not.toContain('runEngineAutomationMigration');
    }
  });

  it('keeps the explicit migrator in the protected release workflow and out of Railway runtime configuration', () => {
    const railway = JSON.parse(readFileSync('railway.json', 'utf8')) as {
      deploy?: { preDeployCommand?: string[] };
    };
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const procfile = readFileSync('Procfile', 'utf8');
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const runtimeWrapper = readFileSync('scripts/start-runtime.sh', 'utf8');

    const releaseWorkflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

    expect(railway.deploy?.preDeployCommand).toBeUndefined();
    expect(packageJson.scripts['db:migrate:engine']).toContain('runEngineAutomationMigration');
    expect(packageJson.scripts.start).not.toContain('migrate');
    expect(packageJson.scripts['start:workers']).not.toContain('migrate');
    expect(procfile).not.toMatch(/^release:/m);
    expect(procfile.match(/^web:\s*(.+)$/m)?.[1]).toBe('npm start');
    expect(procfile.match(/^worker:\s*(.+)$/m)?.[1]).toBe('npm run start:workers');
    expect(releaseWorkflow).toContain('environment: production');
    expect(releaseWorkflow).toContain('npm run db:migrate:engine');
    expect(releaseWorkflow).toContain('PRODUCTION_MIGRATION_DATABASE_URL');
    expect(dockerfile).toContain('COPY --from=builder /app/scripts/start-runtime.sh ./scripts/start-runtime.sh');
    expect(dockerfile).toContain('RUN chmod 0555 /app/scripts/start-runtime.sh');
    expect(dockerfile).toContain('CMD ["/app/scripts/start-runtime.sh"]');
    expect(dockerfile).not.toMatch(/CMD\s+\[?\s*["']?npm\b/);
    expect(runtimeWrapper).toContain('unset MIGRATION_DATABASE_URL');
    expect(runtimeWrapper).toContain('exec node dist/backend/src/server.js');
    expect(runtimeWrapper).toContain('exec node dist/backend/src/jobs/workers.js');
    expect(runtimeWrapper.indexOf('unset MIGRATION_DATABASE_URL')).toBeLessThan(
      runtimeWrapper.indexOf('exec node')
    );
    expect(runtimeWrapper).not.toMatch(/exec\s+npm\b|npm\s+(?:start|run)/);
  });
});
