import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const describePg = describe.skipIf(configuredDatabaseUrl.length === 0).sequential;
const proofDatabase = `hx_ci_runtime_insert_${process.pid}_test`;
const authorityOwner = `hx_ci_runtime_insert_owner_${process.pid}`;
const runtimeRole = `hx_ci_runtime_insert_login_${process.pid}`;
const runtimePassword = `hx-ci-runtime-insert-${process.pid}-synthetic`;
const migrationName = '20261013_nonproduction_runtime_insert_authority_v1';
const migrationFileName = `${migrationName}.sql`;
const sentinelUserId = 'fb100000-0000-4000-8000-000000000001';
const sentinelFirebaseUid = 'firebase:synthetic-runtime-insert-1';

const ports = [
  {
    signature:
      'public.hxos_record_financial_provider_command_v1(uuid,text,uuid,text,text,bigint,text,text,uuid,text,uuid,uuid,uuid,uuid,bigint,text,uuid,text,text,text,text,text,text)',
    marker: 'HXUV1-NPFIP-V1:JOURNAL',
    returnType: 'public.financial_provider_command_journal',
  },
  {
    signature:
      'public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)',
    marker: 'HXUV1-NPFIP-V1:PREPARED',
    returnType: 'public.universal_v1_prepared_financial_commands',
  },
  {
    signature: 'public.hxos_record_financial_provider_dispatch_attempt_v1(uuid,uuid,uuid,integer)',
    marker: 'HXUV1-NPFIP-V1:DISPATCH',
    returnType: 'public.financial_provider_command_dispatch_attempts',
  },
  {
    signature:
      'public.hxos_record_change_order_materialization_command_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid,integer,integer,text,timestamp with time zone)',
    marker: 'HXUV1-NPFIP-V1:CHANGE_ORDER',
    returnType: 'public.universal_v1_change_order_materialization_commands',
  },
  {
    signature:
      'public.hxos_record_fake_financial_lifecycle_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    marker: 'HXUV1-NPFIP-V1:LIFECYCLE_BRIDGE',
    returnType: 'public.universal_v1_fake_financial_lifecycle_bridges',
  },
  {
    signature:
      'public.hxos_record_fake_financial_security_event_v1(uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid)',
    marker: 'HXUV1-NPFIP-V1:FAKE_FINANCIAL_EVENT',
    returnType: 'public.task_financial_security_events',
  },
  {
    signature:
      'public.hxos_record_fake_terminal_lifecycle_intent_v1(uuid,text,uuid,uuid,uuid,uuid,bigint,integer,text,text,uuid)',
    marker: 'HXUV1-NPFIP-V1:TERMINAL_INTENT',
    returnType: 'public.universal_v1_fake_terminal_lifecycle_intents',
  },
  {
    signature:
      'public.hxos_record_fake_provider_account_fact_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    marker: 'HXUV1-NPFIP-V1:PROVIDER_ACCOUNT',
    returnType: 'public.universal_v1_fake_provider_account_facts',
  },
  {
    signature:
      'public.hxos_record_fake_reconciliation_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    marker: 'HXUV1-NPFIP-V1:RECONCILIATION_BRIDGE',
    returnType: 'public.universal_v1_fake_reconciliation_bridges',
  },
  {
    signature:
      'public.hxos_record_fake_reconciliation_fact_v1(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid,uuid,text)',
    marker: 'HXUV1-NPFIP-V1:FAKE_RECONCILIATION_FACT',
    returnType: 'public.task_reconciliation_facts',
  },
] as const;

const deferredIntegrityGuards = [
  'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
  'public.require_universal_v1_fake_reconciliation_bridge()',
  'public.require_universal_v1_double_entry_ledger_v1()',
] as const;

const ownerOnlyPrimitiveBridgePortSignatures = new Set<string>([
  'public.hxos_record_fake_financial_lifecycle_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
  'public.hxos_record_fake_reconciliation_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
]);
const runtimeCallablePorts = ports.filter(
  ({ signature }) => !ownerOnlyPrimitiveBridgePortSignatures.has(signature)
);

const requiredTriggerRoots = [
  [
    'financial_provider_command_journal',
    'aa_universal_v1_change_order_terminal_journal_guard',
    'public.prevent_change_order_adjust_after_terminal_recovery()',
  ],
  [
    'financial_provider_command_journal',
    'aa_universal_v1_dispute_command_release_gate',
    'public.enforce_universal_v1_dispute_release_gate_v1()',
  ],
  [
    'financial_provider_command_journal',
    'financial_provider_command_prepared_authority_guard',
    'public.enforce_financial_provider_command_prepared_authority()',
  ],
  [
    'financial_provider_command_journal',
    'zz_universal_v1_fake_terminal_reconcile_command_guard',
    'public.validate_universal_v1_fake_terminal_reconcile_command()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'a0_universal_v1_change_order_financial_slot_lock',
    'public.lock_universal_v1_change_order_financial_slot_v1()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'a_universal_v1_prepared_adjustment_witness',
    'public.enforce_universal_v1_prepared_adjustment_witness()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'aa_universal_v1_dispute_prepared_release_gate',
    'public.enforce_universal_v1_dispute_release_gate_v1()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'universal_v1_prepared_financial_command_guard',
    'public.enforce_universal_v1_financial_command_preparation()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'v_universal_v1_prepared_positive_expiry_v1',
    'public.enforce_universal_v1_prepared_positive_expiry_v1()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'zz_universal_v1_change_order_compensating_reversal_guard',
    'public.validate_universal_v1_change_order_compensating_reversal()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'zz_universal_v1_fake_terminal_prepared_command_guard',
    'public.validate_universal_v1_fake_terminal_prepared_command()',
  ],
  [
    'universal_v1_prepared_financial_commands',
    'zz_universal_v1_pre_work_order_void_guard',
    'public.validate_universal_v1_pre_work_order_void()',
  ],
  [
    'financial_provider_command_dispatch_attempts',
    'aa_universal_v1_change_order_terminal_dispatch_guard',
    'public.prevent_change_order_adjust_after_terminal_recovery()',
  ],
  [
    'financial_provider_command_dispatch_attempts',
    'financial_provider_command_dispatch_attempt_guard',
    'public.assert_financial_provider_command_dispatch_attempt()',
  ],
  [
    'financial_provider_command_dispatch_attempts',
    'v_universal_v1_dispatch_positive_expiry_v1',
    'public.enforce_universal_v1_dispatch_positive_expiry_v1()',
  ],
  [
    'financial_provider_command_dispatch_attempts',
    'zz_universal_v1_fake_terminal_dispatch_attempt_guard',
    'public.validate_universal_v1_fake_terminal_dispatch_attempt()',
  ],
  [
    'universal_v1_change_order_materialization_commands',
    'universal_v1_change_order_materialization_command_guard',
    'public.enforce_universal_v1_change_order_materialization_command()',
  ],
  [
    'universal_v1_change_order_materialization_commands',
    'v_universal_v1_change_order_predecessor_expiry_v9',
    'public.enforce_universal_v1_change_order_predecessor_expiry_v9()',
  ],
  [
    'universal_v1_change_order_materialization_commands',
    'zz_universal_v1_change_order_phase_a_financial_slot_guard',
    'public.reject_change_order_witness_after_financial_slot_v1()',
  ],
  [
    'universal_v1_fake_financial_lifecycle_bridges',
    'universal_v1_fake_financial_lifecycle_bridge_validate',
    'public.validate_universal_v1_fake_financial_lifecycle_bridge()',
  ],
  [
    'universal_v1_fake_financial_lifecycle_bridges',
    'zz_universal_v1_fake_expiry_bridge_v9',
    'public.enforce_universal_v1_fake_expiry_bridge_v9()',
  ],
  [
    'universal_v1_fake_terminal_lifecycle_intents',
    'aa_universal_v1_dispute_terminal_intent_gate',
    'public.enforce_universal_v1_dispute_release_gate_v1()',
  ],
  [
    'universal_v1_fake_terminal_lifecycle_intents',
    'universal_v1_fake_terminal_lifecycle_intent_validate',
    'public.validate_universal_v1_fake_terminal_lifecycle_intent()',
  ],
  [
    'universal_v1_fake_terminal_lifecycle_intents',
    'v_universal_v1_terminal_intent_expiry_v9',
    'public.enforce_universal_v1_terminal_intent_expiry_v9()',
  ],
  [
    'universal_v1_fake_provider_account_facts',
    'universal_v1_fake_provider_account_fact_validate',
    'public.validate_universal_v1_fake_provider_account_fact()',
  ],
  [
    'universal_v1_fake_reconciliation_bridges',
    'universal_v1_fake_reconciliation_bridge_validate',
    'public.validate_universal_v1_fake_reconciliation_bridge()',
  ],
  [
    'task_financial_security_events',
    'aa_universal_v1_dispute_financial_release_gate',
    'public.enforce_universal_v1_dispute_release_gate_v1()',
  ],
  [
    'task_financial_security_events',
    'universal_fake_finance_boundary_guard',
    'public.enforce_universal_fake_finance_boundary()',
  ],
  [
    'task_financial_security_events',
    'universal_financial_event_sequence_guard',
    'public.enforce_universal_financial_event_sequence()',
  ],
  [
    'task_financial_security_events',
    'universal_v1_controlled_fake_lifecycle_bridge_required',
    'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
  ],
  [
    'task_financial_security_events',
    'universal_v1_financial_execution_completion_guard',
    'public.enforce_universal_v1_financial_execution_completion()',
  ],
  [
    'task_reconciliation_facts',
    'aa_universal_v1_dispute_reconciliation_gate',
    'public.enforce_universal_v1_dispute_closure_gate_v1()',
  ],
  [
    'task_reconciliation_facts',
    'universal_reconciliation_bindings_guard',
    'public.enforce_universal_reconciliation_bindings()',
  ],
  [
    'task_reconciliation_facts',
    'universal_v1_fake_reconciliation_bridge_required',
    'public.require_universal_v1_fake_reconciliation_bridge()',
  ],
  [
    'task_reconciliation_facts',
    'zz_universal_v1_double_entry_ledger_required_v1',
    'public.require_universal_v1_double_entry_ledger_v1()',
  ],
] as const;

