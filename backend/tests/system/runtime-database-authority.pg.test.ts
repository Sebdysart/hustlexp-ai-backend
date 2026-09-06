import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  attestRuntimeDatabaseAuthorityKernelForTest as attestRuntimeDatabaseAuthority,
  RUNTIME_DATABASE_IDENTITY_SQL,
  runtimeDatabaseAuthorityHealth,
  runtimeDatabaseBuildProofDigest,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseAuthorityAdapter,
  type RuntimeDatabaseAuthorityInput,
  type RuntimeDatabaseAuthoritySession,
  type RuntimeDatabaseAuthorityVerifiers,
  type RuntimeDatabaseCanonicalReleaseProof,
  type RuntimeDatabaseReleaseVerificationRequest,
  type RuntimeDatabaseRoleTopology,
  type RuntimeDatabaseTransactionStatus,
} from '../../src/jobs/runtime-database-authority.js';

const sourceUrl = process.env.DATABASE_URL ?? '';
const configuredUrl = sourceUrl
  ? (() => {
      const value = new URL(sourceUrl);
      value.search = '';
      value.hash = '';
      value.searchParams.set('sslmode', 'disable');
      return value.toString();
    })()
  : '';
const parsedUrl = configuredUrl ? new URL(configuredUrl) : null;
const databaseName = parsedUrl ? decodeURIComponent(parsedUrl.pathname.replace(/^\//u, '')) : '';
const apiRole = parsedUrl ? decodeURIComponent(parsedUrl.username) : '';
const hostname = parsedUrl?.hostname.replace(/^\[|\]$/gu, '') ?? '';
const port = parsedUrl?.port ? Number(parsedUrl.port) : 5432;
let exactServerAddress = hostname;
const roleTopology: RuntimeDatabaseRoleTopology = {
  migrationRole: 'hx_pg_runtime_migration',
  apiRole,
  workerRole: 'hx_pg_runtime_worker',
  attesterRole: 'hx_pg_runtime_attester',
  commandOwnerRole: 'hx_pg_runtime_command_owner',
  assertionOwnerRole: 'hx_pg_runtime_assertion_owner',
  financeOwnerRole: 'hx_pg_runtime_finance_owner',
  telemetryOwnerRole: 'hx_pg_runtime_telemetry_owner',
};

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const releasePins = {
  manifestDigest: digest('a'),
  signerKeyId: 'hustlexp-pg-runtime-authority',
  signerKeyFingerprint: digest('b'),
  revision: 'c'.repeat(40),
  artifactDigest: digest('d'),
};

function canonicalReleaseProof(
  request: RuntimeDatabaseReleaseVerificationRequest
): RuntimeDatabaseCanonicalReleaseProof {
  const buildWithoutDigest = {
    releaseManifestDigest: request.pins.manifestDigest,
    environment: request.environment,
    component: request.releaseComponent,
    revision: request.pins.revision,
    artifactDigest: request.pins.artifactDigest,
    databaseTargetDigest: request.databaseTargetDigest,
  };
  return {
    schemaVersion: 1,
    signatureAlgorithm: 'ed25519',
    canonicalManifestDigest: request.pins.manifestDigest,
    manifestDigest: request.pins.manifestDigest,
    signerKeyId: request.pins.signerKeyId,
    signerKeyFingerprint: request.pins.signerKeyFingerprint,
    environment: request.environment,
    component: request.releaseComponent,
    revision: request.pins.revision,
    artifactDigest: request.pins.artifactDigest,
    databaseTargetDigest: request.databaseTargetDigest,
    build: {
      ...buildWithoutDigest,
      identityDigest: runtimeDatabaseBuildProofDigest(buildWithoutDigest),
    },
  };
}

function input(): RuntimeDatabaseAuthorityInput {
  const expectedTarget = {
    environment: 'local' as const,
    databaseName,
    hostname,
    port,
    serverAddress: exactServerAddress,
    tlsMode: 'disable' as const,
    channelBinding: 'disabled' as const,
  };
  return {
    component: 'api',
    primaryDatabaseUrl: configuredUrl,
    replicaDatabaseUrl: null,
    expectedTarget,
    expectedTargetDigest: runtimeDatabaseTargetDigest({
      ...expectedTarget,
      component: 'api',
      serviceLogin: apiRole,
      roleTopologyDigest: runtimeDatabaseRoleTopologyDigest(roleTopology),
    }),
    roleTopology,
    releasePins,
  };
}

class RealPostgresAdapter implements RuntimeDatabaseAuthorityAdapter {
  readonly adapterBinding = {};
  readonly poolBinding = {};
  readonly adapterBindingDigest = digest('1');
  readonly poolBindingDigest = digest('2');
  readonly statements: string[] = [];
  released = false;
  destroyed = false;

  constructor(private readonly startDirty = false) {}

  async connect(
    exactPrimaryDatabaseUrl: string,
    immutableTarget: Parameters<RuntimeDatabaseAuthorityAdapter['connect']>[1],
    connectionBindingDigest: string
  ): Promise<RuntimeDatabaseAuthoritySession> {
    const client = new Client({ connectionString: exactPrimaryDatabaseUrl });
    await client.connect();
    let status: RuntimeDatabaseTransactionStatus = 'IDLE';
    if (this.startDirty) {
      await client.query('BEGIN');
      this.statements.push('BEGIN');
      status = 'IN_TRANSACTION';
    }
    let closed = false;
    const finish = async () => {
      if (closed) return;
      closed = true;
      await client.end();
    };
    const adapter = this;
    return {
      adapterBinding: this.adapterBinding,
      poolBinding: this.poolBinding,
      sessionBinding: {},
      adapterBindingDigest: this.adapterBindingDigest,
      poolBindingDigest: this.poolBindingDigest,
      sessionBindingDigest: digest('3'),
      connectionBindingDigest,
      targetDigest: runtimeDatabaseTargetDigest(immutableTarget),
      transactionStatus: () => status,
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<{ rows: Row[]; rowCount: number }> => {
        adapter.statements.push(sql);
        const result = await client.query<Row>(sql, values ? [...values] : undefined);
        if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
          status = 'IN_TRANSACTION';
        } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          status = 'IDLE';
        }
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
      release: async () => {
        adapter.released = true;
        await finish();
      },
      destroy: async () => {
        adapter.destroyed = true;
        await finish();
      },
    };
  }
}

function verifiers(
  topology: RuntimeDatabaseAuthorityVerifiers['verifyEightRoleTopology'] = async () => ({
    status: 'READY',
  })
): RuntimeDatabaseAuthorityVerifiers {
  return {
    verifyReleaseAuthority: async (request) => canonicalReleaseProof(request),
    verifyEightRoleTopology: topology,
    verifyWorkOrderTargetTip: async () => ({ status: 'READY' }),
  };
}

describe.skipIf(!configuredUrl)('runtime database authority on genuine PostgreSQL', () => {
  beforeAll(async () => {
    const client = new Client({ connectionString: configuredUrl });
    await client.connect();
    try {
      const result = await client.query<{ server_address: string }>(
        `SELECT COALESCE(
           pg_catalog.host(pg_catalog.inet_server_addr()),
           'local_socket'
         ) AS server_address`
      );
      const observed = result.rows[0]?.server_address;
      if (!observed) throw new Error('RUNTIME_DATABASE_TEST_SERVER_ADDRESS_UNAVAILABLE');
      exactServerAddress = observed;
    } finally {
      await client.end();
    }
  });

  it('returns READY only after the real repeatable-read read-only snapshot commits', async () => {
    const adapter = new RealPostgresAdapter();
    const capability = await attestRuntimeDatabaseAuthority(input(), adapter, verifiers());
    expect(runtimeDatabaseAuthorityHealth(capability)).toEqual(
      expect.objectContaining({
        component: 'api',
        environment: 'local',
        manifestDigest: releasePins.manifestDigest,
      })
    );
    expect(adapter.statements).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(adapter.statements).toContain('COMMIT');
    expect(adapter.released).toBe(true);
    expect(adapter.destroyed).toBe(false);
  });

  it('rejects live server-address drift even when the caller recomputes the target digest', async () => {
    const request = input();
    const driftedTarget = {
      ...request.expectedTarget,
      serverAddress: exactServerAddress === '203.0.113.9' ? '203.0.113.10' : '203.0.113.9',
    };
    const adapter = new RealPostgresAdapter();
    await expect(
      attestRuntimeDatabaseAuthority(
        {
          ...request,
          expectedTarget: driftedTarget,
          expectedTargetDigest: runtimeDatabaseTargetDigest({
            ...driftedTarget,
            component: 'api',
            serviceLogin: apiRole,
            roleTopologyDigest: runtimeDatabaseRoleTopologyDigest(roleTopology),
          }),
        },
        adapter,
        verifiers()
      )
    ).rejects.toThrow('LIVE_SERVER_ADDRESS_MISMATCH');
    // An identity mismatch invalidates the connection itself: no further SQL
    // may reach that target, and the physical session must never be reused.
    expect(adapter.statements.at(-1)).toBe(RUNTIME_DATABASE_IDENTITY_SQL);
    expect(adapter.statements).not.toContain('COMMIT');
    expect(adapter.statements).not.toContain('ROLLBACK');
    expect(adapter.released).toBe(false);
    expect(adapter.destroyed).toBe(true);
  });

  it('does not send verifier COMMIT to PostgreSQL or produce a capability', async () => {
    const adapter = new RealPostgresAdapter();
    await expect(
      attestRuntimeDatabaseAuthority(
        input(),
        adapter,
        verifiers(async (context) => {
          await context.query('COMMIT');
          return { status: 'READY' };
        })
      )
    ).rejects.toThrow('VERIFIER_QUERY_PROTOCOL_VIOLATION');
    expect(adapter.statements.filter((statement) => statement === 'COMMIT')).toEqual([]);
    expect(adapter.statements.at(-1)).toBe('ROLLBACK');
    expect(adapter.released).toBe(true);
  });

  it('destroys a genuinely dirty session before authority reads', async () => {
    const adapter = new RealPostgresAdapter(true);
    await expect(attestRuntimeDatabaseAuthority(input(), adapter, verifiers())).rejects.toThrow(
      'DATABASE_SESSION_NOT_FRESH'
    );
    expect(adapter.destroyed).toBe(true);
    expect(adapter.released).toBe(false);
    expect(adapter.statements).toEqual(['BEGIN']);
  });
});
