import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  runtimeDatabaseConnectionBindingDigest,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseAuthoritySession,
  type RuntimeDatabaseRoleTopology,
  type RuntimeDatabaseTargetBinding,
} from '../../src/jobs/runtime-database-authority.js';
import {
  createPgRuntimeDatabaseAuthorityAdapter,
  type PgRuntimeDatabaseAuthorityAdapter,
  type PgRuntimeDatabasePoolTuning,
} from '../../src/jobs/runtime-database-pg-adapter.js';

const rawConfiguredUrl = process.env.DATABASE_URL;
if (!rawConfiguredUrl) {
  throw new Error('DATABASE_URL_REQUIRED_FOR_RUNTIME_DATABASE_PG_ADAPTER_CERTIFICATION');
}
// This suite certifies the disposable plaintext target using an explicit TLS mode.
const configuredTargetUrl = new URL(rawConfiguredUrl);
configuredTargetUrl.searchParams.set('sslmode', 'disable');
const configuredUrl = configuredTargetUrl.toString();

const parsed = new URL(configuredUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
const serviceLogin = decodeURIComponent(parsed.username);
const port = parsed.port ? Number(parsed.port) : 5432;
const roles: RuntimeDatabaseRoleTopology = {
  migrationRole: 'hx_cert_migration',
  apiRole: serviceLogin,
  workerRole: 'hx_cert_worker',
  attesterRole: 'hx_cert_attester',
  commandOwnerRole: 'hx_cert_command_owner',
  assertionOwnerRole: 'hx_cert_assertion_owner',
  financeOwnerRole: 'hx_cert_finance_owner',
  telemetryOwnerRole: 'hx_cert_telemetry_owner',
};

function rejectAfter(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), milliseconds);
  });
}

