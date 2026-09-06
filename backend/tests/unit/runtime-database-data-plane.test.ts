import { describe, expect, it, vi } from 'vitest';

import {
  attestRuntimeDatabaseAuthorityKernelForTest as attestRuntimeDatabaseAuthority,
  RUNTIME_DATABASE_IDENTITY_SQL,
  RUNTIME_DATABASE_TRANSACTION_STATE_SQL,
  RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL,
  runtimeDatabaseBuildProofDigest,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  runtimeDatabaseWorkOrderAuthorityBinding,
  type RuntimeDatabaseAuthorityCapability,
  type RuntimeDatabaseAuthorityInput,
  type RuntimeDatabaseAuthoritySession,
  type RuntimeDatabaseAuthorityVerifiers,
  type RuntimeDatabaseCanonicalReleaseProof,
  type RuntimeDatabaseReleaseVerificationRequest,
  type RuntimeDatabaseRoleTopology,
  type RuntimeDatabaseTargetBinding,
  type RuntimeDatabaseTransactionStatus,
  type RuntimeDatabaseWorkOrderAuthorityBinding,
} from '../../src/jobs/runtime-database-authority.js';
import {
  createRuntimeDatabaseDataPlane,
  RUNTIME_DATABASE_DATA_PLANE_SEARCH_PATH_SQL,
  RUNTIME_DATABASE_DATA_PLANE_TARGET_BARRIER_LOCK_SQL,
  RuntimeDatabaseDataPlaneError,
  type RuntimeDatabaseDataPlane,
  type RuntimeDatabaseDataPlaneAdapter,
  type RuntimeDatabaseDataPlanePoolStats,
  type RuntimeDatabaseDataPlaneQueryResult,
} from '../../src/jobs/runtime-database-data-plane.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const manifestDigest = digest('a');
const artifactDigest = digest('b');
const signerFingerprint = digest('c');
const revision = 'd'.repeat(40);

const roles: RuntimeDatabaseRoleTopology = {
  migrationRole: 'hx_migration_candidate',
  apiRole: 'hx_api_candidate',
  workerRole: 'hx_worker_candidate',
  attesterRole: 'hx_attester_candidate',
  commandOwnerRole: 'hx_work_order_owner_candidate',
  assertionOwnerRole: 'hx_assertion_owner_candidate',
  financeOwnerRole: 'hx_finance_owner_candidate',
  telemetryOwnerRole: 'hx_telemetry_owner_candidate',
};
const roleTopologyDigest = runtimeDatabaseRoleTopologyDigest(roles);
const expectedTarget = {
  environment: 'staging' as const,
  databaseName: 'hustlexp_nonprod',
  hostname: 'postgres.railway.internal',
  port: 5432,
  serverAddress: '10.42.0.8',
  tlsMode: 'verify-full' as const,
  channelBinding: 'require' as const,
};
const target: RuntimeDatabaseTargetBinding = {
  ...expectedTarget,
  component: 'api',
  serviceLogin: roles.apiRole,
  roleTopologyDigest,
};
const targetDigest = runtimeDatabaseTargetDigest(target);
const primaryDatabaseUrl =
  'postgresql://hx_api_candidate:credential-one@postgres.railway.internal:5432/' +
  'hustlexp_nonprod?sslmode=verify-full&channel_binding=require&application_name=hustlexp-api';
const identityRow = {
  database_name: expectedTarget.databaseName,
  current_user: roles.apiRole,
  session_user: roles.apiRole,
  server_address: expectedTarget.serverAddress,
  server_port: expectedTarget.port,
  attested_at: '2026-09-01T12:30:00.000Z',
};

function authorityInput(): RuntimeDatabaseAuthorityInput {
  return {
    component: 'api',
    primaryDatabaseUrl,
    replicaDatabaseUrl: null,
    expectedTarget: { ...expectedTarget },
    expectedTargetDigest: targetDigest,
    roleTopology: { ...roles },
    releasePins: {
      manifestDigest,
      signerKeyId: 'hustlexp-release-2026',
      signerKeyFingerprint: signerFingerprint,
      revision,
      artifactDigest,
    },
  };
}

function releaseProof(
  request: RuntimeDatabaseReleaseVerificationRequest
): RuntimeDatabaseCanonicalReleaseProof {
  const build = {
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
      ...build,
      identityDigest: runtimeDatabaseBuildProofDigest(build),
    },
  };
}

