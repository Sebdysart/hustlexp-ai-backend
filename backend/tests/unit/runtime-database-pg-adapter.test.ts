import { describe, expect, it, vi } from 'vitest';

const fakePg = vi.hoisted(() => {
  const statements: Array<string | { text: string; values: unknown[]; queryMode: string }> = [];
  const releaseCalls: boolean[] = [];
  let forceRemoveCalls = 0;
  let pulseQueueCalls = 0;
  let ordinaryReleaseThrows = true;
  let identityRowCount = 1;
  const readyListeners = new Set<(message: { status: string }) => void>();
  const connection = {
    on(_event: 'readyForQuery', listener: (message: { status: string }) => void) {
      readyListeners.add(listener);
    },
    removeListener(_event: 'readyForQuery', listener: (message: { status: string }) => void) {
      readyListeners.delete(listener);
    },
  };
  const identity = {
    database_name: 'hustlexp_nonprod',
    current_user: 'hx_api_candidate',
    session_user: 'hx_api_candidate',
    server_address: '10.42.0.8',
    server_port: 5432,
    search_path: 'pg_catalog',
    client_encoding: 'UTF8',
    application_name: 'hustlexp-runtime-database-authority',
    tls_active: false,
    attested_at: '2026-09-01T12:30:00.000Z',
  };
  const client = {
    connection,
    async query(statement: string | { text: string; values: unknown[]; queryMode: string }) {
      statements.push(statement);
      const sql = typeof statement === 'string' ? statement : statement.text;
      for (const listener of readyListeners) listener({ status: 'I' });
      const rows = sql.includes('CURRENT_USER')
        ? [identity]
        : [{ database_name: identity.database_name }];
      return {
        rows,
        rowCount: sql.includes('CURRENT_USER') ? identityRowCount : rows.length,
      };
    },
    release(destroy = false) {
      releaseCalls.push(destroy);
      if (!destroy && ordinaryReleaseThrows) {
        ordinaryReleaseThrows = false;
        throw new Error('synthetic ordinary release failure');
      }
    },
  };
  let poolConfig: {
    verify?: (client: typeof fakePgClient, done: (error?: Error) => void) => void;
    ssl?: unknown;
  } | null = null;
  const fakePgClient = client;

  class Pool {
    constructor(config: typeof poolConfig) {
      poolConfig = config;
    }

    on() {
      return this;
    }

    async connect() {
      await new Promise<void>((resolve, reject) => {
        poolConfig?.verify?.(client, (error) => (error ? reject(error) : resolve()));
      });
      return client;
    }

    async end() {}

    _remove(_client: typeof client, callback?: () => void) {
      forceRemoveCalls += 1;
      callback?.();
    }

    _pulseQueue() {
      pulseQueueCalls += 1;
    }
  }

  class Client {
    _handleAuthSASL() {}
  }

  return {
    Pool,
    Client,
    releaseCalls,
    statements,
    get forceRemoveCalls() {
      return forceRemoveCalls;
    },
    get pulseQueueCalls() {
      return pulseQueueCalls;
    },
    get poolConfig() {
      return poolConfig;
    },
    setIdentityRowCount(value: number) {
      identityRowCount = value;
    },
    reset() {
      statements.length = 0;
      releaseCalls.length = 0;
      ordinaryReleaseThrows = true;
      identityRowCount = 1;
      forceRemoveCalls = 0;
      pulseQueueCalls = 0;
      readyListeners.clear();
      poolConfig = null;
    },
  };
});

vi.mock('pg', () => ({ default: { Pool: fakePg.Pool, Client: fakePg.Client } }));

import {
  runtimeDatabaseConnectionBindingDigest,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseTargetBinding,
} from '../../src/jobs/runtime-database-authority.js';
import {
  createPgRuntimeDatabaseAuthorityAdapter,
  runtimeDatabasePgAmbientTlsTrustUnsafe,
} from '../../src/jobs/runtime-database-pg-adapter.js';

const primaryDatabaseUrl =
  'postgresql://hx_api_candidate:redacted@postgres.internal:5432/' +
  'hustlexp_nonprod?sslmode=disable';
