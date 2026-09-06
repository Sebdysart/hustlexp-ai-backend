import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL } from '../../src/jobs/runtime-database-authority.js';
import { type WorkOrderCommandRoleNames } from '../../src/jobs/work-order-command-role-authority.js';
import { readNonproductionFinancialBootstrapReadiness } from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';
import { createUniversalV1DisposableDatabase } from '../helpers/universal-v1-disposable-database.js';
import {
  provisionUniversalV1SyntheticRoles,
  provisionFinancialReadinessCustody,
} from '../helpers/universal-v1-synthetic-role-provisioning.js';
import { createLocalFinancialReadinessAuthority } from '../helpers/universal-v1-local-financial-readiness-fixture.js';
const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
describePg('v13 actual financial bootstrap readiness', () => {
  let authority: Awaited<ReturnType<typeof createLocalFinancialReadinessAuthority>>;
  let fixture: Awaited<ReturnType<typeof createUniversalV1DisposableDatabase>>;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const roles: WorkOrderCommandRoleNames = {
    migrationRole: `hx_ci_${suffix}_migration`,
    apiRole: `hx_ci_${suffix}_api`,
    workerRole: `hx_ci_${suffix}_worker`,
    attesterRole: `hx_ci_${suffix}_attester`,
    commandOwnerRole: `hx_ci_${suffix}_command`,
    assertionOwnerRole: `hx_ci_${suffix}_assertion`,
    financeOwnerRole: `hx_ci_${suffix}_finance`,
    telemetryOwnerRole: `hx_ci_${suffix}_telemetry`,
  };
  const environment = {
    HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: roles.migrationRole,
    HX_WORK_ORDER_API_DATABASE_ROLE: roles.apiRole,
    HX_WORK_ORDER_WORKER_DATABASE_ROLE: roles.workerRole,
    HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: roles.attesterRole,
    HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: roles.commandOwnerRole,
    HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: roles.assertionOwnerRole,
    HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: roles.financeOwnerRole,
    HX_TELEMETRY_OWNER_DATABASE_ROLE: roles.telemetryOwnerRole,
  };
  const loginKeys = ['migrationRole', 'apiRole', 'workerRole', 'attesterRole'] as const;
  const clients = new Map<(typeof loginKeys)[number], pg.Client>();
  const created: string[] = [];
  const password = `synthetic-${randomUUID()}`;
  const quote = (name: string): string => {
    if (!/^hx_ci_[a-f0-9]{20}_[a-z]+$/u.test(name)) throw new Error('UNSAFE_SYNTHETIC_ROLE');
    return `"${name}"`;
  };
  let root: pg.Client;
  beforeAll(async () => {
    authority = await createLocalFinancialReadinessAuthority();
    const source = new URL(process.env.DATABASE_URL ?? '');
    if (
      source.hostname !== '127.0.0.1' ||
      source.port !== '5432' ||
      source.username !== 'hx_ci_runner' ||
      !/^\/hx_ci_(?:admin|invariant|system)_test$/u.test(source.pathname) ||
      source.search ||
      source.hash
    )
      throw new Error('EXACT_SYNTHETIC_ADMIN_REQUIRED');
    source.pathname = '/hx_ci_admin_test';
    root = new pg.Client({ connectionString: source.toString() });
    await root.connect();
    for (const [key, name] of Object.entries(roles)) {
      const login = (loginKeys as readonly string[]).includes(key);
      await root.query(`CREATE ROLE ${quote(name)} ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      created.push(name);
    }
    fixture = await createUniversalV1DisposableDatabase({
      throughFinancialMigration:
        '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      bootstrapOwnerRole: roles.commandOwnerRole,
      canonicalMigrationLedger: true,
    });
    const admin = await fixture.pool.connect();
    try {
      await admin.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
        authority_version,target_database_name,environment,release_manifest_sha256,activation_request_sha256
      ) VALUES (1,current_database(),'local',$1,$2)`,
        [authority.release.digest, 'c'.repeat(64)]
      );
      await admin.query(
        `INSERT INTO public.hxos_nonproduction_bootstrap_completion_v1(
        release_manifest_digest,migration_artifact_digest,release_id,release_environment,
        required_migration_count,financial_migration_status,completed_at
      ) VALUES ($1,$2,$4,'local',$3,'applied','2026-09-04T00:00:00Z')`,
        [
          authority.release.digest,
          authority.manifest.components.migration.artifactDigest,
          REQUIRED_MIGRATION_FILES.length,
          authority.manifest.releaseId,
        ]
      );
      await provisionUniversalV1SyntheticRoles(
        admin,
        new URL(fixture.databaseUrl).pathname.slice(1),
        roles
      );
      await provisionFinancialReadinessCustody(admin, roles);
      for (const key of loginKeys) {
        const url = new URL(fixture.databaseUrl);
        url.username = roles[key];
        url.password = password;
        const client = new pg.Client({ connectionString: url.toString() });
        await client.connect();
        clients.set(key, client);
      }
    } finally {
      admin.release();
    }
  }, 120_000);
  afterAll(async () => {
    for (const client of clients.values()) await client.end();
    try {
      if (fixture) await fixture.close();
    } finally {
      if (root) {
        try {
          for (const name of created) await root.query('DROP ROLE ' + quote(name));
        } finally {
          await root.end();
        }
      }
    }
  }, 30_000);

  async function readAs(component: 'backend' | 'worker', key: 'apiRole' | 'workerRole') {
    const client = clients.get(key)!;
    const query: QueryFn = async (sql, values) => {
      const result = await client.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
    const violations: string[] = [];
    const identities: { identity_name: string; identity_sha256: string }[] = [];
    const sqlErrors: { code: string; message: string; operation: string }[] = [];
    const database = {
      readOnlyAttestationTransaction: async <T>(fn: (bound: QueryFn) => Promise<T>): Promise<T> => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          await client.query('SET LOCAL search_path=pg_catalog');
          await client.query("SET LOCAL statement_timeout='1000ms'");
          await client.query("SET LOCAL lock_timeout='250ms'");
          await client.query(RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL);
          const value = await fn(async <Row>(sql: string, values?: unknown[]) => {
            let result;
            try {
              result = await query<Row>(sql, values);
            } catch (error) {
              const failure = error as { code?: string; message?: string };
              sqlErrors.push({
                code: failure.code ?? 'UNKNOWN',
                message: failure.message ?? 'UNKNOWN',
                operation: sql.includes('financial_readiness_custody_v13')
                  ? 'retained_custody_policy'
                  : sql.includes('identity_documents')
                    ? 'critical_schema_identity'
                    : 'metadata_read',
              });
              throw error;
            }
            if (
              sql.includes('financial_readiness_custody_v13') ||
              sql.includes('foreign_key_trigger_state')
            )
              violations.push(
                ...result.rows.map((row) => (row as { violation_code: string }).violation_code)
              );
            if (sql.includes('identity_documents'))
              identities.push(
                ...(result.rows as { identity_name: string; identity_sha256: string }[])
              );
            return result;
          });
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    };
    const report = await readNonproductionFinancialBootstrapReadiness({
      component,
      environment: 'local',
      env: {
        ...environment,
        HX_ENVIRONMENT: 'local',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HX_RUNTIME_DATABASE_NAME: new URL(fixture.databaseUrl).pathname.slice(1),
      },
      release: authority.release,
      identity: authority.identity,
      database,
    });

    return { report, violations, sqlErrors, identities };
  }
  const observed = new Map<string, unknown>();
  for (const [component, key] of [
    ['backend', 'apiRole'],
    ['worker', 'workerRole'],
  ] as const) {
    it(
      'reports actual ' +
        component +
        ' readiness with current restricted roles and an exact local release',
      async () => {
        const result = await readAs(component, key);
        expect(result).toMatchObject({
          report: { ready: true, status: 'ready' },
          violations: [],
          sqlErrors: [],
        });
        expect(result.identities).toHaveLength(9);
        observed.set(component, result.identities);
        if (component === 'worker') expect(result.identities).toEqual(observed.get('backend'));
      },
      30_000
    );
  }

  const q = (key: keyof WorkOrderCommandRoleNames) => quote(roles[key]);
  const digest = 'public.digest(text,text)';
  const cases: { name: string; change: () => string; restore: () => string }[] = [
    {
      name: 'retained helper moved outside configured custody',
      change: () =>
        'ALTER FUNCTION public.legacy_fake_expiry_compensation_operation_id_v9(uuid) OWNER TO hx_ci_runner',
      restore: () =>
        'ALTER FUNCTION public.legacy_fake_expiry_compensation_operation_id_v9(uuid) OWNER TO ' +
        q('migrationRole'),
    },
    {
      name: 'retained helper missing from its required identity',
      change: () =>
        'ALTER FUNCTION public.legacy_fake_expiry_compensation_operation_id_v9(uuid) RENAME TO hx_ci_missing_retained_helper; ' +
        'ALTER FUNCTION public.hx_ci_missing_retained_helper(uuid) OWNER TO hx_ci_runner',
      restore: () =>
        'ALTER FUNCTION public.hx_ci_missing_retained_helper(uuid) RENAME TO legacy_fake_expiry_compensation_operation_id_v9; ' +
        'ALTER FUNCTION public.legacy_fake_expiry_compensation_operation_id_v9(uuid) OWNER TO ' +
        q('migrationRole'),
    },
    {
      name: 'residual column SELECT',
      change: () => 'GRANT SELECT(id) ON public.escrows TO ' + q('apiRole'),
      restore: () => 'REVOKE SELECT(id) ON public.escrows FROM ' + q('apiRole'),
    },
    {
      name: 'retained function EXECUTE by attester',
      change: () =>
        'GRANT EXECUTE ON FUNCTION public.hxos_prepare_legacy_expiry_compensation_v10(uuid,text) TO ' +
        q('attesterRole'),
      restore: () =>
        'REVOKE EXECUTE ON FUNCTION public.hxos_prepare_legacy_expiry_compensation_v10(uuid,text) FROM ' +
        q('attesterRole'),
    },
    {
      name: 'digest ownership drift',
      change: () => 'ALTER FUNCTION ' + digest + ' OWNER TO ' + q('migrationRole'),
      restore: () => 'ALTER FUNCTION ' + digest + ' OWNER TO ' + q('financeOwnerRole'),
    },
    {
      name: 'missing finance digest EXECUTE',
      change: () => 'REVOKE EXECUTE ON FUNCTION ' + digest + ' FROM ' + q('financeOwnerRole'),
      restore: () => 'GRANT EXECUTE ON FUNCTION ' + digest + ' TO ' + q('financeOwnerRole'),
    },
    {
      name: 'digest detached from pgcrypto',
      change: () => 'ALTER EXTENSION pgcrypto DROP FUNCTION ' + digest,
      restore: () => 'ALTER EXTENSION pgcrypto ADD FUNCTION ' + digest,
    },
    {
      name: 'database CREATE',
      change: () =>
        'GRANT CREATE ON DATABASE "' +
        new URL(fixture.databaseUrl).pathname.slice(1) +
        '" TO ' +
        q('apiRole'),
      restore: () =>
        'REVOKE CREATE ON DATABASE "' +
        new URL(fixture.databaseUrl).pathname.slice(1) +
        '" FROM ' +
        q('apiRole'),
    },
    {
      name: 'database TEMP',
      change: () =>
        'GRANT TEMPORARY ON DATABASE "' +
        new URL(fixture.databaseUrl).pathname.slice(1) +
        '" TO ' +
        q('workerRole'),
      restore: () =>
        'REVOKE TEMPORARY ON DATABASE "' +
        new URL(fixture.databaseUrl).pathname.slice(1) +
        '" FROM ' +
        q('workerRole'),
    },
    {
      name: 'public schema USAGE grant option',
      change: () => 'GRANT USAGE ON SCHEMA public TO ' + q('apiRole') + ' WITH GRANT OPTION',
      restore: () => 'REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM ' + q('apiRole'),
    },
    {
      name: 'private schema USAGE',
      change: () => 'GRANT USAGE ON SCHEMA hx_authority TO ' + q('apiRole'),
      restore: () => 'REVOKE USAGE ON SCHEMA hx_authority FROM ' + q('apiRole'),
    },
    {
      name: 'residual custodian default function grant',
      change: () =>
        'ALTER DEFAULT PRIVILEGES FOR ROLE ' +
        q('migrationRole') +
        ' GRANT EXECUTE ON FUNCTIONS TO ' +
        q('apiRole'),
      restore: () =>
        'ALTER DEFAULT PRIVILEGES FOR ROLE ' +
        q('migrationRole') +
        ' REVOKE EXECUTE ON FUNCTIONS FROM ' +
        q('apiRole'),
    },
    {
      name: 'residual relation owner drift',
      change: () => 'ALTER TABLE public.escrows OWNER TO ' + q('financeOwnerRole'),
      restore: () => 'ALTER TABLE public.escrows OWNER TO ' + q('migrationRole'),
    },
  ];
  for (const test of cases)
    it(
      'fails closed on ' + test.name,
      async () => {
        await fixture.pool.query(test.change());
        try {
          const result = await readAs('backend', 'apiRole');
          expect(result.sqlErrors).toEqual([]);
          if (test.name.startsWith('retained helper'))
            expect(result.violations).toContain('RETAINED_FUNCTION_MISSING_OR_CUSTODY_DRIFT');
          expect(result.report).toMatchObject({
            ready: false,
            status: 'database_authority_violation',
          });
        } finally {
          await fixture.pool.query(test.restore());
        }
        expect((await readAs('backend', 'apiRole')).report).toMatchObject({
          ready: true,
          status: 'ready',
        });
      },
      30_000
    );

  it.each([
    'missing target FK',
    'disabled private FK trigger',
    'changed origin timestamp default',
  ] as const)(
    'fails closed on compensation origin %s',
    async (mode) => {
      const table = 'hx_authority.fake_financial_change_order_compensation_origins_v13';
      const constraint = (
        await fixture.pool.query(
          `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=$1::regclass AND confrelid='hx_authority.universal_v1_work_order_target_authority_facts'::regclass AND contype='f'`,
          [table]
        )
      ).rows[0];
      expect(constraint).toBeDefined();
      if (!/^[a-z_]+$/u.test(constraint.conname)) throw Error('INVALID_CONSTRAINT_NAME');
      const trigger = (
        await fixture.pool.query(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint
        WHERE c.conrelid=$1::regclass AND c.conname=$2 AND t.tgrelid=c.conrelid AND t.tgisinternal ORDER BY tgname LIMIT 1`,
          [table, constraint.conname]
        )
      ).rows[0];
      if (!/^RI_ConstraintTrigger_c_[0-9]+$/u.test(trigger.tgname))
        throw Error('INVALID_PRIVATE_FK_TRIGGER');
      const change =
        mode === 'missing target FK'
          ? 'ALTER TABLE ' + table + ' DROP CONSTRAINT "' + constraint.conname + '"'
          : mode === 'disabled private FK trigger'
            ? 'ALTER TABLE ' + table + ' DISABLE TRIGGER "' + trigger.tgname + '"'
            : 'ALTER TABLE ' +
              table +
              ' ALTER COLUMN recorded_at SET DEFAULT transaction_timestamp()';
      const restore =
        mode === 'missing target FK'
          ? 'ALTER TABLE ' +
            table +
            ' ADD CONSTRAINT "' +
            constraint.conname +
            '" ' +
            constraint.definition
          : mode === 'disabled private FK trigger'
            ? 'ALTER TABLE ' + table + ' ENABLE TRIGGER "' + trigger.tgname + '"'
            : 'ALTER TABLE ' + table + ' ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()';
      await fixture.pool.query(change);
      try {
        const result = await readAs('worker', 'workerRole');
        expect(result.sqlErrors).toEqual([]);
        expect(result.report).toMatchObject({ ready: false });
        if (mode === 'disabled private FK trigger')
          expect(result.violations).toContain('FOREIGN_KEY_TRIGGER_ENFORCEMENT_INVALID');
      } finally {
        await fixture.pool.query(restore);
      }
      expect((await readAs('worker', 'workerRole')).report).toMatchObject({
        ready: true,
        status: 'ready',
      });
    },
    30_000
  );

  it.each([
    'missing target FK',
    'disabled private FK trigger',
    'changed origin timestamp default',
  ] as const)(
    'fails closed on reversal preparation provenance %s',
    async (mode) => {
      const table = 'hx_authority.fake_financial_change_order_reversal_preparations_v13';
      const constraint = (
        await fixture.pool.query(
          `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=$1::regclass AND confrelid='hx_authority.universal_v1_work_order_target_authority_facts'::regclass AND contype='f'`,
          [table]
        )
      ).rows[0];
      expect(constraint).toBeDefined();
      if (!/^[a-z_]+$/u.test(constraint.conname)) throw Error('INVALID_CONSTRAINT_NAME');
      const trigger = (
        await fixture.pool.query(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint
        WHERE c.conrelid=$1::regclass AND c.conname=$2 AND t.tgrelid=c.conrelid AND t.tgisinternal ORDER BY tgname LIMIT 1`,
          [table, constraint.conname]
        )
      ).rows[0];
      if (!/^RI_ConstraintTrigger_c_[0-9]+$/u.test(trigger.tgname))
        throw Error('INVALID_PRIVATE_FK_TRIGGER');
      const change =
        mode === 'missing target FK'
          ? 'ALTER TABLE ' + table + ' DROP CONSTRAINT "' + constraint.conname + '"'
          : mode === 'disabled private FK trigger'
            ? 'ALTER TABLE ' + table + ' DISABLE TRIGGER "' + trigger.tgname + '"'
            : 'ALTER TABLE ' +
              table +
              ' ALTER COLUMN recorded_at SET DEFAULT transaction_timestamp()';
      const restore =
        mode === 'missing target FK'
          ? 'ALTER TABLE ' +
            table +
            ' ADD CONSTRAINT "' +
            constraint.conname +
            '" ' +
            constraint.definition
          : mode === 'disabled private FK trigger'
            ? 'ALTER TABLE ' + table + ' ENABLE TRIGGER "' + trigger.tgname + '"'
            : 'ALTER TABLE ' + table + ' ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()';
      await fixture.pool.query(change);
      try {
        const result = await readAs('worker', 'workerRole');
        expect(result.sqlErrors).toEqual([]);
        expect(result.report).toMatchObject({ ready: false });
        if (mode === 'disabled private FK trigger')
          expect(result.violations).toContain('FOREIGN_KEY_TRIGGER_ENFORCEMENT_INVALID');
      } finally {
        await fixture.pool.query(restore);
      }
      expect((await readAs('worker', 'workerRole')).report).toMatchObject({
        ready: true,
        status: 'ready',
      });
    },
    30_000
  );

  it('fails closed on a disabled incoming FK constraint trigger', async () => {
    // Isolated probe relation is outside the protected-relation list and references escrows.
    await fixture.pool.query(
      'CREATE TABLE public.hx_ci_incoming_fk_probe(id uuid REFERENCES public.escrows(id))'
    );
    try {
      const trigger = (
        await fixture.pool.query(`SELECT tgname FROM pg_catalog.pg_trigger
        WHERE tgrelid='public.hx_ci_incoming_fk_probe'::regclass AND tgisinternal ORDER BY tgname LIMIT 1`)
      ).rows[0];
      if (!trigger || !/^RI_ConstraintTrigger_c_[0-9]+$/u.test(trigger.tgname))
        throw Error('EXPECTED_INTERNAL_FK_TRIGGER');
      await fixture.pool.query(
        'ALTER TABLE public.hx_ci_incoming_fk_probe DISABLE TRIGGER "' + trigger.tgname + '"'
      );
      const result = await readAs('backend', 'apiRole');
      expect(result.sqlErrors).toEqual([]);
      expect(result.report).toMatchObject({ ready: false, status: 'database_authority_violation' });
    } finally {
      await fixture.pool.query('DROP TABLE public.hx_ci_incoming_fk_probe');
    }
    expect((await readAs('backend', 'apiRole')).report).toMatchObject({
      ready: true,
      status: 'ready',
    });
  }, 30_000);
});