const authorityVerifiers: RuntimeDatabaseAuthorityVerifiers = {
  verifyReleaseAuthority: vi.fn(async (request) => releaseProof(request)),
  verifyEightRoleTopology: vi.fn(async () => ({ status: 'READY' as const })),
  verifyWorkOrderTargetTip: vi.fn(async () => ({ status: 'READY' as const })),
};

interface RuntimeScenario {
  readonly missingApplicationQuery?: boolean;
  readonly initialStatus?: RuntimeDatabaseTransactionStatus;
  readonly beginThrows?: boolean;
  readonly beginStatus?: RuntimeDatabaseTransactionStatus;
  readonly commitThrows?: boolean;
  readonly commitStatus?: RuntimeDatabaseTransactionStatus;
  readonly rollbackThrows?: boolean;
  readonly rollbackStatus?: RuntimeDatabaseTransactionStatus;
  readonly releaseThrows?: boolean;
  readonly destroyThrows?: boolean;
  readonly forgedSessionBinding?: boolean;
  readonly authorityReadThrows?: boolean;
  readonly authorityRowCount?: number;
  readonly authorityDrift?: Readonly<Record<string, unknown>>;
  readonly query?: (
    sql: string,
    values: readonly unknown[] | undefined
  ) => Promise<RuntimeDatabaseDataPlaneQueryResult>;
}

interface RuntimeSessionRecord {
  readonly session: RuntimeDatabaseAuthoritySession;
  readonly applicationStatements: string[];
  readonly events: string[];
  readonly values: Array<readonly unknown[] | undefined>;
}

interface AdapterHarness {
  readonly adapter: RuntimeDatabaseDataPlaneAdapter;
  readonly connections: Array<{
    readonly url: string;
    readonly target: Readonly<RuntimeDatabaseTargetBinding>;
    readonly connectionDigest: string;
  }>;
  readonly sessions: RuntimeSessionRecord[];
  readonly close: ReturnType<typeof vi.fn>;
  setScenario(scenario: RuntimeScenario): void;
  setWorkOrderAuthority(binding: RuntimeDatabaseWorkOrderAuthorityBinding): void;
  stale(): void;
  configureReplica(): void;
  setStats(overrides: Readonly<Record<string, unknown>>): void;
  deferClose(): () => void;
}

function workOrderAuthorityRow(
  binding: RuntimeDatabaseWorkOrderAuthorityBinding,
  drift: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    session_database_role: binding.sessionDatabaseRole,
    target_authority_id: binding.targetAuthorityId,
    authority_version: binding.authorityVersion,
    target_database_name: binding.targetDatabaseName,
    environment: binding.environment,
    release_manifest_sha256: binding.releaseManifestSha256,
    ordinal146_sql_sha256: binding.ordinal146SqlSha256,
    v12_sql_sha256: binding.v12SqlSha256,
    seal_sql_sha256: binding.sealSqlSha256,
    v13_sql_sha256: binding.v13SqlSha256,
    fake_financial_operations_relation: binding.fakeFinancialOperationsRelation,
    fake_financial_operation_events_relation: binding.fakeFinancialOperationEventsRelation,
    ...drift,
  };
}

