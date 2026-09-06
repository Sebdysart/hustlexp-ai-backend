import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { verifyWorkOrderCommandAuthorityInCurrentSnapshot } from '../../src/jobs/work-order-command-role-authority.js';
import { readNonproductionFinancialBootstrapReadiness } from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';
import {
  createFinancialReadinessDatabase,
  financialReadinessSnapshot,
  type FinancialReadinessDatabase,
} from '../helpers/universal-v1-financial-readiness-database.js';

const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
const ownerOnlyPrimitiveBridgeFunctions = [
  'public.hxos_record_fake_financial_lifecycle_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
  'public.hxos_record_fake_reconciliation_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
] as const;

const deferredSecurityDefinerGuards = [
  'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
  'public.require_universal_v1_fake_reconciliation_bridge()',
  'public.require_universal_v1_double_entry_ledger_v1()',
] as const;

const securityDefinerDependencies = [
  'public.digest(text, text)',
  'public.digest(bytea, text)',
] as const;

const deniedMutationRelations = [
  'hxos_fake_financial_schema_evidence_v9',
  'hxos_fake_financial_schema_evidence_v10',
  'hxos_fake_financial_schema_evidence_v11',
  'hxos_fake_financial_schema_evidence_v12',
  'hxos_work_order_bootstrap_seal_evidence_v1',
  'hxos_fake_financial_legacy_expiry_dispositions_v9',
  'hxos_fake_financial_legacy_expiry_compensation_commands_v9',
  'hxos_fake_financial_legacy_expiry_compensation_attempts_v9',
  'hxos_fake_financial_legacy_expiry_compensation_outcomes_v9',
  'hxos_fake_financial_legacy_expiry_compensations_v9',
  'hxos_fake_financial_legacy_expiry_noncompensable_facts_v10',
  'task_financial_security_events',
  'task_reconciliation_facts',
  'task_work_orders',
  'task_work_order_amendments',
  'task_location_access_log',
] as const;

interface DatabaseIdentityInspectionRow extends Record<string, unknown> {
  server_version_num: number;
  server_encoding: string;
  database_encoding: string;
  locale_provider: string;
  lc_collate: string;
  lc_ctype: string;
  icu_locale: string | null;
  icu_rules: string | null;
  recorded_collation_version: string | null;
  actual_collation_version: string | null;
  is_template: boolean;
  allows_connections: boolean;
}

interface DefinitionRow extends Record<string, unknown> {
  definition: string;
}
let context: FinancialReadinessDatabase;
let ownerDatabaseClient: pg.PoolClient;
let runtimeClient: pg.Client;
let adminClient: pg.Client;
let ownerRole: string;
let runtimeRole: string;
let elevatedRole: string;
let authorityDatabase: string;
let authorityQueryExecutions = 0;
let elevatedCreated = false;
function quotedIdentifier(value: string) {
  if (!/^hx_ci_[a-z0-9_]+$/u.test(value) || value.length > 63)
    throw Error('UNSAFE_SYNTHETIC_IDENTIFIER');
  return '"' + value + '"';
}
function readinessOptions() {
  const snapshot = financialReadinessSnapshot(runtimeClient);
  return {
    environment: 'local',
    component: 'backend' as const,
    env: {
      ...context.environment,
      HX_ENVIRONMENT: 'local',
      HX_PAYMENT_CREATION_MODE: 'frozen',
      HX_RUNTIME_DATABASE_NAME: authorityDatabase,
    },
    release: context.authority.release,
    identity: context.authority.identity,
    database: {
      readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) =>
        snapshot.readOnlyAttestationTransaction((query) =>
          fn(async <Row>(sql: string, values?: unknown[]) => {
            const result = await query<Row>(sql, values);
            if (sql.includes('financial_readiness_custody_v13')) authorityQueryExecutions++;
            return result;
          })
        ),
    },
  };
}
async function exactFunctionOwner(signature: string): Promise<string> {
  const result = await ownerDatabaseClient.query(
    'SELECT pg_catalog.pg_get_userbyid(proowner) AS owner FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure($1)',
    [signature]
  );
  if (!result.rows[0]?.owner) throw Error('FUNCTION_OWNER_NOT_FOUND');
  return result.rows[0].owner;
}
async function expectRuntimeReady(): Promise<void> {
  const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
  expect(result).toMatchObject({ required: true, ready: true, status: 'ready' });
}