let adminClient: pg.Client | null = null;
let databaseClient: pg.Client | null = null;
let runtimeClient: pg.Client | null = null;
let migrationSql = '';

function safeIdentifier(value: string): string {
  if (!/^hx_ci_[a-z0-9_]+$/u.test(value) || value.length > 63) {
    throw new Error(`Unsafe disposable PostgreSQL identifier: ${value}`);
  }
  return value;
}

function quotedIdentifier(value: string): string {
  return `"${safeIdentifier(value)}"`;
}

function adminDatabaseUrl(): string {
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
    throw new Error('Runtime insert proof requires the exact loopback-only hx_ci_* PG16 runner');
  }
  parsed.pathname = '/hx_ci_admin_test';
  return parsed.toString();
}

function databaseUrl(username?: string, password?: string): string {
  const parsed = new URL(adminDatabaseUrl());
  parsed.pathname = `/${safeIdentifier(proofDatabase)}`;
  if (username !== undefined) parsed.username = safeIdentifier(username);
  if (password !== undefined) parsed.password = password;
  return parsed.toString();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function cleanup(): Promise<void> {
  const client = adminClient ?? new pg.Client({ connectionString: adminDatabaseUrl() });
  const ownsClient = adminClient === null;
  if (ownsClient) await client.connect();
  try {
    await client.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
         FROM pg_catalog.pg_stat_activity
        WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [proofDatabase]
    );
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(proofDatabase)}`);
    await client.query(`DROP ROLE IF EXISTS ${quotedIdentifier(runtimeRole)}`);
    await client.query(`DROP ROLE IF EXISTS ${quotedIdentifier(authorityOwner)}`);
  } finally {
    if (ownsClient) await client.end();
  }
}

async function applyRegisteredMigration(
  client: pg.Client,
  registration: { name: string; fileName: string }
): Promise<void> {
  const sql = await readFile(
    new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
    'utf8'
  );
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`, [
      registration.name,
      sha256(sql),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applySupplementalMigration(
  client: pg.Client,
  registration: { name: string; fileName: string; evidenceTable: string }
): Promise<void> {
  const sql = await readFile(
    new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
    'utf8'
  );
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO public."${registration.evidenceTable}"(
         migration_name, migration_sql_sha256
       ) VALUES ($1, $2)`,
      [registration.name, sha256(sql)]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function expectDatabaseRefusal(
  operation: () => Promise<unknown>,
  message: RegExp
): Promise<void> {
  try {
    await operation();
    throw new Error('Expected PostgreSQL to refuse the runtime insert authority operation');
  } catch (error) {
    expect((error as Error).message).toMatch(message);
  }
}

async function functionCatalog(): Promise<
  Array<{
    signature: string;
    owner_name: string;
    return_type: string;
    security_definer: boolean;
    volatility: string;
    parallel_safety: string;
    configuration: string[];
    marker_present: boolean;
    public_execute: boolean;
  }>
> {
  const result = await databaseClient!.query<{
    signature: string;
    owner_name: string;
    return_type: string;
    security_definer: boolean;
    volatility: string;
    parallel_safety: string;
    configuration: string[];
    marker_present: boolean;
    public_execute: boolean;
  }>(
    `SELECT expected.signature,
            pg_catalog.pg_get_userbyid(procedure.proowner) AS owner_name,
            pg_catalog.format(
              '%I.%I', return_namespace.nspname, return_type.typname
            ) AS return_type,
            procedure.prosecdef AS security_definer,
            procedure.provolatile AS volatility,
            procedure.proparallel AS parallel_safety,
            procedure.proconfig AS configuration,
            pg_catalog.strpos(procedure.prosrc, expected.marker) > 0 AS marker_present,
            EXISTS (
              SELECT 1
                FROM pg_catalog.aclexplode(COALESCE(
                  procedure.proacl,
                  pg_catalog.acldefault('f', procedure.proowner)
                )) privilege
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
            ) AS public_execute
       FROM pg_catalog.jsonb_to_recordset($1::JSONB)
         AS expected(signature TEXT, marker TEXT, return_type TEXT)
       JOIN pg_catalog.pg_proc procedure
         ON procedure.oid = pg_catalog.to_regprocedure(expected.signature)::OID
       JOIN pg_catalog.pg_type return_type
         ON return_type.oid = procedure.prorettype
       JOIN pg_catalog.pg_namespace return_namespace
         ON return_namespace.oid = return_type.typnamespace
      ORDER BY expected.signature`,
    [JSON.stringify(ports)]
  );
  return result.rows;
}

describePg('nonproduction runtime insert authority v1 PostgreSQL contract', () => {
  beforeAll(async () => {
    for (const identifier of [proofDatabase, authorityOwner, runtimeRole]) {
      safeIdentifier(identifier);
    }
    adminClient = new pg.Client({ connectionString: adminDatabaseUrl() });
    await adminClient.connect();
    await cleanup();

    const version = await adminClient.query<{ server_version_num: string }>(
      `SELECT pg_catalog.current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(170_000);

    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(authorityOwner)} NOLOGIN NOSUPERUSER NOCREATEDB
         NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(runtimeRole)} LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE DATABASE ${quotedIdentifier(proofDatabase)} TEMPLATE template0`
    );

    databaseClient = new pg.Client({ connectionString: databaseUrl() });
    await databaseClient.connect();
    const baseline = await readFile(
      new URL('../../database/constitutional-schema.sql', import.meta.url),
      'utf8'
    );
    await databaseClient.query(baseline);
    await databaseClient.query(
      `CREATE TABLE public.applied_migrations (
         name TEXT PRIMARY KEY,
         sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
       )`
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    for (const registration of REQUIRED_MIGRATION_FILES) {
      await applyRegisteredMigration(databaseClient, registration);
    }
    // Keep the exact historical predecessor chain and the v11 installation bound.
    // v13 is registered after the frozen v12/seal suffix; it is not installed here.
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name }) => name)).toEqual([
      '20260827_fake_financial_provider_v1',
      '20260903_fake_financial_provider_account_refresh_v2',
      '20260910_fake_financial_settlement_completion_v3',
      '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
      '20260922_universal_v1_fake_terminal_lifecycle_intent_v1',
      '20260926_universal_v1_change_order_three_phase_v1',
      '20260927_universal_v1_change_order_recovery_v1',
      '20261002_universal_v1_dispute_fake_release_gate_v8',
      '20261010_universal_v1_fake_financial_expiry_v9',
      '20261011_universal_v1_fake_financial_expiry_recovery_v10',
      '20261013_nonproduction_runtime_insert_authority_v1',
      '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
      '20261015_universal_v1_work_order_bootstrap_seal_v1',
      '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
    ]);
    const runtimeInsertIndex = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.findIndex(
      ({ name }) => name === migrationName
    );
    expect(runtimeInsertIndex).toBe(10);
    for (const registration of CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.slice(
      0,
      runtimeInsertIndex
    )) {
      await applySupplementalMigration(databaseClient, registration);
    }
    await databaseClient.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, account_status,
         is_minor, is_banned
       ) VALUES ($1, $2, 'runtime-insert@synthetic.invalid',
                 'Synthetic runtime insert', 'poster', 'ACTIVE', FALSE, FALSE)`,
      [sentinelUserId, sentinelFirebaseUid]
    );

    const runtimeInsertRegistration =
      CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[runtimeInsertIndex]!;
    expect(runtimeInsertRegistration).toEqual({
      name: migrationName,
      fileName: migrationFileName,
      evidenceTable: 'hxos_fake_financial_schema_evidence_v11',
    });
    await applySupplementalMigration(databaseClient, runtimeInsertRegistration);
    migrationSql = await readFile(
      new URL(`../../database/migrations/${migrationFileName}`, import.meta.url),
      'utf8'
    );
    await databaseClient.query(migrationSql);
    await databaseClient.query(migrationSql);

    runtimeClient = new pg.Client({
      connectionString: databaseUrl(runtimeRole, runtimePassword),
    });
    await runtimeClient.connect();
  }, 300_000);

  afterAll(async () => {
    await runtimeClient?.end().catch(() => undefined);
    runtimeClient = null;
    await databaseClient?.end().catch(() => undefined);
    databaseClient = null;
    if (adminClient) {
      await cleanup().catch(() => undefined);
      await adminClient.end().catch(() => undefined);
      adminClient = null;
    }
  }, 60_000);

  it('installs fresh after 146, preserves prior data, raw-replays, and creates no grant or effect', async () => {
    const registry = await databaseClient!.query<{
      engine_migrations: number;
      supplemental_tail_sha256: string;
      sentinel_preserved: boolean;
    }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER FROM public.applied_migrations) AS engine_migrations,
         (
           SELECT migration_sql_sha256::TEXT
             FROM public.hxos_fake_financial_schema_evidence_v11
            WHERE migration_name = $1
         ) AS supplemental_tail_sha256,
         EXISTS(SELECT 1 FROM public.users WHERE id = $2 AND firebase_uid = $3)
           AS sentinel_preserved`,
      [migrationName, sentinelUserId, sentinelFirebaseUid]
    );
    expect(registry.rows[0]).toEqual({
      engine_migrations: 146,
      supplemental_tail_sha256: sha256(migrationSql),
      sentinel_preserved: true,
    });
    expect(migrationSql).not.toMatch(/^\s*GRANT\b/imu);

    const authority = await databaseClient!.query<{
      target_rows: number;
      runtime_execute_count: number;
    }>(
      `SELECT
         (
           (SELECT COUNT(*) FROM public.financial_provider_command_journal) +
           (SELECT COUNT(*) FROM public.universal_v1_prepared_financial_commands) +
           (SELECT COUNT(*) FROM public.financial_provider_command_dispatch_attempts) +
           (SELECT COUNT(*) FROM public.universal_v1_change_order_materialization_commands) +
           (SELECT COUNT(*) FROM public.universal_v1_fake_financial_lifecycle_bridges) +
           (SELECT COUNT(*) FROM public.universal_v1_fake_terminal_lifecycle_intents) +
           (SELECT COUNT(*) FROM public.universal_v1_fake_provider_account_facts) +
           (SELECT COUNT(*) FROM public.universal_v1_fake_reconciliation_bridges)
         )::INTEGER AS target_rows,
         (
           SELECT COUNT(*)::INTEGER
             FROM pg_catalog.jsonb_to_recordset($2::JSONB)
               AS expected(signature TEXT)
            WHERE pg_catalog.has_function_privilege($1, expected.signature, 'EXECUTE')
         ) AS runtime_execute_count`,
      [runtimeRole, JSON.stringify(ports)]
    );
    expect(authority.rows[0]).toEqual({ target_rows: 0, runtime_execute_count: 0 });
  });

  it('proves all ten exact sealed identities and every required INSERT trigger root', async () => {
    const functions = await functionCatalog();
    expect(functions).toHaveLength(ports.length);
    expect(new Set(functions.map(({ owner_name }) => owner_name)).size).toBe(1);
    for (const expected of ports) {
      const observed = functions.find(({ signature }) => signature === expected.signature);
      expect(observed).toEqual({
        signature: expected.signature,
        owner_name: 'hx_ci_runner',
        return_type: expected.returnType,
        security_definer: true,
        volatility: 'v',
        parallel_safety: 'u',
        configuration: ['search_path=pg_catalog, public'],
        marker_present: true,
        public_execute: false,
      });
    }

    const missing = await databaseClient!.query<{
      relation_name: string;
      trigger_name: string;
      function_signature: string;
    }>(
      `SELECT expected.*
         FROM pg_catalog.jsonb_to_recordset($1::JSONB)
           AS expected(
             relation_name TEXT,
             trigger_name TEXT,
             function_signature TEXT
           )
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_trigger trigger_record
            JOIN pg_catalog.pg_class relation ON relation.oid = trigger_record.tgrelid
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND relation.relname = expected.relation_name
             AND trigger_record.tgname = expected.trigger_name
             AND NOT trigger_record.tgisinternal
             AND (trigger_record.tgtype::INTEGER & 4) = 4
             AND trigger_record.tgfoid =
               pg_catalog.to_regprocedure(expected.function_signature)::OID
             AND trigger_record.tgenabled IN ('O', 'A')
        )`,
      [
        JSON.stringify(
          requiredTriggerRoots.map(([relationName, triggerName, functionSignature]) => ({
            relation_name: relationName,
            trigger_name: triggerName,
            function_signature: functionSignature,
          }))
        ),
      ]
    );
    expect(missing.rows).toEqual([]);

    const deferredGuards = await databaseClient!.query<{
      function_signature: string;
      owner_name: string;
      security_definer: boolean;
      configuration: string[];
      public_execute: boolean;
    }>(
      `SELECT expected.function_signature,
              pg_catalog.pg_get_userbyid(procedure.proowner) AS owner_name,
              procedure.prosecdef AS security_definer,
              procedure.proconfig AS configuration,
              EXISTS (
                SELECT 1
                  FROM pg_catalog.aclexplode(COALESCE(
                    procedure.proacl,
                    pg_catalog.acldefault('f', procedure.proowner)
                  )) privilege
                 WHERE privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute
         FROM pg_catalog.unnest($1::TEXT[]) expected(function_signature)
         JOIN pg_catalog.pg_proc procedure
           ON procedure.oid =
              pg_catalog.to_regprocedure(expected.function_signature)::OID
        ORDER BY expected.function_signature`,
      [[...deferredIntegrityGuards]]
    );
    expect(deferredGuards.rows).toEqual(
      [...deferredIntegrityGuards].sort().map((functionSignature) => ({
        function_signature: functionSignature,
        owner_name: 'hx_ci_runner',
        security_definer: true,
        configuration: ['search_path=pg_catalog, public'],
        public_execute: false,
      }))
    );
  });

  it('fails closed over a changed marker, SECURITY mode, trigger root, or owner catalog', async () => {
    const candidates = [
      migrationSql.replace('-- HXUV1-NPFIP-V1:JOURNAL', '-- HXUV1-NPFIP-V1:ALTERED_JOURNAL_BODY'),
      migrationSql.replace(/SECURITY DEFINER\s+VOLATILE/u, 'SECURITY INVOKER\nVOLATILE'),
    ];
    for (const candidate of candidates) {
      expect(candidate).not.toBe(migrationSql);
      await databaseClient!.query('BEGIN');
      try {
        await expectDatabaseRefusal(() => databaseClient!.query(candidate), /HXUV1-NPFIP-4/u);
      } finally {
        await databaseClient!.query('ROLLBACK');
      }
    }

    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `ALTER TABLE public.financial_provider_command_journal
           DISABLE TRIGGER financial_provider_command_prepared_authority_guard`
      );
      await expectDatabaseRefusal(() => databaseClient!.query(migrationSql), /HXUV1-NPFIP-1/u);
    } finally {
      await databaseClient!.query('ROLLBACK');
    }

    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `GRANT CREATE ON SCHEMA public TO ${quotedIdentifier(authorityOwner)};
         ALTER FUNCTION ${ports[0].signature} OWNER TO ${quotedIdentifier(authorityOwner)}`
      );
      await expectDatabaseRefusal(() => databaseClient!.query(migrationSql), /HXUV1-NPFIP-4/u);
    } finally {
      await databaseClient!.query('ROLLBACK');
    }
  });

  it('provisions one genuine NOLOGIN owner and only exact EXECUTE to the LOGIN runtime', async () => {
    expect(ports).toHaveLength(10);
    expect(runtimeCallablePorts).toHaveLength(8);
    expect(ownerOnlyPrimitiveBridgePortSignatures.size).toBe(2);
    expect(deferredIntegrityGuards).toHaveLength(3);
    await databaseClient!.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO ${quotedIdentifier(authorityOwner)};
       GRANT USAGE ON SCHEMA public TO ${quotedIdentifier(runtimeRole)};
        GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public
          TO ${quotedIdentifier(authorityOwner)};
        GRANT UPDATE ON TABLE
          public.task_drafts,
          public.tasks,
          public.task_scope_versions,
          public.task_provider_eligibility_decisions,
          public.task_work_orders,
          public.financial_provider_command_journal,
          public.universal_v1_prepared_financial_commands,
          public.financial_provider_command_dispatch_attempts,
          public.financial_provider_command_outcome_facts,
          public.hxos_fake_financial_operations_v1,
          public.hxos_fake_financial_operation_events_v1,
          public.task_financial_security_events,
          public.universal_v1_fake_financial_lifecycle_bridges,
          public.task_reconciliation_facts,
          public.universal_v1_fake_reconciliation_bridges
          TO ${quotedIdentifier(authorityOwner)};
       GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
         TO ${quotedIdentifier(authorityOwner)};
       GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
         TO ${quotedIdentifier(authorityOwner)}`
    );
    for (const { signature } of ports) {
      await databaseClient!.query(
        `ALTER FUNCTION ${signature} OWNER TO ${quotedIdentifier(authorityOwner)}`
      );
    }
    for (const { signature } of runtimeCallablePorts) {
      await databaseClient!.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(runtimeRole)}`
      );
    }
    for (const signature of deferredIntegrityGuards) {
      await databaseClient!.query(
        `ALTER FUNCTION ${signature} OWNER TO ${quotedIdentifier(authorityOwner)}`
      );
    }

    const roles = await adminClient!.query<{
      role_name: string;
      can_login: boolean;
      is_superuser: boolean;
      can_create_role: boolean;
      can_create_database: boolean;
      can_replicate: boolean;
      can_bypass_rls: boolean;
    }>(
      `SELECT rolname AS role_name, rolcanlogin AS can_login, rolsuper AS is_superuser,
              rolcreaterole AS can_create_role, rolcreatedb AS can_create_database,
              rolreplication AS can_replicate, rolbypassrls AS can_bypass_rls
         FROM pg_catalog.pg_roles
        WHERE rolname = ANY($1::TEXT[])
        ORDER BY rolname`,
      [[authorityOwner, runtimeRole]]
    );
    expect(roles.rows).toEqual(
      [
        {
          role_name: runtimeRole,
          can_login: true,
          is_superuser: false,
          can_create_role: false,
          can_create_database: false,
          can_replicate: false,
          can_bypass_rls: false,
        },
        {
          role_name: authorityOwner,
          can_login: false,
          is_superuser: false,
          can_create_role: false,
          can_create_database: false,
          can_replicate: false,
          can_bypass_rls: false,
        },
      ].sort((left, right) => left.role_name.localeCompare(right.role_name))
    );

    const functions = await functionCatalog();
    expect(new Set(functions.map(({ owner_name }) => owner_name))).toEqual(
      new Set([authorityOwner])
    );
    const privileges = await databaseClient!.query<{
      runtime_callable_execute_count: number;
      runtime_primitive_bridge_execute_count: number;
      runtime_deferred_guard_execute_count: number;
      runtime_journal_insert: boolean;
      runtime_dispatch_insert: boolean;
    }>(
      `SELECT
         (
           SELECT COUNT(*)::INTEGER
             FROM pg_catalog.jsonb_to_recordset($2::JSONB)
               AS expected(signature TEXT)
            WHERE pg_catalog.has_function_privilege($1, expected.signature, 'EXECUTE')
         ) AS runtime_callable_execute_count,
         (
            SELECT COUNT(*)::INTEGER
             FROM pg_catalog.unnest($3::TEXT[]) guard(function_signature)
            WHERE pg_catalog.has_function_privilege(
              $1, guard.function_signature, 'EXECUTE'
            )
         ) AS runtime_deferred_guard_execute_count,
         (
           SELECT COUNT(*)::INTEGER
             FROM pg_catalog.unnest($4::TEXT[]) primitive(function_signature)
            WHERE pg_catalog.has_function_privilege(
              $1, primitive.function_signature, 'EXECUTE'
            )
         ) AS runtime_primitive_bridge_execute_count,
         pg_catalog.has_table_privilege(
           $1, 'public.financial_provider_command_journal', 'INSERT'
         ) AS runtime_journal_insert,
         pg_catalog.has_table_privilege(
           $1, 'public.financial_provider_command_dispatch_attempts', 'INSERT'
         ) AS runtime_dispatch_insert`,
      [
        runtimeRole,
        JSON.stringify(runtimeCallablePorts),
        [...deferredIntegrityGuards],
        [...ownerOnlyPrimitiveBridgePortSignatures],
      ]
    );
    expect(privileges.rows[0]).toEqual({
      runtime_callable_execute_count: runtimeCallablePorts.length,
      runtime_primitive_bridge_execute_count: 0,
      runtime_deferred_guard_execute_count: 0,
      runtime_journal_insert: false,
      runtime_dispatch_insert: false,
    });
  });

  it('records genuine journal and dispatch facts through ports while direct INSERT remains denied', async () => {
    const commandId = randomUUID();
    const operationId = randomUUID();
    const idempotencyKey = `runtime-insert:${randomUUID()}`;
    const requestSha256 = sha256('synthetic-ingest-webhook-request');
    const commandIdentitySha256 = sha256('synthetic-ingest-webhook-command');

    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `INSERT INTO public.financial_provider_command_journal DEFAULT VALUES`
        ),
      /permission denied/iu
    );
    const journal = await runtimeClient!.query<{
      command_id: string;
      operation_kind: string;
      provider_kind: string;
      request_sha256: string;
    }>(
      `SELECT command_id, operation_kind, provider_kind, request_sha256::TEXT
         FROM public.hxos_record_financial_provider_command_v1(
           $1, 'INGEST_WEBHOOK', $2, 'FAKE', $3, 0, $4, $5,
           NULL::UUID, NULL::TEXT, NULL::UUID, NULL::UUID, NULL::UUID,
           NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::UUID, NULL::TEXT,
           NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT
         )`,
      [commandId, operationId, idempotencyKey, requestSha256, commandIdentitySha256]
    );
    expect(journal.rows[0]).toEqual({
      command_id: commandId,
      operation_kind: 'INGEST_WEBHOOK',
      provider_kind: 'FAKE',
      request_sha256: requestSha256,
    });

    const leaseOwnerId = randomUUID();
    await databaseClient!.query(`SET ROLE ${quotedIdentifier(authorityOwner)}`);
    let recoveryLeaseId: string;
    try {
      const lease = await databaseClient!.query<{ recovery_lease_id: string }>(
        `INSERT INTO public.financial_provider_command_recovery_leases(
           command_id, recovery_action, lease_owner_id, lease_duration_seconds,
           acquired_at, expires_at
         ) VALUES (
           $1, 'DISPATCH', $2, 60, pg_catalog.clock_timestamp(),
           pg_catalog.clock_timestamp() + INTERVAL '60 seconds'
         )
         RETURNING recovery_lease_id`,
        [commandId, leaseOwnerId]
      );
      recoveryLeaseId = lease.rows[0]!.recovery_lease_id;
    } finally {
      await databaseClient!.query('RESET ROLE');
    }

    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `INSERT INTO public.financial_provider_command_dispatch_attempts DEFAULT VALUES`
        ),
      /permission denied/iu
    );
    const dispatchAttemptId = randomUUID();
    const dispatch = await runtimeClient!.query<{
      dispatch_attempt_id: string;
      command_id: string;
      recovery_lease_id: string;
      attempt_number: string;
      request_sha256: string;
      timeout_seconds: number;
    }>(
      `SELECT dispatch_attempt_id, command_id, recovery_lease_id,
              attempt_number::TEXT, request_sha256::TEXT,
              EXTRACT(EPOCH FROM outcome_deadline_at - attempted_at)::INTEGER
                AS timeout_seconds
         FROM public.hxos_record_financial_provider_dispatch_attempt_v1(
           $1, $2, $3, 15
         )`,
      [dispatchAttemptId, commandId, recoveryLeaseId]
    );
    expect(dispatch.rows[0]).toEqual({
      dispatch_attempt_id: dispatchAttemptId,
      command_id: commandId,
      recovery_lease_id: recoveryLeaseId,
      attempt_number: '1',
      request_sha256: requestSha256,
      timeout_seconds: 15,
    });

    const effects = await databaseClient!.query<{
      journal_rows: number;
      dispatch_rows: number;
      outcome_rows: number;
      fake_event_rows: number;
      financial_security_rows: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER FROM public.financial_provider_command_journal)
           AS journal_rows,
         (SELECT COUNT(*)::INTEGER FROM public.financial_provider_command_dispatch_attempts)
           AS dispatch_rows,
         (SELECT COUNT(*)::INTEGER FROM public.financial_provider_command_outcome_facts)
           AS outcome_rows,
         (SELECT COUNT(*)::INTEGER FROM public.hxos_fake_financial_operation_events_v1)
           AS fake_event_rows,
         (SELECT COUNT(*)::INTEGER FROM public.task_financial_security_events)
           AS financial_security_rows`
    );
    expect(effects.rows[0]).toEqual({
      journal_rows: 1,
      dispatch_rows: 1,
      outcome_rows: 0,
      fake_event_rows: 0,
      financial_security_rows: 0,
    });
  });

  it('atomically records a genuine fake lifecycle fact and bridge while wrong authority fails closed', async () => {
    const userId = randomUUID();
    const taskId = randomUUID();
    const draftId = randomUUID();
    const leadId = randomUUID();
    const claimEventId = randomUUID();
    const scopeId = randomUUID();
    const routeId = randomUUID();
    const eligibilityId = randomUUID();
    const operationId = randomUUID();
    const preparedCommandId = randomUUID();
    const commandId = randomUUID();
    const leaseId = randomUUID();
    const leaseOwnerId = randomUUID();
    const dispatchAttemptId = randomUUID();
    const outcomeFactId = randomUUID();
    const fakeOperationEventId = randomUUID();
    const lifecycleEventId = randomUUID();
    const lifecycleBridgeId = randomUUID();
    const idempotencyKey = `runtime-port-prepare:${randomUUID()}`;
    const requestSha256 = sha256(`provider-request:${idempotencyKey}`);
    const commandIdentitySha256 = sha256(`command-identity:${idempotencyKey}`);
    const externalReference = `fake_prepare_payment_method_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const externalReferenceSha256 = sha256(externalReference);
    const providerResultSha256 = sha256(
      `${operationId}:PREPARE_PAYMENT_METHOD:FAKE:SUCCEEDED:1:::${externalReferenceSha256}:false`
    );

    await databaseClient!.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, date_of_birth,
         account_status, is_minor, is_banned
       ) VALUES (
         $1, $2, $3, 'Runtime lifecycle port proof', 'poster', DATE '1990-01-01',
         'ACTIVE', FALSE, FALSE
       )`,
      [userId, `firebase:${userId}`, `${userId}@synthetic.invalid`]
    );
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `INSERT INTO public.tasks(
         id, poster_id, title, description, price, automation_classification,
         hustler_payout_cents, platform_margin_cents, active_scope_version_id,
         currency, universal_contract_version, payment_method,
         universal_payment_posture, category, risk_level, requires_proof,
         region_code, region_policy_id, region_policy_version,
         region_policy_hash, region_policy_snapshot, trade_type,
         location_state, license_required, insurance_required,
         background_check_required, proof_min_photos, proof_max_photos,
         proof_gps_required
       )
       SELECT
         $1, $2, 'Runtime lifecycle port proof',
         'Synthetic nonproduction role-separated authority fixture.', 6000,
         'CONTROLLED_TEST', 5000, 1000, $3,
         policy.policy_document #>> '{financial,currency}', 1,
         'universal_financial_security', 'PAYMENT_CREATION_FROZEN',
         'yard', category.document->'allowedRiskLevels'->>0,
         (category.document #>> '{evidence,proofRequired}')::BOOLEAN,
         policy.region_code, policy.id, policy.version, policy.policy_hash,
         pg_catalog.jsonb_build_object(
           'policyId', policy.id::TEXT,
           'policyVersion', policy.version,
           'policyHash', policy.policy_hash,
           'regionCode', policy.region_code,
           'locationState', pg_catalog.split_part(policy.region_code, '-', 2),
           'licenseRequired',
             (category.document #>> '{credentials,licenseRequired}')::BOOLEAN,
           'insuranceRequired',
             (category.document #>> '{credentials,insuranceRequired}')::BOOLEAN,
           'backgroundCheckRequired',
             (category.document #>> '{credentials,backgroundCheckRequired}')::BOOLEAN,
           'proofRequired',
             (category.document #>> '{evidence,proofRequired}')::BOOLEAN,
           'proofMinPhotos',
             (category.document #>> '{evidence,minPhotos}')::INTEGER,
           'proofMaxPhotos',
             (category.document #>> '{evidence,maxPhotos}')::INTEGER,
           'proofGpsRequired',
             (category.document #>> '{evidence,gpsRequired}')::BOOLEAN,
           'recordingAllowed',
             (policy.policy_document #>> '{recording,allowed}')::BOOLEAN,
           'recordingStandaloneConsentRequired',
             (policy.policy_document #>> '{recording,standaloneConsentRequired}')::BOOLEAN,
           'screeningStandaloneConsentRequired',
             (policy.policy_document #>> '{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
           'screeningReportAccessRequired',
             (policy.policy_document #>> '{workerRights,reportAccessRequired}')::BOOLEAN,
           'screeningDisputeAndAppealRequired',
             (policy.policy_document #>> '{workerRights,disputeAndAppealRequired}')::BOOLEAN,
           'screeningAdverseActionNoticeRequired',
             (policy.policy_document #>> '{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
           'safetyIncidentIntakeRequired',
             (policy.policy_document #>> '{safety,incidentIntakeRequired}')::BOOLEAN,
           'safetyTimedCheckinRequired',
             (policy.policy_document #> '{safety,timedCheckinRiskLevels}')
               ? (category.document->'allowedRiskLevels'->>0),
           'safetyCheckinIntervalsMinutes',
             policy.policy_document #> '{safety,checkinIntervalsMinutes}',
           'safetyLocationRetentionDays',
             (policy.policy_document #>> '{safety,locationRetentionDays}')::INTEGER,
           'safetyAlternateEmergencyActionRequired',
             (policy.policy_document #>> '{safety,alternateEmergencyActionRequired}')::BOOLEAN,
           'currency', policy.policy_document #>> '{financial,currency}'
         ),
         'yard', pg_catalog.split_part(policy.region_code, '-', 2),
         (category.document #>> '{credentials,licenseRequired}')::BOOLEAN,
         (category.document #>> '{credentials,insuranceRequired}')::BOOLEAN,
         (category.document #>> '{credentials,backgroundCheckRequired}')::BOOLEAN,
         (category.document #>> '{evidence,minPhotos}')::INTEGER,
         (category.document #>> '{evidence,maxPhotos}')::INTEGER,
         (category.document #>> '{evidence,gpsRequired}')::BOOLEAN
       FROM public.region_policies policy
       CROSS JOIN LATERAL (
         SELECT policy.policy_document->'categories'->'yard' AS document
       ) category
       WHERE policy.region_code = 'US-WA'
         AND policy.version = 'us-wa-price-book-2026-07-20-v2'
         AND policy.policy_state = 'ACTIVE'`,
        [taskId, userId, scopeId]
      );
      await databaseClient!.query(
        `INSERT INTO public.task_scope_versions(
           id, task_id, version, scope_hash, title, description, checklist,
           customer_total_cents, hustler_payout_cents, source, change_summary,
           created_by, universal_contract_version, currency
         ) VALUES (
           $1, $2, 1, repeat('7', 64), 'Runtime lifecycle port scope',
           'Synthetic nonproduction scope.', '[]'::JSONB, 6000, 5000,
           'INITIAL', 'Initial synthetic scope', $3, 1, 'USD'
         )`,
        [scopeId, taskId, userId]
      );
      await databaseClient!.query('COMMIT');
    } catch (error) {
      await databaseClient!.query('ROLLBACK');
      throw error;
    }
    await databaseClient!.query(
      `INSERT INTO public.leads(
         id, submission_id, lead_type, email, name, answers, source
       ) VALUES (
         $1, $2, 'poster', $3, 'Runtime lifecycle port proof',
         pg_catalog.jsonb_build_object('task_draft_id', $4::TEXT),
         'required_test'
       )`,
      [leadId, randomUUID(), `${leadId}@synthetic.invalid`, draftId]
    );
    await databaseClient!.query(
      `INSERT INTO public.task_drafts(
         id, submission_id, card_token_hash, category, raw_input,
         status, poster_user_id, task_id, universal_contract_version,
         ingress_origin, ingress_contract_version,
         card_token_contract_version, lead_id
       ) VALUES (
         $1, $2, repeat('a', 64), 'yard',
         'Synthetic runtime lifecycle port PostgreSQL proof',
         'contact_captured', NULL, NULL, 1,
         'BACKEND_POSTGRESQL', 1, 1, $3
       )`,
      [draftId, randomUUID(), leadId]
    );
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `INSERT INTO public.task_draft_account_claim_events(
           id, task_draft_id, actor_user_id, event_version, expected_version,
           idempotency_key, request_sha256, status_before, status_after,
           correlation_id
         ) VALUES (
           $1, $2, $3, 1, 0, $4, $5,
           'contact_captured', 'account_claimed', $6
         )`,
        [
          claimEventId,
          draftId,
          userId,
          `runtime-port-claim:${draftId}`,
          sha256(`runtime-port-claim:${draftId}`),
          randomUUID(),
        ]
      );
      await databaseClient!.query(
        `UPDATE public.task_drafts
            SET poster_user_id = $2,
                claimed_at = pg_catalog.clock_timestamp(),
                status = 'account_claimed',
                updated_at = pg_catalog.clock_timestamp()
          WHERE id = $1`,
        [draftId, userId]
      );
      await databaseClient!.query('COMMIT');
    } catch (error) {
      await databaseClient!.query('ROLLBACK');
      throw error;
    }
    await databaseClient!.query(
      `INSERT INTO public.task_routing_decisions(
         id, task_draft_id, decision_version, outcome, reason_codes,
         policy_version, category_snapshot, decision_authority, idempotency_key
       ) VALUES (
         $1, $2, 1, 'FULFILLMENT_CANDIDATE', ARRAY['SYNTHETIC_PORT_PROOF'],
         'runtime-port-proof-v1', 'yard', 'DETERMINISTIC_POLICY', $3
       )`,
      [routeId, draftId, `runtime-port-route:${randomUUID()}`]
    );
    // This bootstrap-only bind isolates the v11 runtime role boundary from the
    // separately tested estimate-materialization lane. Successful production
    // code never receives this admin capability.
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(`SET LOCAL session_replication_role = 'replica'`);
      await databaseClient!.query(
        `UPDATE public.task_drafts
            SET task_id = $2,
                active_routing_decision_id = $3,
                updated_at = pg_catalog.clock_timestamp()
          WHERE id = $1`,
        [draftId, taskId, routeId]
      );
      await databaseClient!.query('COMMIT');
    } catch (error) {
      await databaseClient!.query('ROLLBACK');
      throw error;
    }
    await databaseClient!.query(
      `INSERT INTO public.task_provider_eligibility_decisions(
         id, task_draft_id, task_id, scope_version_id, routing_decision_id,
         decision_version, provider_user_id, provider_class,
         profile_eligible, identity_eligible, category_eligible,
         credential_eligible, geography_eligible, availability_eligible,
         restriction_clear, task_eligible, processor_payment_eligible,
         payout_funding_eligible, trust_tier, policy_version, decided_by,
         idempotency_key, evaluated_at, valid_until
       ) VALUES (
         $1, $2, $3, $4, $5, 1, $6, 'GENERAL_SERVICE_PROVIDER',
         TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE,
         'TIER_1', 'runtime-port-proof-v1', $6, $7,
         pg_catalog.clock_timestamp(), TIMESTAMPTZ '2040-01-01 00:00:00Z'
       )`,
      [
        eligibilityId,
        draftId,
        taskId,
        scopeId,
        routeId,
        userId,
        `runtime-port-eligibility:${randomUUID()}`,
      ]
    );
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(`INSERT INTO public.task_financial_security_events DEFAULT VALUES`),
      /permission denied/iu
    );
    await expectDatabaseRefusal(
      () => runtimeClient!.query(`INSERT INTO public.task_reconciliation_facts DEFAULT VALUES`),
      /permission denied/iu
    );
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `SELECT * FROM public.hxos_record_fake_financial_security_event_v1(
             $1,$2,'APPROVED_PROVIDER',$3,$4,$5,$6,$7,$8,$9
           )`,
          [
            lifecycleEventId,
            lifecycleBridgeId,
            operationId,
            idempotencyKey,
            preparedCommandId,
            commandId,
            dispatchAttemptId,
            outcomeFactId,
            fakeOperationEventId,
          ]
        ),
      /HXUV1-NPFIP-5/iu
    );
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `SELECT * FROM public.hxos_record_fake_financial_security_event_v1(
             $1,$2,'FAKE',$3,$4,$5,$6,$7,$8,$9
           )`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            `runtime-port-incomplete:${randomUUID()}`,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
          ]
        ),
      /HXUV1-NPFIP-6/iu
    );
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `SELECT * FROM public.hxos_record_fake_reconciliation_fact_v1(
             $1,$2,'APPROVED_PROVIDER',$3,$4,$5,$6,$7,$8,$9,$10,$11
           )`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            `runtime-port-reconcile:${randomUUID()}`,
            'a'.repeat(64),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            'b'.repeat(64),
          ]
        ),
      /HXUV1-NPFIP-8/iu
    );

    const prepared = await runtimeClient!.query<{
      prepared_command_id: string;
      authority_context_sha256: string;
    }>(
      `SELECT prepared_command_id, authority_context_sha256::TEXT
         FROM public.hxos_prepare_universal_v1_financial_command_v1(
           $1, 'PREPARE_PAYMENT_METHOD', $2, 'FAKE', $3, 0, 0, $4,
           $5, $6, $7, $8, NULL::UUID, NULL::UUID, NULL::UUID,
           NULL::UUID, NULL::BIGINT, NULL::TEXT, $9
         )`,
      [
        preparedCommandId,
        operationId,
        idempotencyKey,
        requestSha256,
        draftId,
        taskId,
        eligibilityId,
        scopeId,
        userId,
      ]
    );
    expect(prepared.rows[0]?.prepared_command_id).toBe(preparedCommandId);

    await runtimeClient!.query(
      `SELECT command_id
         FROM public.hxos_record_financial_provider_command_v1(
           $1, 'PREPARE_PAYMENT_METHOD', $2, 'FAKE', $3, 0, $4, $5,
           $6, $7, $8, $9, NULL::UUID, NULL::UUID, NULL::BIGINT,
           NULL::TEXT, $10, 'PARTICIPANT', NULL::TEXT, NULL::TEXT,
           NULL::TEXT, NULL::TEXT, NULL::TEXT
         )`,
      [
        commandId,
        operationId,
        idempotencyKey,
        requestSha256,
        commandIdentitySha256,
        preparedCommandId,
        prepared.rows[0]!.authority_context_sha256,
        draftId,
        taskId,
        userId,
      ]
    );

    await databaseClient!.query(`SET ROLE ${quotedIdentifier(authorityOwner)}`);
    try {
      await databaseClient!.query(
        `INSERT INTO public.financial_provider_command_recovery_leases(
           recovery_lease_id, command_id, recovery_action, lease_owner_id,
           lease_duration_seconds, acquired_at, expires_at
         ) VALUES (
           $1, $2, 'DISPATCH', $3, 60, pg_catalog.clock_timestamp(),
           pg_catalog.clock_timestamp() + INTERVAL '60 seconds'
         )`,
        [leaseId, commandId, leaseOwnerId]
      );
    } finally {
      await databaseClient!.query('RESET ROLE');
    }
    await runtimeClient!.query(
      `SELECT dispatch_attempt_id
         FROM public.hxos_record_financial_provider_dispatch_attempt_v1(
           $1,$2,$3,30
         )`,
      [dispatchAttemptId, commandId, leaseId]
    );

    await databaseClient!.query(`SET ROLE ${quotedIdentifier(authorityOwner)}`);
    try {
      await databaseClient!.query(
        `INSERT INTO public.financial_provider_command_outcome_facts(
           outcome_fact_id, command_id, dispatch_attempt_id, recovery_lease_id,
           outcome_kind, observation_idempotency_key, provider_result_sha256,
           provider_state, provider_result_version, amount_cents, currency,
           external_reference_sha256, effect_certainty, retryable
         ) VALUES (
           $1, $2, $3, $4, 'OUTCOME_OBSERVED', $5, $6, 'SUCCEEDED', 1,
           NULL, NULL, $7, 'CONFIRMED_EFFECT', FALSE
         )`,
        [
          outcomeFactId,
          commandId,
          dispatchAttemptId,
          leaseId,
          `runtime-port-outcome:${randomUUID()}`,
          providerResultSha256,
          externalReferenceSha256,
        ]
      );
    } finally {
      await databaseClient!.query('RESET ROLE');
    }

    const attemptMismatchedRawEvent = async (input: {
      eventVersion: number;
      state: 'SUCCEEDED' | 'DECLINED';
      scenario: 'SUCCESS' | 'DECLINE';
      rawExternalReference: string;
    }): Promise<void> => {
      const mismatchedEventId = randomUUID();
      await databaseClient!.query('BEGIN');
      try {
        await databaseClient!.query(`SET ROLE ${quotedIdentifier(authorityOwner)}`);
        await databaseClient!.query(
          `INSERT INTO public.hxos_fake_financial_operations_v1(
             operation_id, operation_kind, identity_sha256, external_reference,
             amount_cents, currency, related_operation_id
           ) VALUES (
             $1, 'PREPARE_PAYMENT_METHOD', repeat('a', 64), $2,
             NULL, NULL, NULL
           )`,
          [operationId, input.rawExternalReference]
        );
        await databaseClient!.query(
          `INSERT INTO public.hxos_fake_financial_operation_events_v1(
             event_id, operation_id, operation_kind, event_version, state,
             scenario, amount_cents, currency, related_operation_id,
             external_reference, idempotency_key, identity_sha256,
             request_sha256, response_sha256, retryable, metadata,
             provider_request_sha256, expires_at
           ) VALUES (
             $1, $2, 'PREPARE_PAYMENT_METHOD', $3, $4, $5,
             NULL, NULL, NULL, $6, $7, repeat('a', 64), repeat('c', 64),
             repeat('d', 64), FALSE,
             pg_catalog.jsonb_build_object('customerId', 'synthetic-runtime-port'),
             $8, NULL
           )`,
          [
            mismatchedEventId,
            operationId,
            input.eventVersion,
            input.state,
            input.scenario,
            input.rawExternalReference,
            idempotencyKey,
            requestSha256,
          ]
        );
        await expectDatabaseRefusal(
          () =>
            databaseClient!.query(
              `SELECT * FROM public.hxos_record_fake_financial_security_event_v1(
                 $1,$2,'FAKE',$3,$4,$5,$6,$7,$8,$9
               )`,
              [
                lifecycleEventId,
                lifecycleBridgeId,
                operationId,
                idempotencyKey,
                preparedCommandId,
                commandId,
                dispatchAttemptId,
                outcomeFactId,
                mismatchedEventId,
              ]
            ),
          /HXUV1-NPFIP-6/iu
        );
      } finally {
        await databaseClient!.query('ROLLBACK');
      }
    };

    await attemptMismatchedRawEvent({
      eventVersion: 2,
      state: 'SUCCEEDED',
      scenario: 'SUCCESS',
      rawExternalReference: externalReference,
    });
    await attemptMismatchedRawEvent({
      eventVersion: 1,
      state: 'DECLINED',
      scenario: 'DECLINE',
      rawExternalReference: externalReference,
    });
    await attemptMismatchedRawEvent({
      eventVersion: 1,
      state: 'SUCCEEDED',
      scenario: 'SUCCESS',
      rawExternalReference: `fake_prepare_payment_method_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    });

    await databaseClient!.query(`SET ROLE ${quotedIdentifier(authorityOwner)}`);
    try {
      await databaseClient!.query(
        `INSERT INTO public.hxos_fake_financial_operations_v1(
           operation_id, operation_kind, identity_sha256, external_reference,
           amount_cents, currency, related_operation_id
         ) VALUES (
           $1, 'PREPARE_PAYMENT_METHOD', repeat('a', 64), $2,
           NULL, NULL, NULL
         )`,
        [operationId, externalReference]
      );
      await databaseClient!.query(
        `INSERT INTO public.hxos_fake_financial_operation_events_v1(
           event_id, operation_id, operation_kind, event_version, state,
           scenario, amount_cents, currency, related_operation_id,
           external_reference, idempotency_key, identity_sha256,
           request_sha256, response_sha256, retryable, metadata,
           provider_request_sha256, expires_at
         ) VALUES (
           $1, $2, 'PREPARE_PAYMENT_METHOD', 1, 'SUCCEEDED', 'SUCCESS',
           NULL, NULL, NULL, $3, $4, repeat('a', 64), repeat('c', 64),
           repeat('d', 64), FALSE,
           pg_catalog.jsonb_build_object('customerId', 'synthetic-runtime-port'),
           $5, NULL
         )`,
        [fakeOperationEventId, operationId, externalReference, idempotencyKey, requestSha256]
      );
    } finally {
      await databaseClient!.query('RESET ROLE');
    }

    const lifecycle = await runtimeClient!.query<{
      id: string;
      operation_id: string;
      event_kind: string;
      provider_kind: string;
      external_reference: string;
      occurred_at: Date;
    }>(
      `SELECT lifecycle.id, lifecycle.operation_id, lifecycle.event_kind,
              lifecycle.provider_kind, lifecycle.external_reference,
              lifecycle.occurred_at
         FROM public.hxos_record_fake_financial_security_event_v1(
           $1,$2,'FAKE',$3,$4,$5,$6,$7,$8,$9
         ) lifecycle`,
      [
        lifecycleEventId,
        lifecycleBridgeId,
        operationId,
        idempotencyKey,
        preparedCommandId,
        commandId,
        dispatchAttemptId,
        outcomeFactId,
        fakeOperationEventId,
      ]
    );
    expect(lifecycle.rows[0]).toEqual({
      id: lifecycleEventId,
      operation_id: operationId,
      event_kind: 'PAYMENT_METHOD_PREPARED',
      provider_kind: 'FAKE',
      external_reference: externalReference,
      occurred_at: expect.any(Date),
    });

    const providerObservation = await databaseClient!.query<{
      recorded_at_matches_provider: boolean;
    }>(
      `SELECT lifecycle.occurred_at = raw.recorded_at AS recorded_at_matches_provider
         FROM public.task_financial_security_events lifecycle
         JOIN public.hxos_fake_financial_operation_events_v1 raw
           ON raw.event_id = $2
        WHERE lifecycle.id = $1`,
      [lifecycleEventId, fakeOperationEventId]
    );
    expect(providerObservation.rows[0]).toEqual({ recorded_at_matches_provider: true });

    const proof = await databaseClient!.query<{
      lifecycle_rows: number;
      bridge_rows: number;
      escrow_rows: number;
      work_order_rows: number;
      quote_payment_rows: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER
            FROM public.task_financial_security_events
           WHERE id = $1) AS lifecycle_rows,
         (SELECT COUNT(*)::INTEGER
            FROM public.universal_v1_fake_financial_lifecycle_bridges
           WHERE bridge_id = $2
             AND task_financial_security_event_id = $1) AS bridge_rows,
         (SELECT COUNT(*)::INTEGER FROM public.escrows WHERE task_id = $3)
           AS escrow_rows,
         (SELECT COUNT(*)::INTEGER FROM public.task_work_orders WHERE task_id = $3)
           AS work_order_rows,
         (SELECT COUNT(*)::INTEGER
            FROM public.quote_payments payment
            JOIN public.quotes quote ON quote.id = payment.quote_id
           WHERE quote.task_draft_id = $4) AS quote_payment_rows`,
      [lifecycleEventId, lifecycleBridgeId, taskId, draftId]
    );
    expect(proof.rows[0]).toEqual({
      lifecycle_rows: 1,
      bridge_rows: 1,
      escrow_rows: 0,
      work_order_rows: 0,
      quote_payment_rows: 0,
    });
  });
});