function makeAuthoritySession(
  adapter: RuntimeDatabaseDataPlaneAdapter,
  connectionDigest: string,
  connectedTarget: Readonly<RuntimeDatabaseTargetBinding>
): RuntimeDatabaseAuthoritySession {
  let status: RuntimeDatabaseTransactionStatus = 'IDLE';
  return {
    adapterBinding: adapter.adapterBinding,
    poolBinding: adapter.poolBinding,
    sessionBinding: {},
    adapterBindingDigest: adapter.adapterBindingDigest,
    poolBindingDigest: adapter.poolBindingDigest,
    sessionBindingDigest: digest('3'),
    connectionBindingDigest: connectionDigest,
    targetDigest: runtimeDatabaseTargetDigest(connectedTarget),
    transactionStatus: () => status,
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
        status = 'IN_TRANSACTION';
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        status = 'IDLE';
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql === RUNTIME_DATABASE_TRANSACTION_STATE_SQL) {
        return {
          rows: [
            {
              transaction_isolation: 'repeatable read',
              transaction_read_only: 'on',
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }
      if (sql === RUNTIME_DATABASE_IDENTITY_SQL) {
        return { rows: [identityRow as unknown as Row], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
    release: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeRuntimeSession(
  adapter: RuntimeDatabaseDataPlaneAdapter,
  connectionDigest: string,
  connectedTarget: Readonly<RuntimeDatabaseTargetBinding>,
  scenario: RuntimeScenario,
  workOrderAuthority: RuntimeDatabaseWorkOrderAuthorityBinding
): RuntimeSessionRecord {
  const events: string[] = [];
  const applicationStatements: string[] = [];
  const values: Array<readonly unknown[] | undefined> = [];
  let status = scenario.initialStatus ?? 'IDLE';
  const session: RuntimeDatabaseAuthoritySession = {
    adapterBinding: scenario.forgedSessionBinding ? {} : adapter.adapterBinding,
    poolBinding: adapter.poolBinding,
    sessionBinding: {},
    adapterBindingDigest: adapter.adapterBindingDigest,
    poolBindingDigest: adapter.poolBindingDigest,
    sessionBindingDigest: digest('4'),
    connectionBindingDigest: connectionDigest,
    targetDigest: runtimeDatabaseTargetDigest(connectedTarget),
    transactionStatus: vi.fn(() => {
      events.push(`status:${status}`);
      return status;
    }),
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[]
    ) {
      events.push(`sql:${sql}`);
      values.push(parameters);
      if (sql.startsWith('BEGIN ')) {
        if (scenario.beginThrows) throw new Error('synthetic ambiguous begin');
        status = scenario.beginStatus ?? 'IN_TRANSACTION';
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        if (scenario.commitThrows) throw new Error('synthetic ambiguous commit');
        status = scenario.commitStatus ?? 'IDLE';
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (scenario.rollbackThrows) throw new Error('synthetic ambiguous rollback');
        status = scenario.rollbackStatus ?? 'IDLE';
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) {
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
        status = 'IN_TRANSACTION';
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (sql === RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL) {
        if (scenario.authorityReadThrows) throw new Error('synthetic authority read failure');
        return {
          rows: [workOrderAuthorityRow(workOrderAuthority, scenario.authorityDrift) as Row],
          rowCount: scenario.authorityRowCount ?? 1,
        };
      }
      if (scenario.query) {
        try {
          return (await scenario.query(
            sql,
            parameters
          )) as RuntimeDatabaseDataPlaneQueryResult<Row>;
        } catch (error) {
          status = 'FAILED_TRANSACTION';
          throw error;
        }
      }
      return { rows: [{ value: 1 } as unknown as Row], rowCount: 1 };
    },
    release: vi.fn(async () => {
      events.push('release');
      if (scenario.releaseThrows) throw new Error('synthetic release failure');
    }),
    destroy: vi.fn(async () => {
      events.push('destroy');
      if (scenario.destroyThrows) throw new Error('synthetic destroy failure');
    }),
  };
  if (!scenario.missingApplicationQuery) {
    session.applicationQuery = async (sql, parameters) => {
      applicationStatements.push(sql);
      return session.query(sql, parameters);
    };
  }
  return { session, events, values, applicationStatements };
}

function adapterHarness(): AdapterHarness {
  const adapterBinding = {};
  const poolBinding = {};
  let epochDigest = digest('1');
  let scenario: RuntimeScenario | null = null;
  let workOrderAuthority: RuntimeDatabaseWorkOrderAuthorityBinding | null = null;
  let replicaConfigured = false;
  let statsOverrides: Readonly<Record<string, unknown>> = {};
  let closeGate: Promise<void> | null = null;
  let releaseCloseGate: (() => void) | null = null;
  const connections: AdapterHarness['connections'] = [];
  const sessions: RuntimeSessionRecord[] = [];
  const close = vi.fn(async () => {
    await closeGate;
  });
  const adapter: RuntimeDatabaseDataPlaneAdapter = {
    adapterBinding,
    poolBinding,
    get adapterBindingDigest() {
      return epochDigest;
    },
    poolBindingDigest: digest('2'),
    async connect(url, connectedTarget, connectionDigest) {
      connections.push({ url, target: connectedTarget, connectionDigest });
      if (!scenario) return makeAuthoritySession(adapter, connectionDigest, connectedTarget);
      if (!workOrderAuthority) throw new Error('test Work Order authority binding unavailable');
      const record = makeRuntimeSession(
        adapter,
        connectionDigest,
        connectedTarget,
        scenario,
        workOrderAuthority
      );
      sessions.push(record);
      return record.session;
    },
    stats() {
      return {
        totalConnections: 1,
        idleConnections: 1,
        waitingRequests: 0,
        maxConnections: 4,
        utilizationPercent: 25,
        replicaConnections: replicaConfigured ? 1 : null,
        replicaIdle: replicaConfigured ? 1 : null,
        replicaConfigured,
        ...statsOverrides,
      } as RuntimeDatabaseDataPlanePoolStats;
    },
    close,
  };
  return {
    adapter,
    connections,
    sessions,
    close,
    setScenario(nextScenario) {
      scenario = nextScenario;
      connections.length = 0;
      sessions.length = 0;
    },
    setWorkOrderAuthority(binding) {
      workOrderAuthority = binding;
    },
    stale() {
      epochDigest = digest('f');
    },
    configureReplica() {
      replicaConfigured = true;
    },
    setStats(overrides) {
      statsOverrides = overrides;
    },
    deferClose() {
      closeGate = new Promise<void>((resolve) => {
        releaseCloseGate = resolve;
      });
      return () => {
        releaseCloseGate?.();
        closeGate = null;
        releaseCloseGate = null;
      };
    },
  };
}

async function issueCapability(
  harness: AdapterHarness
): Promise<RuntimeDatabaseAuthorityCapability> {
  const capability = await attestRuntimeDatabaseAuthority(
    authorityInput(),
    harness.adapter,
    authorityVerifiers
  );
  harness.setWorkOrderAuthority(
    runtimeDatabaseWorkOrderAuthorityBinding(capability, harness.adapter)
  );
  return capability;
}

async function readyPlane(
  scenario: RuntimeScenario = {}
): Promise<{ plane: RuntimeDatabaseDataPlane; harness: AdapterHarness }> {
  const harness = adapterHarness();
  const capability = await issueCapability(harness);
  harness.setScenario(scenario);
  const plane = createRuntimeDatabaseDataPlane({
    primaryDatabaseUrl,
    replicaDatabaseUrl: null,
    target,
    adapter: harness.adapter,
    capability,
  });
  return { plane, harness };
}

async function refusalCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return 'NO_REFUSAL';
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeDatabaseDataPlaneError);
    return (error as RuntimeDatabaseDataPlaneError).code;
  }
}

describe('capability-bound runtime database data plane', () => {
  it('requires the single-statement application capability before beginning a transaction', async () => {
    const { plane, harness } = await readyPlane({ missingApplicationQuery: true });
    await expect(plane.query('SELECT 1')).rejects.toMatchObject({
      code: 'DATABASE_SESSION_APPLICATION_QUERY_UNAVAILABLE',
    });
    expect(harness.sessions[0]!.events).toEqual(['destroy']);
  });

  it('routes reads, writes, transaction callbacks and savepoints through applicationQuery', async () => {
    const { plane, harness } = await readyPlane();
    await plane.query('SELECT 1');
    await plane.readQuery('SELECT 2');
    await plane.transaction(async (query) => {
      await query('SAVEPOINT guarded');
      await query('SELECT 3');
      await query('ROLLBACK TO SAVEPOINT guarded');
      await query('RELEASE SAVEPOINT guarded');
    });
    await plane.serializableTransaction(async (query) => query('SELECT 4'));
    expect(harness.sessions.map((record) => record.applicationStatements)).toEqual([
      ['SELECT 1'],
      ['SELECT 2'],
      [
        'SAVEPOINT guarded',
        'SELECT 3',
        'ROLLBACK TO SAVEPOINT guarded',
        'RELEASE SAVEPOINT guarded',
      ],
      ['SELECT 4'],
    ]);
  });

  it.each(['marker', 'marker9', '_marker', 'caf\u00e9', '\u6e2c\u8a66', 'marker$'])(
    'does not hide COMMIT after a dollar tag embedded in identifier %s',
    async (identifier) => {
      const { plane, harness } = await readyPlane();
      const sql = `SELECT 1 AS ${identifier}$tag$; COMMIT; -- $tag$`;
      await expect(plane.query(sql)).rejects.toMatchObject({
        code: 'APPLICATION_SQL_MULTISTATEMENT_FORBIDDEN',
      });
      expect(harness.connections).toHaveLength(0);
      await expect(
        plane.transaction(async (query) => {
          await query('INSERT INTO work_orders DEFAULT VALUES');
          await query(sql);
        })
      ).rejects.toMatchObject({ code: 'APPLICATION_SQL_MULTISTATEMENT_FORBIDDEN' });
      const record = harness.sessions[0]!;
      expect(record.events).toContain('sql:ROLLBACK');
      expect(record.events).not.toContain('sql:COMMIT');
      expect(record.applicationStatements).not.toContain(sql);
    }
  );

  it.each([
    'SELECT 1 AS marker$tag$',
    'SELECT 1 AS marker$$',
    'SELECT $tag$; COMMIT; $tag$::text',
    'SELECT/* boundary */$tag$; COMMIT; $tag$::text',
    'SELECT $$; COMMIT; $$::text',
  ])('accepts a single statement with valid dollar syntax: %s', async (sql) => {
    const { plane } = await readyPlane();
    await expect(plane.query(sql)).resolves.toEqual({ rows: [{ value: 1 }], rowCount: 1 });
  });

  it('keeps bindings opaque and orders target verification before application SQL', async () => {
    const { plane, harness } = await readyPlane({
      query: async (sql) => {
        if (sql === 'UPDATE work_orders SET status=$1 RETURNING id') {
          return { rows: [{ id: 'wo-1' }], rowCount: 7 };
        }
        return { rows: [], rowCount: 0 };
      },
    });

    expect(Object.keys(plane)).toEqual([]);
    expect(Object.isFrozen(plane)).toBe(true);
    expect(plane).not.toHaveProperty('getPool');

    const result = await plane.query<{ id: string }>(
      'UPDATE work_orders SET status=$1 RETURNING id',
      ['ACTIVE']
    );
    expect(result).toEqual({ rows: [{ id: 'wo-1' }], rowCount: 7 });
    expect(harness.connections).toHaveLength(1);
    expect(harness.connections[0]).toEqual(
      expect.objectContaining({ url: primaryDatabaseUrl, target })
    );
    expect(Object.isFrozen(harness.connections[0]!.target)).toBe(true);

    const record = harness.sessions[0]!;
    const sqlEvents = record.events.filter((event) => event.startsWith('sql:'));
    expect(sqlEvents).toEqual([
      'sql:BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
      `sql:${RUNTIME_DATABASE_DATA_PLANE_SEARCH_PATH_SQL}`,
      `sql:${RUNTIME_DATABASE_DATA_PLANE_TARGET_BARRIER_LOCK_SQL}`,
      `sql:${RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL}`,
      'sql:UPDATE work_orders SET status=$1 RETURNING id',
      'sql:COMMIT',
    ]);
    expect(record.values[4]).toEqual(['ACTIVE']);
    expect(record.events.at(-1)).toBe('release');
  });

  it('uses one primary transaction per operation and DB-enforces each requested mode', async () => {
    const { plane, harness } = await readyPlane();

    await plane.readQuery('SELECT 1');
    await plane.transaction(async (query) => {
      await query('UPDATE one SET value=1');
      await query('UPDATE two SET value=2');
      return 'done';
    });
    await plane.serializableTransaction(async (query) => query('DELETE FROM three'));

    expect(harness.sessions).toHaveLength(3);
    expect(harness.sessions.map((record) => record.events[1])).toEqual([
      'sql:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'sql:BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
      'sql:BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE',
    ]);
    expect(harness.sessions[1]!.events.filter((event) => event.startsWith('sql:UPDATE'))).toEqual([
      'sql:UPDATE one SET value=1',
      'sql:UPDATE two SET value=2',
    ]);
    expect(harness.connections).toHaveLength(3);
  });

  it('owns one bounded read-only attestation snapshot before exposing its guarded query', async () => {
    const { plane, harness } = await readyPlane();
    await plane.readOnlyAttestationTransaction(async (query) => {
      await query('SELECT 1');
      await query('SELECT 2');
    });
    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]!.events.filter((event) => event.startsWith('sql:'))).toEqual([
      'sql:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'sql:SET LOCAL search_path=pg_catalog',
      "sql:SET LOCAL statement_timeout='1000ms'",
      "sql:SET LOCAL lock_timeout='250ms'",
      `sql:${RUNTIME_DATABASE_DATA_PLANE_TARGET_BARRIER_LOCK_SQL}`,
      `sql:${RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL}`,
      'sql:SELECT 1',
      'sql:SELECT 2',
      'sql:COMMIT',
    ]);
  });

  it('routes the installed database facade through the sealed attestation transaction', async () => {
    const { plane, harness } = await readyPlane();
    // Keep the required-suite disposable db singleton intact. A query-qualified
    // facade has its own installation slot while sharing the genuine plane module.
    const isolatedFacadePath = '../../src/db.js?attestation-facade-test';
    const { db, installAttestedDatabaseRuntime } = (await import(
      isolatedFacadePath
    )) as typeof import('../../src/db.js');
    installAttestedDatabaseRuntime(plane);
    try {
      await db.readOnlyAttestationTransaction(async (query) => {
        await query('SELECT 1');
        await query('SELECT 2');
      });
      expect(harness.sessions).toHaveLength(1);
      expect(harness.sessions[0]!.events).toContain(
        'sql:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
      );
      expect(harness.sessions[0]!.applicationStatements).toEqual(['SELECT 1', 'SELECT 2']);
    } finally {
      await db.close();
    }
  });

  it.each(['SET LOCAL search_path=public', 'COMMIT', 'SAVEPOINT caller'])(
    'rejects caller transaction controls during attestation: %s',
    async (sql) => {
      const { plane, harness } = await readyPlane();
      await expect(
        plane.readOnlyAttestationTransaction(async (query) => query(sql))
      ).rejects.toMatchObject({ code: 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN' });
      expect(harness.sessions[0]!.applicationStatements).not.toContain(sql);
      expect(harness.sessions[0]!.events).toContain('sql:ROLLBACK');
    }
  );

  it('permits only safe named savepoint recovery inside trusted transaction callbacks', async () => {
    const statementError = new Error('synthetic statement failure');
    const { plane, harness } = await readyPlane({
      query: async (sql) => {
        if (sql === 'INSERT INTO work_orders DEFAULT VALUES') throw statementError;
        return { rows: [{ recovered: true }], rowCount: 1 };
      },
    });

    const result = await plane.transaction(async (query) => {
      await query('SAVEPOINT hustlexp_task_create');
      try {
        await query('INSERT INTO work_orders DEFAULT VALUES');
      } catch (error) {
        expect(error).toBe(statementError);
        await query('ROLLBACK TO SAVEPOINT hustlexp_task_create');
        await query('RELEASE SAVEPOINT hustlexp_task_create');
      }
      return query<{ recovered: boolean }>('SELECT true AS recovered');
    });

    expect(result).toEqual({ rows: [{ recovered: true }], rowCount: 1 });
    expect(harness.sessions[0]!.events).toEqual(
      expect.arrayContaining([
        'sql:SAVEPOINT hustlexp_task_create',
        'status:FAILED_TRANSACTION',
        'sql:ROLLBACK TO SAVEPOINT hustlexp_task_create',
        'sql:RELEASE SAVEPOINT hustlexp_task_create',
        'sql:COMMIT',
        'release',
      ])
    );

    await expect(plane.query('SAVEPOINT top_level_forbidden')).rejects.toMatchObject({
      code: 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN',
    });
    await expect(
      plane.transaction(async (query) => query('SAVEPOINT unsafe-name'))
    ).rejects.toMatchObject({ code: 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN' });
    expect(harness.sessions[1]!.events).toContain('sql:ROLLBACK');
  });

  it('rejects forged capabilities, forged receivers, and stale adapter epochs', async () => {
    const harness = adapterHarness();
    expect(() =>
      createRuntimeDatabaseDataPlane({
        primaryDatabaseUrl,
        target,
        adapter: harness.adapter,
        capability: Object.freeze({}) as RuntimeDatabaseAuthorityCapability,
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORITY_CAPABILITY_INVALID' }));

    const ready = await readyPlane();
    const forged = Object.create(Object.getPrototypeOf(ready.plane)) as RuntimeDatabaseDataPlane;
    await expect(forged.query('SELECT 1')).rejects.toMatchObject({ code: 'DATA_PLANE_INVALID' });

    ready.harness.stale();
    await expect(ready.plane.query('SELECT 1')).rejects.toMatchObject({
      code: 'AUTHORITY_CAPABILITY_INVALID',
    });
    expect(ready.harness.connections).toHaveLength(0);
  });

  it('rolls back and never runs application SQL when the live target tip drifts', async () => {
    const { plane, harness } = await readyPlane({
      authorityDrift: { seal_sql_sha256: digest('e') },
    });

    await expect(plane.query('UPDATE work_orders SET status=$1', ['ACTIVE'])).rejects.toMatchObject(
      {
        code: 'LIVE_TARGET_BLOCKED',
      }
    );
    const events = harness.sessions[0]!.events;
    expect(events).not.toContain('sql:UPDATE work_orders SET status=$1');
    expect(events).toContain('sql:ROLLBACK');
    expect(events.at(-1)).toBe('release');
  });

  it('compares every canonical live-target field and exact row cardinality', async () => {
    const driftCases: readonly RuntimeScenario[] = [
      { authorityDrift: { session_database_role: 'hx_worker_candidate' } },
      { authorityDrift: { target_authority_id: '22222222-2222-4222-8222-222222222222' } },
      { authorityDrift: { authority_version: 2 } },
      { authorityDrift: { authority_version: '1' } },
      { authorityDrift: { target_database_name: 'wrong_database' } },
      { authorityDrift: { environment: 'preview' } },
      { authorityDrift: { release_manifest_sha256: digest('e') } },
      { authorityDrift: { ordinal146_sql_sha256: digest('e') } },
      { authorityDrift: { v12_sql_sha256: digest('e') } },
      { authorityDrift: { seal_sql_sha256: digest('e') } },
      { authorityDrift: { v13_sql_sha256: 'e'.repeat(64) } },
      { authorityDrift: { v13_sql_sha256: null } },
      { authorityDrift: { v13_sql_sha256: undefined } },
      { authorityDrift: { fake_financial_operations_relation: 'public.wrong_operations' } },
      {
        authorityDrift: {
          fake_financial_operation_events_relation: 'public.wrong_operation_events',
        },
      },
      { authorityDrift: { unexpected_column: true } },
      { authorityRowCount: 0 },
    ];

    for (const scenario of driftCases) {
      const { plane, harness } = await readyPlane(scenario);
      await expect(plane.query('SELECT application_read')).rejects.toMatchObject({
        code: 'LIVE_TARGET_BLOCKED',
      });
      expect(harness.sessions[0]!.events).not.toContain('sql:SELECT application_read');
      expect(harness.sessions[0]!.events.at(-1)).toBe('release');
    }

    const readFailure = await readyPlane({ authorityReadThrows: true });
    await expect(readFailure.plane.query('SELECT application_read')).rejects.toMatchObject({
      code: 'LIVE_TARGET_VERIFICATION_FAILED',
    });
    expect(readFailure.harness.sessions[0]!.events.at(-1)).toBe('release');
  });

  it('rejects empty, malformed, multi-statement, and transaction-control application SQL', async () => {
    const { plane, harness } = await readyPlane();
    const cases = [
      ['', 'APPLICATION_SQL_EMPTY'],
      ['/* only a comment */', 'APPLICATION_SQL_EMPTY'],
      ["SELECT 'unterminated", 'APPLICATION_SQL_INVALID'],
      ['SELECT 1; DELETE FROM work_orders', 'APPLICATION_SQL_MULTISTATEMENT_FORBIDDEN'],
      ['/* lead */ COMMIT', 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'],
      ['SET LOCAL TRANSACTION READ ONLY', 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'],
      ['SET search_path=public', 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'],
      ['RESET ALL', 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'],
      ['DISCARD ALL', 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'],
      ['DEALLOCATE ALL', 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'],
    ] as const;
    for (const [sql, code] of cases) {
      await expect(refusalCode(plane.query(sql))).resolves.toBe(code);
    }
    expect(harness.connections).toHaveLength(0);

    await expect(plane.transaction(async (query) => query('ROLLBACK'))).rejects.toMatchObject({
      code: 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN',
    });
    expect(harness.sessions[0]!.events).toContain('sql:ROLLBACK');

    await expect(plane.query("SELECT ';'::text; -- one trailing terminator")).resolves.toEqual({
      rows: [{ value: 1 }],
      rowCount: 1,
    });
  });

  it.each([
    ['begin', { beginThrows: true }, 'TRANSACTION_BEGIN_AMBIGUOUS'],
    ['commit', { commitThrows: true }, 'TRANSACTION_COMMIT_AMBIGUOUS'],
  ] as const)(
    'destroys an ambiguous %s without returning it to the pool',
    async (_name, scenario, code) => {
      const { plane, harness } = await readyPlane(scenario);

      await expect(refusalCode(plane.query('SELECT 1'))).resolves.toBe(code);
      const events = harness.sessions[0]!.events;
      expect(events.at(-1)).toBe('destroy');
      expect(events).not.toContain('release');
      if ('beginThrows' in scenario) expect(events).not.toContain('sql:ROLLBACK');
    }
  );

  it('preserves callback errors after a proven rollback and idle release', async () => {
    const operationError = new Error('application invariant refused');
    const { plane, harness } = await readyPlane();

    await expect(
      plane.transaction(async (query) => {
        await query('UPDATE work_orders SET status=$1', ['ACTIVE']);
        throw operationError;
      })
    ).rejects.toBe(operationError);

    const events = harness.sessions[0]!.events;
    expect(events).toContain('sql:ROLLBACK');
    expect(events.at(-2)).toBe('status:IDLE');
    expect(events.at(-1)).toBe('release');
    expect(events).not.toContain('destroy');
  });

  it.each([
    ['rollback transport ambiguity', { rollbackThrows: true }],
    ['rollback protocol ambiguity', { rollbackStatus: 'UNKNOWN' as const }],
  ])('destroys on %s and preserves the operation error', async (_name, scenario) => {
    const operationError = new Error('original callback failure');
    const { plane, harness } = await readyPlane(scenario);

    await expect(
      plane.transaction(async () => {
        throw operationError;
      })
    ).rejects.toBe(operationError);
    const events = harness.sessions[0]!.events;
    expect(events.at(-1)).toBe('destroy');
    expect(events).not.toContain('release');
  });

  it('retries destruction after release failure without replacing the operation error', async () => {
    const operationError = new Error('original callback failure');
    const { plane, harness } = await readyPlane({ releaseThrows: true });

    await expect(
      plane.transaction(async () => {
        throw operationError;
      })
    ).rejects.toBe(operationError);
    expect(harness.sessions[0]!.events.slice(-2)).toEqual(['release', 'destroy']);
  });

  it('destroys a forged physical session before application SQL', async () => {
    const { plane, harness } = await readyPlane({ forgedSessionBinding: true });

    await expect(plane.query('SELECT 1')).rejects.toMatchObject({
      code: 'DATABASE_SESSION_BINDING_MISMATCH',
    });
    expect(harness.sessions[0]!.events).toEqual(['destroy']);
  });

  it('rejects configured or newly observed replicas and never opens a session', async () => {
    const harness = adapterHarness();
    const capability = await issueCapability(harness);
    harness.setScenario({});
    expect(() =>
      createRuntimeDatabaseDataPlane({
        primaryDatabaseUrl,
        replicaDatabaseUrl: 'postgresql://replica.invalid/hustlexp_nonprod',
        target,
        adapter: harness.adapter,
        capability,
      })
    ).toThrowError(expect.objectContaining({ code: 'REPLICA_DATABASE_CONFIGURED' }));

    const plane = createRuntimeDatabaseDataPlane({
      primaryDatabaseUrl,
      target,
      adapter: harness.adapter,
      capability,
    });
    harness.configureReplica();
    await expect(plane.readQuery('SELECT 1')).rejects.toMatchObject({
      code: 'REPLICA_DATABASE_CONFIGURED',
    });
    expect(harness.connections).toHaveLength(0);
  });

  it('refuses impossible or arithmetically inconsistent primary-pool stats', async () => {
    const { plane, harness } = await readyPlane();
    expect(plane.stats()).toEqual({
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 0,
      maxConnections: 4,
      utilizationPercent: 25,
      replicaConnections: null,
      replicaIdle: null,
      replicaConfigured: false,
    });

    for (const invalid of [
      { totalConnections: 5, maxConnections: 4, utilizationPercent: 125 },
      { idleConnections: 2 },
      { utilizationPercent: 24 },
    ]) {
      harness.setStats(invalid);
      expect(() => plane.stats()).toThrowError(
        expect.objectContaining({ code: 'ADAPTER_STATE_INVALID' })
      );
      await expect(plane.query('SELECT 1')).rejects.toMatchObject({
        code: 'ADAPTER_STATE_INVALID',
      });
      harness.setStats({});
    }
    expect(harness.connections).toHaveLength(0);
  });

  it('invalidates before adapter close settles and refuses every later operation', async () => {
    const { plane, harness } = await readyPlane();

    const releaseClose = harness.deferClose();
    harness.stale();
    const closing = plane.close();
    await Promise.resolve();
    expect(harness.close).toHaveBeenCalledOnce();
    await expect(plane.query('SELECT 1')).rejects.toMatchObject({ code: 'DATA_PLANE_CLOSED' });
    expect(() => plane.stats()).toThrowError(
      expect.objectContaining({ code: 'DATA_PLANE_CLOSED' })
    );
    await expect(plane.close()).rejects.toMatchObject({ code: 'DATA_PLANE_CLOSED' });
    expect(harness.connections).toHaveLength(0);
    releaseClose();
    await closing;
  });
});