function restoreEnvironment(saved: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds: number,
  timeoutMessage: string
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
let target: RuntimeDatabaseTargetBinding;
let targetDigest: string;
let adapter: PgRuntimeDatabaseAuthorityAdapter | null = null;

beforeAll(async () => {
  const client = new pg.Client({ connectionString: configuredUrl });
  await client.connect();
  try {
    const result = await client.query<{ server_address: string; server_port: number }>(
      `SELECT COALESCE(pg_catalog.host(pg_catalog.inet_server_addr()), 'local_socket')
                AS server_address,
              COALESCE(pg_catalog.inet_server_port(), 0)::integer AS server_port`
    );
    if (result.rows.length !== 1) throw new Error('SERVER_IDENTITY_ROW_COUNT_INVALID');
    target = {
      component: 'api',
      environment: 'local',
      serviceLogin,
      roleTopologyDigest: runtimeDatabaseRoleTopologyDigest(roles),
      databaseName,
      hostname: parsed.hostname,
      port: result.rows[0]!.server_port,
      serverAddress: result.rows[0]!.server_address,
      tlsMode: 'disable',
      channelBinding: 'disabled',
    };
    targetDigest = runtimeDatabaseTargetDigest(target);
  } finally {
    await client.end();
  }
});

afterAll(async () => {
  await adapter?.close();
});

describe('production pg runtime database authority adapter', () => {
  it('rejects identifier-contained dollar-tag COMMIT before execution and leaves zero durable writes', async () => {
    if (
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      port !== 5432 || serviceLogin !== 'hx_ci_runner' ||
      !['hx_ci_system_test', 'hx_ci_invariant_test'].includes(databaseName)
    ) throw new Error('DISPOSABLE_DATABASE_REQUIRED_FOR_DURABLE_WRITE_REGRESSION');
    const table = `public.hx_dollar_commit_${randomUUID().replaceAll('-', '')}`;
    const observer = new pg.Client({ connectionString: configuredUrl });
    const isolated = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl, target, poolConfig: { max: 1 },
    });
    await observer.connect();
    try {
      await observer.query(`CREATE TABLE ${table} (value integer NOT NULL)`);
      const session = await isolated.connect(
        configuredUrl, target, runtimeDatabaseConnectionBindingDigest(configuredUrl)
      );
      try {
        if (!session.applicationQuery) throw new Error('APPLICATION_QUERY_REQUIRED');
        for (const suffix of ['$tag$', '$$', '\u00e9$tag$']) {
          await session.query('BEGIN');
          await session.applicationQuery(`INSERT INTO ${table} VALUES ($1)`, [1]);
          await expect(session.applicationQuery(
            `SELECT 1 AS marker${suffix}; COMMIT; -- ${suffix}`
          )).rejects.toMatchObject({ code: '42601' });
          expect(session.transactionStatus()).toBe('FAILED_TRANSACTION');
          await session.query('ROLLBACK');
          expect(session.transactionStatus()).toBe('IDLE');
          const result = await observer.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM ${table}`
          );
          expect(result.rows).toEqual([{ count: 0 }]);
        }
        // Parse must also refuse the entire batch before executing its first INSERT.
        await expect(session.applicationQuery(
          `INSERT INTO ${table} VALUES (2); COMMIT; SELECT 1`
        )).rejects.toMatchObject({ code: '42601' });
        expect(session.transactionStatus()).toBe('IDLE');
        expect((await observer.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
        expect((await session.applicationQuery(
          'SELECT $tag$; COMMIT; $tag$::text AS value'
        )).rows).toEqual([{ value: '; COMMIT; ' }]);
      } finally {
        await session.destroy();
      }
    } finally {
      await isolated.close();
      await observer.query(`DROP TABLE IF EXISTS ${table}`);
      await observer.end();
    }
  });

  it('rejects every connection-identity or session-option pool override', () => {
    for (const forbidden of [
      { user: 'other_user' },
      { password: 'other_password' },
      { host: 'other.invalid' },
      { port: 6543 },
      { database: 'other_database' },
      { ssl: { rejectUnauthorized: false } },
      { options: '-c role=other_role' },
      { statement_timeout: 1 },
      { Client: class {} },
    ]) {
      expect(() =>
        createPgRuntimeDatabaseAuthorityAdapter({
          primaryDatabaseUrl: configuredUrl,
          target,
          poolConfig: forbidden as PgRuntimeDatabasePoolTuning,
        })
      ).toThrow('RUNTIME_DATABASE_PG_POOL_TUNING_INVALID');
    }

    const symbolOverride: PgRuntimeDatabasePoolTuning = { max: 1 };
    Object.defineProperty(symbolOverride, Symbol('password'), {
      enumerable: true,
      value: 'other_password',
    });
    expect(() =>
      createPgRuntimeDatabaseAuthorityAdapter({
        primaryDatabaseUrl: configuredUrl,
        target,
        poolConfig: symbolOverride,
      })
    ).toThrow('RUNTIME_DATABASE_PG_POOL_TUNING_INVALID');
  });

  it('neutralizes hostile libpq environment defaults with exact connection settings', async () => {
    const hostileEnvironment = {
      PGHOST: 'hostile.invalid',
      PGPORT: '6543',
      PGDATABASE: 'hostile_database',
      PGUSER: 'hostile_user',
      PGPASSWORD: 'hostile_password',
      PGOPTIONS: '-c search_path=public',
      PGCLIENT_ENCODING: 'LATIN1',
      PGAPPNAME: 'hostile-application',
      PGSSLMODE: 'verify-full',
      PGCONNECT_TIMEOUT: '1',
    } as const;
    const saved = Object.fromEntries(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, hostileEnvironment);

    const isolated = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 1, connectionTimeoutMillis: 10_000 },
    });
    try {
      const session = await isolated.connect(
        configuredUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      );
      const settings = await session.query<{
        database_name: string;
        current_user: string;
        search_path: string;
        client_encoding: string;
        application_name: string;
      }>(`SELECT current_database()::text AS database_name,
                CURRENT_USER::text AS current_user,
                pg_catalog.current_setting('search_path')::text AS search_path,
                pg_catalog.current_setting('client_encoding')::text AS client_encoding,
                pg_catalog.current_setting('application_name')::text AS application_name`);
      expect(settings.rows).toEqual([
        {
          database_name: databaseName,
          current_user: serviceLogin,
          search_path: 'pg_catalog',
          client_encoding: 'UTF8',
          application_name: 'hustlexp-runtime-database-authority',
        },
      ]);
      await session.release();
    } finally {
      restoreEnvironment(saved);
      await isolated.close();
    }
  });

  it('uses ReadyForQuery status bytes for idle, transaction, and failed-transaction state', async () => {
    adapter = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 2 },
    });
    const session = await adapter.connect(
      configuredUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(configuredUrl)
    );
    expect(session.transactionStatus()).toBe('IDLE');
    await session.query('SELECT pg_catalog.pg_sleep(1.1)');
    expect(session.transactionStatus()).toBe('IDLE');

    await session.query('BEGIN');
    expect(session.transactionStatus()).toBe('IN_TRANSACTION');
    await expect(session.query('SELECT 1 / 0 AS impossible')).rejects.toMatchObject({
      code: '22012',
    });
    expect(session.transactionStatus()).toBe('FAILED_TRANSACTION');
    await session.query('ROLLBACK');
    expect(session.transactionStatus()).toBe('IDLE');
    await session.release();
  });

  it('reports one exact primary-only pool-stat shape from the live adapter', async () => {
    const isolated = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 2 },
    });
    try {
      const session = await isolated.connect(
        configuredUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      );
      expect(isolated.stats()).toEqual({
        totalConnections: 1,
        idleConnections: 0,
        waitingRequests: 0,
        maxConnections: 2,
        utilizationPercent: 50,
        replicaConnections: null,
        replicaIdle: null,
        replicaConfigured: false,
      });
      await session.release();
      expect(isolated.stats()).toEqual({
        totalConnections: 1,
        idleConnections: 1,
        waitingRequests: 0,
        maxConnections: 2,
        utilizationPercent: 50,
        replicaConnections: null,
        replicaIdle: null,
        replicaConfigured: false,
      });
      expect(Object.keys(isolated.stats()).sort()).toEqual([
        'idleConnections',
        'maxConnections',
        'replicaConfigured',
        'replicaConnections',
        'replicaIdle',
        'totalConnections',
        'utilizationPercent',
        'waitingRequests',
      ]);
    } finally {
      await isolated.close();
    }
  });

  it('destroys rather than reuses a dirty pooled physical session', async () => {
    if (!adapter) throw new Error('ADAPTER_NOT_INITIALIZED');
    const first = await adapter.connect(
      configuredUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(configuredUrl)
    );
    const firstPid = await first.query<{ backend_pid: number }>(
      'SELECT pg_catalog.pg_backend_pid()::integer AS backend_pid'
    );
    await first.query('BEGIN');
    expect(first.transactionStatus()).toBe('IN_TRANSACTION');
    await first.release();

    const second = await adapter.connect(
      configuredUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(configuredUrl)
    );
    const secondPid = await second.query<{ backend_pid: number }>(
      'SELECT pg_catalog.pg_backend_pid()::integer AS backend_pid'
    );
    expect(second.transactionStatus()).toBe('IDLE');
    expect(secondPid.rows[0]?.backend_pid).not.toBe(firstPid.rows[0]?.backend_pid);
    await second.release();
  });

  it('revalidates physical identity on every checkout and revokes on session drift', async () => {
    const isolated = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 1 },
    });
    const first = await isolated.connect(
      configuredUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(configuredUrl)
    );
    await first.query("SET application_name = 'tampered-runtime-session'");
    await first.release();

    await expect(
      isolated.connect(
        configuredUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
    await expect(
      isolated.connect(
        configuredUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
    await isolated.close();
  });

  it('services a max-one queued checkout after destroying a dirty session', async () => {
    const bounded = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 1 },
    });
    try {
      const first = await bounded.connect(
        configuredUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      );
      await first.query('BEGIN');

      const queuedCheckout = bounded.connect(
        configuredUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      );
      await first.release();

      const second = await Promise.race([
        queuedCheckout,
        rejectAfter(2_000, 'QUEUED_CHECKOUT_DID_NOT_RESUME_AFTER_FORCED_REMOVE'),
      ]);
      expect(second.transactionStatus()).toBe('IDLE');
      await second.release();
    } finally {
      await bounded.close();
    }
  });

  it('allows pool close to finish after an active session is force-destroyed', async () => {
    const closing = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 1 },
    });
    const active = await closing.connect(
      configuredUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(configuredUrl)
    );

    const closePromise = closing.close();
    await active.release();
    await expect(
      Promise.race([
        closePromise,
        rejectAfter(2_000, 'POOL_CLOSE_DID_NOT_RESUME_AFTER_FORCED_REMOVE'),
      ])
    ).resolves.toBeUndefined();
  });

  it('handles an active socket fault without crashing and revokes the adapter epoch', async () => {
    const faulted = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target,
      poolConfig: { max: 1 },
    });
    let active: RuntimeDatabaseAuthoritySession | null = await faulted.connect(
      configuredUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(configuredUrl)
    );
    const control = new pg.Client({ connectionString: configuredUrl });
    await control.connect();
    try {
      const pid = await active.query<{ backend_pid: number }>(
        'SELECT pg_catalog.pg_backend_pid()::integer AS backend_pid'
      );
      const backendPid = pid.rows[0]?.backend_pid;
      if (!backendPid) throw new Error('ACTIVE_BACKEND_PID_REQUIRED');
      const epochBefore = faulted.adapterBindingDigest;
      const terminated = await control.query<{ terminated: boolean }>(
        'SELECT pg_catalog.pg_terminate_backend($1::integer) AS terminated',
        [backendPid]
      );
      expect(terminated.rows).toEqual([{ terminated: true }]);
      await waitFor(
        () => faulted.adapterBindingDigest !== epochBefore,
        2_000,
        'ACTIVE_SOCKET_FAULT_DID_NOT_REVOKE_ADAPTER_EPOCH'
      );
      expect(active.transactionStatus()).toBe('UNKNOWN');
      await expect(active.query('SELECT 1')).rejects.toThrow(
        'RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID'
      );
      await active.destroy();
      active = null;
    } finally {
      await control.end();
      if (active) await active.destroy().catch(() => undefined);
      await faulted.close();
    }
  });

  it('rejects URL, target, and connection-binding drift before checkout', async () => {
    if (!adapter) throw new Error('ADAPTER_NOT_INITIALIZED');
    await expect(
      adapter.connect(
        `${configuredUrl}#drift`,
        target,
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_PRIMARY_URL_MISMATCH');
    await expect(
      adapter.connect(
        configuredUrl,
        { ...target, serverAddress: '203.0.113.9' },
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_TARGET_DIGEST_MISMATCH');
    await expect(
      adapter.connect(configuredUrl, target, `sha256:${'f'.repeat(64)}`)
    ).rejects.toThrow('RUNTIME_DATABASE_PG_CONNECTION_BINDING_MISMATCH');
  });

  it('fails closed and invalidates its epoch when a new physical connection has wrong identity', async () => {
    const mismatched = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configuredUrl,
      target: { ...target, serverAddress: '203.0.113.254' },
      poolConfig: { max: 1 },
    });
    const epochBefore = mismatched.adapterBindingDigest;
    await expect(
      mismatched.connect(
        configuredUrl,
        { ...target, serverAddress: '203.0.113.254' },
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
    expect(mismatched.adapterBindingDigest).not.toBe(epochBefore);
    await expect(
      mismatched.connect(
        configuredUrl,
        { ...target, serverAddress: '203.0.113.254' },
        runtimeDatabaseConnectionBindingDigest(configuredUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
    expect(mismatched.poolBinding).not.toHaveProperty('connect');
    await mismatched.close();
  });
});
