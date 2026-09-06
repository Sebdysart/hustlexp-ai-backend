import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { QueryFn } from '../../src/database-contracts.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL } from '../../src/jobs/runtime-database-authority.js';
import type { WorkOrderCommandRoleNames } from '../../src/jobs/work-order-command-role-authority.js';
import { createUniversalV1DisposableDatabase } from './universal-v1-disposable-database.js';
import { createLocalFinancialReadinessAuthority } from './universal-v1-local-financial-readiness-fixture.js';
import {
  provisionUniversalV1SyntheticRoles,
  provisionFinancialReadinessCustody,
} from './universal-v1-synthetic-role-provisioning.js';

const loginKeys = ['migrationRole', 'apiRole', 'workerRole', 'attesterRole'] as const;

export function quoteFinancialReadinessRole(name: string): string {
  if (!/^hx_ci_[a-f0-9]{20}_[a-z]+$/u.test(name)) throw new Error('UNSAFE_SYNTHETIC_ROLE');
  return `"${name}"`;
}

/** Real repeatable-read snapshot with the same target lock as the runtime data plane. */
export function financialReadinessSnapshot(client: Pick<pg.Client, 'query'>) {
  return {
    readOnlyAttestationTransaction: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await client.query('SET LOCAL search_path=pg_catalog');
        await client.query("SET LOCAL statement_timeout='1000ms'");
        await client.query("SET LOCAL lock_timeout='250ms'");
        await client.query(RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL);
        const query: QueryFn = async (sql, params) => {
          const result = await client.query(sql, params);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        };
        const value = await fn(query);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
}

/** Complete local v13 authority; never grants a runtime role owner or admin privileges. */
export async function createFinancialReadinessDatabase() {
  const source = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(source.protocol) ||
    source.hostname !== '127.0.0.1' ||
    source.port !== '5432' ||
    source.username !== 'hx_ci_runner' ||
    !/^\/hx_ci_(?:admin|invariant|system)_test$/u.test(source.pathname) ||
    source.search ||
    source.hash
  )
    throw new Error('EXACT_SYNTHETIC_ADMIN_REQUIRED');
  const authority = await createLocalFinancialReadinessAuthority();
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
  source.pathname = '/hx_ci_admin_test';
  const root = new pg.Client({ connectionString: source.toString() });
  const clients = new Map<(typeof loginKeys)[number], pg.Client>();
  const created: string[] = [];
  const password = `synthetic-${randomUUID()}`;
  const pools: pg.Pool[] = [];
  let fixture: Awaited<ReturnType<typeof createUniversalV1DisposableDatabase>> | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const pool of pools) {
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const client of clients.values()) {
      try {
        await client.end();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await fixture?.close();
    } catch (error) {
      errors.push(error);
    }
    for (const name of created) {
      try {
        await root.query('DROP ROLE ' + quoteFinancialReadinessRole(name));
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await root.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'READINESS_FIXTURE_CLEANUP_FAILED');
  };
  await root.connect();
  try {
    for (const [key, name] of Object.entries(roles)) {
      const login = (loginKeys as readonly string[]).includes(key);
      await root.query(`CREATE ROLE ${quoteFinancialReadinessRole(name)}
        ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}
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
    } finally {
      admin.release();
    }
    for (const key of loginKeys) {
      const url = new URL(fixture.databaseUrl);
      url.username = roles[key];
      url.password = password;
      const client = new pg.Client({ connectionString: url.toString() });
      clients.set(key, client);
      await client.connect();
    }
    const databaseUrl = fixture.databaseUrl;
    const poolForRole = (key: (typeof loginKeys)[number], max = 4): pg.Pool => {
      if (!loginKeys.includes(key) || !Number.isInteger(max) || max < 1 || max > 8) {
        throw new Error('BOUNDED_SYNTHETIC_ROLE_POOL_REQUIRED');
      }
      const url = new URL(databaseUrl);
      url.username = roles[key];
      url.password = password;
      const pool = new pg.Pool({ connectionString: url.toString(), max });
      pools.push(pool);
      return pool;
    };
    return { authority, fixture, roles, environment, clients, root, close, poolForRole };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'READINESS_FIXTURE_SETUP_AND_CLEANUP_FAILED');
    }
    throw error;
  }
}

export type FinancialReadinessDatabase = Awaited<
  ReturnType<typeof createFinancialReadinessDatabase>
>;