async function expectRuntimeNotReady(
  status: 'database_identity_mismatch' | 'schema_evidence_mismatch' | 'database_authority_violation'
): Promise<void> {
  const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
  expect(result).toMatchObject({ required: true, ready: false, status });
}

async function expectCatalogRefusal(catalog: 'function' | 'trigger'): Promise<void> {
  const report = await financialReadinessSnapshot(runtimeClient).readOnlyAttestationTransaction(
    (query) =>
      verifyWorkOrderCommandAuthorityInCurrentSnapshot(query, context.environment, 'apiRole')
  );
  expect(report.status).toBe('BLOCKED');
  const prefix =
    catalog === 'function'
      ? 'WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_MISMATCH:'
      : 'WORK_ORDER_TRIGGER_CATALOG_MISMATCH:';
  expect(
    report.reasons.some((reason) => reason.startsWith(prefix)),
    JSON.stringify(report.reasons)
  ).toBe(true);
  // Current command authority detects these bodies before the later schema hash check.
  await expectRuntimeNotReady('database_authority_violation');
}

async function exactFunctionDefinition(signature: string): Promise<string> {
  const result = await ownerDatabaseClient!.query<DefinitionRow>(
    `SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($1)) AS definition`,
    [signature]
  );
  const definition = result.rows[0]?.definition;
  if (!definition) throw new Error(`Missing function definition for ${signature}`);
  return definition;
}

function addBodyDriftMarker(definition: string, marker: string): string {
  const changed = definition.replace(/(\$function\$\r?\n)/u, `$1-- ${marker}\n`);
  if (changed === definition) throw new Error('Could not add a function-body drift marker');
  return changed;
}

async function expectPrivilegeDenied(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    throw new Error('Expected PostgreSQL to deny the runtime mutation');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('42501');
  }
}