const target: RuntimeDatabaseTargetBinding = {
  component: 'api',
  environment: 'local',
  serviceLogin: 'hx_api_candidate',
  roleTopologyDigest: runtimeDatabaseRoleTopologyDigest({
    migrationRole: 'hx_migration_candidate',
    apiRole: 'hx_api_candidate',
    workerRole: 'hx_worker_candidate',
    attesterRole: 'hx_attester_candidate',
    commandOwnerRole: 'hx_command_owner_candidate',
    assertionOwnerRole: 'hx_assertion_owner_candidate',
    financeOwnerRole: 'hx_finance_owner_candidate',
    telemetryOwnerRole: 'hx_telemetry_owner_candidate',
  }),
  databaseName: 'hustlexp_nonprod',
  hostname: 'postgres.internal',
  port: 5432,
  serverAddress: '10.42.0.8',
  tlsMode: 'disable',
  channelBinding: 'disabled',
};

describe('pg runtime database adapter cleanup', () => {
  it('forces the extended protocol for application SQL with or without parameters', async () => {
    fakePg.reset();
    const adapter = createPgRuntimeDatabaseAuthorityAdapter({ primaryDatabaseUrl, target });
    const session = await adapter.connect(
      primaryDatabaseUrl, target, runtimeDatabaseConnectionBindingDigest(primaryDatabaseUrl)
    );
    try {
      if (!session.applicationQuery) throw new Error('APPLICATION_QUERY_REQUIRED');
      await session.applicationQuery('SELECT 1');
      const values = [7];
      await session.applicationQuery('SELECT $1::integer', values);
      values[0] = 9;
      expect(fakePg.statements.slice(-2)).toEqual([
        { text: 'SELECT 1', values: [], queryMode: 'extended' },
        { text: 'SELECT $1::integer', values: [7], queryMode: 'extended' },
      ]);
    } finally {
      await session.destroy();
      await adapter.close();
    }
  });

  it('detects ambient CA mutation from environment and direct Node process arguments', () => {
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({}, [])).toBe(false);
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, [])).toBe(
      true
    );
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({ NODE_EXTRA_CA_CERTS: 'ambient.pem' }, [])).toBe(
      true
    );
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({ NODE_OPTIONS: '"--use-openssl-ca"' }, [])).toBe(
      true
    );
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({}, ['--use-system-ca'])).toBe(true);
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({}, ['--use-openssl-ca=true'])).toBe(true);
    expect(runtimeDatabasePgAmbientTlsTrustUnsafe({}, ['--use-openssl-cactus'])).toBe(false);
  });

  it('holds nonlocal plaintext targets and ambient TLS trust overrides', async () => {
    expect(() =>
      runtimeDatabaseTargetDigest({
        ...target,
        environment: 'staging',
      })
    ).toThrow('EXPECTED_TARGET_INVALID');

    const secureTarget: RuntimeDatabaseTargetBinding = {
      ...target,
      environment: 'staging',
      tlsMode: 'verify-full',
      channelBinding: 'require',
    };
    const secureUrl =
      'postgresql://hx_api_candidate:redacted@postgres.internal:5432/' +
      'hustlexp_nonprod?sslmode=verify-full&channel_binding=require';
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      expect(() =>
        createPgRuntimeDatabaseAuthorityAdapter({
          primaryDatabaseUrl: secureUrl,
          target: secureTarget,
        })
      ).toThrow('RUNTIME_DATABASE_PG_AMBIENT_TLS_TRUST_FORBIDDEN');
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
    }

    const secureAdapter = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: secureUrl,
      target: secureTarget,
    });
    expect(fakePg.poolConfig?.ssl).toEqual({
      rejectUnauthorized: true,
      servername: 'postgres.internal',
      minVersion: 'TLSv1.2',
    });
    await secureAdapter.close();
  });

  it('keeps destroy callable after ordinary release throws', async () => {
    fakePg.reset();
    const adapter = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl,
      target,
      poolConfig: { max: 1 },
    });
    const session = await adapter.connect(
      primaryDatabaseUrl,
      target,
      runtimeDatabaseConnectionBindingDigest(primaryDatabaseUrl)
    );

    await expect(session.release()).rejects.toThrow('synthetic ordinary release failure');
    await expect(session.destroy()).resolves.toBeUndefined();
    expect(fakePg.releaseCalls).toEqual([false]);
    expect(fakePg.forceRemoveCalls).toBe(1);
    expect(fakePg.pulseQueueCalls).toBe(1);
    await adapter.close();
  });

  it('rejects a physical identity result whose rowCount contradicts its rows', async () => {
    fakePg.reset();
    fakePg.setIdentityRowCount(0);
    const adapter = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl,
      target,
      poolConfig: { max: 1 },
    });
    await expect(
      adapter.connect(
        primaryDatabaseUrl,
        target,
        runtimeDatabaseConnectionBindingDigest(primaryDatabaseUrl)
      )
    ).rejects.toThrow('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
    await adapter.close();
  });
});