describePg('current nonproduction financial runtime PostgreSQL authority', () => {
  beforeAll(async () => {
    context = await createFinancialReadinessDatabase();
    ownerDatabaseClient = await context.fixture.pool.connect();
    runtimeClient = context.clients.get('apiRole')!;
    adminClient = context.root;
    ownerRole = context.roles.financeOwnerRole;
    runtimeRole = context.roles.apiRole;
    elevatedRole = runtimeRole.replace(/_api$/u, '_elevated');
    authorityDatabase = new URL(context.fixture.databaseUrl).pathname.slice(1);
    await adminClient.query(
      'CREATE ROLE ' +
        quotedIdentifier(elevatedRole) +
        ' NOLOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
    );
    elevatedCreated = true;
  }, 120_000);
  afterAll(async () => {
    ownerDatabaseClient?.release();
    try {
      if (elevatedCreated) await adminClient.query('DROP ROLE ' + quotedIdentifier(elevatedRole));
    } finally {
      await context?.close();
    }
  }, 30_000);

  it('attests all eight separated roles and the actual API session as ready', async () => {
    const databaseIdentity = await runtimeClient!.query<DatabaseIdentityInspectionRow>(
      `SELECT pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
              pg_catalog.current_setting('server_encoding') AS server_encoding,
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
    expect(databaseIdentity.rows).toHaveLength(1);
    expect(databaseIdentity.rows[0]?.server_version_num).toBeGreaterThanOrEqual(160_000);
    expect(databaseIdentity.rows[0]?.server_version_num).toBeLessThan(170_000);
    expect(databaseIdentity.rows[0]).toMatchObject({
      server_encoding: 'UTF8',
      database_encoding: 'UTF8',
      locale_provider: 'c',
      lc_collate: 'en_US.utf8',
      lc_ctype: 'en_US.utf8',
      icu_locale: null,
      icu_rules: null,
      recorded_collation_version: null,
      actual_collation_version: null,
      is_template: false,
      allows_connections: true,
    });
    const observed = await context.root.query(
      'SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])',
      [Object.values(context.roles)]
    );
    expect(observed.rows).toHaveLength(8);
    const logins = new Set([
      context.roles.migrationRole,
      context.roles.apiRole,
      context.roles.workerRole,
      context.roles.attesterRole,
    ]);
    for (const role of observed.rows)
      expect(role).toMatchObject({
        rolcanlogin: logins.has(role.rolname),
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false,
      });
    const session = await runtimeClient.query(
      'SELECT current_user AS current_role, session_user AS session_role'
    );
    expect(session.rows[0]).toEqual({ current_role: runtimeRole, session_role: runtimeRole });
    await expectRuntimeReady();
    expect(authorityQueryExecutions).toBeGreaterThan(0);
  });

  it('denies retained recovery wrappers and direct digest calls to every active runtime role', async () => {
    for (const key of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const client = context.clients.get(key)!;
      for (const sql of [
        'SELECT * FROM public.hxos_prepare_legacy_expiry_compensation_v10(NULL,NULL)',
        'SELECT * FROM public.hxos_record_legacy_expiry_compensation_attempt_v10(NULL)',
        'SELECT * FROM public.hxos_finalize_legacy_expiry_compensation_v10(NULL,NULL,NULL,NULL)',
        "SELECT public.digest('closed'::text,'sha256')",
        "SELECT public.digest('closed'::bytea,'sha256')",
      ])
        await expectPrivilegeDenied(() => client.query(sql));
    }
    await expectRuntimeReady();
  });

  it('keeps primitive bridge helpers and all deferred integrity guards owner-only', async () => {
    const signatures = [...ownerOnlyPrimitiveBridgeFunctions, ...deferredSecurityDefinerGuards];
    const functions = await ownerDatabaseClient!.query<{
      function_signature: string;
      owner_name: string;
      is_security_definer: boolean;
      volatility: string;
      parallel_safety: string;
      configuration: string[] | null;
      runtime_can_execute: boolean;
      public_execute_grant: boolean;
    }>(
      `WITH expected(function_signature) AS (
         SELECT pg_catalog.unnest($1::text[])
       )
       SELECT expected.function_signature,
              owner_role.rolname AS owner_name,
              procedure.prosecdef AS is_security_definer,
              procedure.provolatile::text AS volatility,
              procedure.proparallel::text AS parallel_safety,
              procedure.proconfig AS configuration,
              pg_catalog.has_function_privilege(
                $2,
                procedure.oid,
                'EXECUTE'
              ) AS runtime_can_execute,
              EXISTS (
                SELECT 1
                  FROM pg_catalog.aclexplode(COALESCE(
                    procedure.proacl,
                    pg_catalog.acldefault('f', procedure.proowner)
                  )) privilege
                 WHERE privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute_grant
         FROM expected
         JOIN pg_catalog.pg_proc procedure
           ON procedure.oid = pg_catalog.to_regprocedure(expected.function_signature)::oid
         JOIN pg_catalog.pg_roles owner_role
           ON owner_role.oid = procedure.proowner
        ORDER BY expected.function_signature`,
      [signatures, runtimeRole]
    );
    expect(functions.rows).toHaveLength(signatures.length);
    for (const row of functions.rows) {
      expect(row).toMatchObject({
        owner_name: ownerRole,
        is_security_definer: true,
        volatility: 'v',
        parallel_safety: 'u',
        configuration: ['search_path=pg_catalog, public'],
        runtime_can_execute: false,
        public_execute_grant: false,
      });
    }
    await expectRuntimeReady();
  });

  it('fails closed if runtime can execute an owner-only deferred guard', async () => {
    const signature = deferredSecurityDefinerGuards[0];
    await ownerDatabaseClient!.query(
      `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(runtimeRole)}`
    );
    try {
      await expectRuntimeNotReady('database_authority_violation');
    } finally {
      await ownerDatabaseClient!.query(
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${quotedIdentifier(runtimeRole)}`
      );
    }
    await expectRuntimeReady();
  });

  it('fails closed if runtime can execute an owner-only primitive bridge helper', async () => {
    const signature = ownerOnlyPrimitiveBridgeFunctions[0];
    await ownerDatabaseClient!.query(
      `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(runtimeRole)}`
    );
    try {
      await expectRuntimeNotReady('database_authority_violation');
    } finally {
      await ownerDatabaseClient!.query(
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${quotedIdentifier(runtimeRole)}`
      );
    }
    await expectRuntimeReady();
  });

  it('fails closed on a live database-identity mutation and recovers after restoration', async () => {
    await adminClient!.query(
      `ALTER DATABASE ${quotedIdentifier(authorityDatabase)} ALLOW_CONNECTIONS false`
    );
    try {
      await expectRuntimeNotReady('database_identity_mismatch');
    } finally {
      await adminClient!.query(
        `ALTER DATABASE ${quotedIdentifier(authorityDatabase)} ALLOW_CONNECTIONS true`
      );
    }
    await expectRuntimeReady();
  });

  it('detects a same-column critical view replacement through rewrite-rule identity', async () => {
    const view = await ownerDatabaseClient!.query<DefinitionRow>(
      `SELECT pg_catalog.pg_get_viewdef(
                'public.provider_financial_observation_backlog_v1'::regclass,
                false
              ) AS definition`
    );
    const original = view.rows[0]?.definition.replace(/;\s*$/u, '');
    if (!original) throw new Error('Missing critical view definition');
    try {
      await ownerDatabaseClient!.query(
        `CREATE OR REPLACE VIEW public.provider_financial_observation_backlog_v1
         WITH (security_barrier = true) AS
         SELECT * FROM (${original}) AS attested_source WHERE TRUE`
      );
      await expectRuntimeNotReady('schema_evidence_mismatch');
    } finally {
      await ownerDatabaseClient!.query(
        `CREATE OR REPLACE VIEW public.provider_financial_observation_backlog_v1
         WITH (security_barrier = true) AS ${original}`
      );
    }
    await expectRuntimeReady();
  });

  it('detects an added INSTEAD rewrite rule on a critical table', async () => {
    try {
      await ownerDatabaseClient!.query(
        `CREATE RULE hx_ci_runtime_authority_insert_redirect AS
           ON INSERT TO public.provider_event_inbox_receipts
           DO INSTEAD NOTHING`
      );
      await expectRuntimeNotReady('schema_evidence_mismatch');
    } finally {
      await ownerDatabaseClient!.query(
        `DROP RULE IF EXISTS hx_ci_runtime_authority_insert_redirect
           ON public.provider_event_inbox_receipts`
      );
    }
    await expectRuntimeReady();
  });

  it('detects body drift in a trigger function omitted from the former static list', async () => {
    const signature = 'public.validate_universal_v1_fake_terminal_dispatch_attempt()';
    const original = await exactFunctionDefinition(signature);
    try {
      await ownerDatabaseClient!.query(
        addBodyDriftMarker(original, 'HX_CI_TRIGGER_BODY_DRIFT_MUST_BE_ATTESTED')
      );
      await expectCatalogRefusal('trigger');
    } finally {
      await ownerDatabaseClient!.query(original);
    }
    await expectRuntimeReady();
  });

  it('detects body drift in a transitive helper that is not itself a trigger', async () => {
    const signature =
      'public.universal_v1_change_order_compensating_reversal_is_exact_v1(public.task_financial_security_events,public.task_financial_security_events)';
    const original = await exactFunctionDefinition(signature);
    try {
      await ownerDatabaseClient!.query(
        addBodyDriftMarker(original, 'HX_CI_TRANSITIVE_HELPER_DRIFT_MUST_BE_ATTESTED')
      );
      await expectCatalogRefusal('function');
    } finally {
      await ownerDatabaseClient!.query(original);
    }
    await expectRuntimeReady();
  });

  it('detects an elevated LOGIN owner on a derived critical trigger function', async () => {
    const signature = 'public.validate_universal_v1_fake_terminal_dispatch_attempt()';
    const originalOwner = await exactFunctionOwner(signature);
    await ownerDatabaseClient!.query(`ALTER FUNCTION ${signature} OWNER TO hx_ci_runner`);
    try {
      await expectRuntimeNotReady('database_authority_violation');
    } finally {
      await ownerDatabaseClient!.query(
        `ALTER FUNCTION ${signature} OWNER TO ${quotedIdentifier(originalOwner)}`
      );
    }
    await expectRuntimeReady();
  });

  it('detects pgcrypto dependency membership, safety, and owner drift', async () => {
    const signature = 'public.digest(bytea, text)';
    await ownerDatabaseClient!.query(`ALTER EXTENSION pgcrypto DROP FUNCTION ${signature}`);
    try {
      await expectRuntimeNotReady('database_authority_violation');
    } finally {
      await ownerDatabaseClient!.query(`ALTER EXTENSION pgcrypto ADD FUNCTION ${signature}`);
    }
    await expectRuntimeReady();

    await ownerDatabaseClient!.query(`ALTER FUNCTION ${signature} PARALLEL RESTRICTED`);
    try {
      await expectRuntimeNotReady('database_authority_violation');
    } finally {
      await ownerDatabaseClient!.query(`ALTER FUNCTION ${signature} PARALLEL SAFE`);
    }
    await expectRuntimeReady();

    await ownerDatabaseClient!.query(`ALTER FUNCTION ${signature} OWNER TO hx_ci_runner`);
    try {
      await expectRuntimeNotReady('database_authority_violation');
    } finally {
      await ownerDatabaseClient!.query(
        `ALTER FUNCTION ${signature} OWNER TO ${quotedIdentifier(ownerRole)}`
      );
    }
    await expectRuntimeReady();
  });

  it('denies direct INSERT, UPDATE, and DELETE on v9-v12 and lifecycle authority tables', async () => {
    const columns = await ownerDatabaseClient!.query<{
      relation_name: string;
      column_name: string;
    }>(
      `SELECT relation.relname AS relation_name,
              (
                SELECT attribute.attname
                  FROM pg_catalog.pg_attribute attribute
                 WHERE attribute.attrelid = relation.oid
                   AND attribute.attnum > 0
                   AND NOT attribute.attisdropped
                 ORDER BY attribute.attnum
                 LIMIT 1
              ) AS column_name
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname`,
      [deniedMutationRelations]
    );
    expect(columns.rows).toHaveLength(deniedMutationRelations.length);
    for (const { relation_name, column_name } of columns.rows) {
      await expectPrivilegeDenied(() =>
        runtimeClient!.query(`INSERT INTO public."${relation_name}" DEFAULT VALUES`)
      );
      await expectPrivilegeDenied(() =>
        runtimeClient!.query(
          `UPDATE public."${relation_name}" SET "${column_name}" = "${column_name}" WHERE FALSE`
        )
      );
      await expectPrivilegeDenied(() =>
        runtimeClient!.query(`DELETE FROM public."${relation_name}" WHERE FALSE`)
      );
    }
  });

  it('fails closed when the runtime receives one forbidden relation privilege', async () => {
    await ownerDatabaseClient!.query(
      `GRANT DELETE ON TABLE public.task_work_orders TO ${quotedIdentifier(runtimeRole)}`
    );
    try {
      const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
      expect(result).toMatchObject({
        required: true,
        ready: false,
        status: 'database_authority_violation',
      });
    } finally {
      await ownerDatabaseClient!.query(
        `REVOKE DELETE ON TABLE public.task_work_orders FROM ${quotedIdentifier(runtimeRole)}`
      );
    }
    await expectRuntimeReady();
  });

  it('fails closed when the common sealed-function owner loses either exact digest dependency', async () => {
    for (const signature of securityDefinerDependencies) {
      await ownerDatabaseClient!.query(
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${quotedIdentifier(ownerRole)}`
      );
      try {
        const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
        expect(result).toMatchObject({
          required: true,
          ready: false,
          status: 'database_authority_violation',
        });
      } finally {
        await ownerDatabaseClient!.query(
          `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(ownerRole)}`
        );
      }
      await expectRuntimeReady();
    }
  });

  it('fails closed when API receives either forbidden direct digest capability', async () => {
    for (const signature of securityDefinerDependencies) {
      await ownerDatabaseClient!.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(runtimeRole)}`
      );
      try {
        const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
        expect(result).toMatchObject({
          required: true,
          ready: false,
          status: 'database_authority_violation',
        });
      } finally {
        await ownerDatabaseClient!.query(
          `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${quotedIdentifier(runtimeRole)}`
        );
      }
      await expectRuntimeReady();
    }
  });

  it('fails closed when one required sealed-wrapper grant is absent', async () => {
    const signature = 'public.hxos_read_universal_v1_work_order_runtime_authority_v1()';
    await ownerDatabaseClient!.query(
      `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${quotedIdentifier(runtimeRole)}`
    );
    try {
      const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
      expect(result).toMatchObject({
        required: true,
        ready: false,
        status: 'database_authority_violation',
      });
    } finally {
      await ownerDatabaseClient!.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedIdentifier(runtimeRole)}`
      );
    }
    await expectRuntimeReady();
  });

  it('fails closed when runtime is made a member of an elevated role', async () => {
    await adminClient!.query(
      `GRANT ${quotedIdentifier(elevatedRole)} TO ${quotedIdentifier(runtimeRole)}`
    );
    try {
      const result = await readNonproductionFinancialBootstrapReadiness(readinessOptions());
      expect(result).toMatchObject({
        required: true,
        ready: false,
        status: 'database_authority_violation',
      });
    } finally {
      await adminClient!.query(
        `REVOKE ${quotedIdentifier(elevatedRole)} FROM ${quotedIdentifier(runtimeRole)}`
      );
    }
    await expectRuntimeReady();
  });
});
