import { describe, expect, it, vi } from 'vitest';

import {
  attestRuntimeDatabaseAuthority as attestCanonicalRuntimeDatabaseAuthority,
  assertRuntimeDatabaseAuthorityCapabilityFor,
  attestRuntimeDatabaseAuthorityKernelForTest as attestRuntimeDatabaseAuthority,
  RUNTIME_DATABASE_IDENTITY_SQL,
  RUNTIME_DATABASE_TRANSACTION_STATE_SQL,
  RuntimeDatabaseAuthorityError,
  runtimeDatabaseAuthorityHealth,
  runtimeDatabaseWorkOrderAuthorityBinding,
  RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL,
  runtimeDatabaseBuildProofDigest,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseAuthorityAdapter,
  type RuntimeDatabaseAuthorityInput,
  type RuntimeDatabaseAuthoritySession,
  type RuntimeDatabaseAuthorityVerifier,
  type RuntimeDatabaseAuthorityVerifiers,
  type RuntimeDatabaseCanonicalBuildProof,
  type RuntimeDatabaseCanonicalReleaseProof,
  type RuntimeDatabaseReleaseVerificationRequest,
  type RuntimeDatabaseRoleTopology,
  type RuntimeDatabaseTransactionStatus,
} from '../../src/jobs/runtime-database-authority.js';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const manifestDigest = digest('a');
const artifactDigest = digest('b');
const signerFingerprint = digest('c');
const revision = 'd'.repeat(40);
const bindingDigest = (character: string) => digest(character);

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

const primaryUrl =
  'postgresql://hx_api_candidate:credential-one@postgres.railway.internal:5432/' +
  'hustlexp_nonprod?sslmode=verify-full&channel_binding=require&application_name=hustlexp-api';

const targetDigest = runtimeDatabaseTargetDigest({
  ...expectedTarget,
  component: 'api',
  serviceLogin: roles.apiRole,
  roleTopologyDigest,
});

const identityRow = {
  database_name: expectedTarget.databaseName,
  current_user: roles.apiRole,
  session_user: roles.apiRole,
  server_address: expectedTarget.serverAddress,
  server_port: expectedTarget.port,
  attested_at: '2026-09-01T12:30:00.000Z',
};

function authorityInput(
  overrides: Partial<RuntimeDatabaseAuthorityInput> = {}
): RuntimeDatabaseAuthorityInput {
  return {
    component: 'api',
    primaryDatabaseUrl: primaryUrl,
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
    ...overrides,
  };
}

type ProofOverrides = Partial<Omit<RuntimeDatabaseCanonicalReleaseProof, 'build'>> & {
  build?: Partial<RuntimeDatabaseCanonicalBuildProof>;
};

function releaseProof(
  request: RuntimeDatabaseReleaseVerificationRequest,
  overrides: ProofOverrides = {}
): RuntimeDatabaseCanonicalReleaseProof {
  const buildWithoutDigest = {
    releaseManifestDigest: request.pins.manifestDigest,
    environment: request.environment,
    component: request.releaseComponent,
    revision: request.pins.revision,
    artifactDigest: request.pins.artifactDigest,
    databaseTargetDigest: request.databaseTargetDigest,
    ...overrides.build,
  };
  const identityDigest =
    overrides.build?.identityDigest ??
    runtimeDatabaseBuildProofDigest({
      releaseManifestDigest: buildWithoutDigest.releaseManifestDigest,
      environment: buildWithoutDigest.environment,
      component: buildWithoutDigest.component,
      revision: buildWithoutDigest.revision,
      artifactDigest: buildWithoutDigest.artifactDigest,
      databaseTargetDigest: buildWithoutDigest.databaseTargetDigest,
    });
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
    ...overrides,
    build: { ...buildWithoutDigest, identityDigest },
  };
}

interface HarnessOptions {
  initialStatus?: RuntimeDatabaseTransactionStatus;
  beginThrows?: boolean;
  commitThrows?: boolean;
  rollbackThrows?: boolean;
  releaseThrows?: boolean;
  destroyThrows?: boolean;
  statusThrows?: boolean;
  statusThrowsAtCall?: number;
  stateMismatch?: boolean;
  stateRowCount?: number;
  identityRowCount?: number;
  workOrderLockThrows?: boolean;
  workOrderLockFailureStatus?: RuntimeDatabaseTransactionStatus;
  bindingMismatch?: boolean;
}

interface Harness {
  adapter: RuntimeDatabaseAuthorityAdapter;
  session: RuntimeDatabaseAuthoritySession;
  events: string[];
  setStatus(status: RuntimeDatabaseTransactionStatus): void;
  connectedTarget(): Readonly<Record<string, unknown>> | null;
  connectedUrl(): string | null;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  let status = options.initialStatus ?? 'IDLE';
  let exactUrl: string | null = null;
  let connectedTarget: Readonly<Record<string, unknown>> | null = null;
  let connectionDigest = '';
  let exactTargetDigest = '';
  const adapterBinding = {};
  const poolBinding = {};
  const sessionBinding = {};
  const adapterBindingDigest = bindingDigest('1');
  const poolBindingDigest = bindingDigest('2');
  let statusCalls = 0;

  const query = vi.fn(async (sql: string) => {
    events.push(`sql:${sql}`);
    if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
      if (options.beginThrows) throw new Error('begin transport ambiguity');
      status = 'IN_TRANSACTION';
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'COMMIT') {
      if (options.commitThrows) throw new Error('commit transport ambiguity');
      status = 'IDLE';
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') {
      if (options.rollbackThrows) throw new Error('rollback transport ambiguity');
      status = 'IDLE';
      return { rows: [], rowCount: 0 };
    }
    if (sql === RUNTIME_DATABASE_TRANSACTION_STATE_SQL) {
      return {
        rows: [
          options.stateMismatch
            ? { transaction_isolation: 'read committed', transaction_read_only: 'off' }
            : { transaction_isolation: 'repeatable read', transaction_read_only: 'on' },
        ],
        rowCount: options.stateRowCount ?? 1,
      };
    }
    if (sql === RUNTIME_DATABASE_IDENTITY_SQL) {
      return { rows: [identityRow], rowCount: options.identityRowCount ?? 1 };
    }
    if (sql === RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL && options.workOrderLockThrows) {
      status = options.workOrderLockFailureStatus ?? 'FAILED_TRANSACTION';
      throw new Error('synthetic target barrier lock failure');
    }
    return { rows: [{ one: 1 }], rowCount: 1 };
  });

  const session: RuntimeDatabaseAuthoritySession = {
    adapterBinding: options.bindingMismatch ? {} : adapterBinding,
    poolBinding,
    sessionBinding,
    adapterBindingDigest,
    poolBindingDigest,
    sessionBindingDigest: bindingDigest('3'),
    get connectionBindingDigest() {
      return connectionDigest;
    },
    get targetDigest() {
      return exactTargetDigest;
    },
    transactionStatus: vi.fn(() => {
      statusCalls += 1;
      if (options.statusThrows || options.statusThrowsAtCall === statusCalls) {
        throw new Error('driver status unavailable');
      }
      return status;
    }),
    query: query as RuntimeDatabaseAuthoritySession['query'],
    release: vi.fn(async () => {
      events.push('release');
      if (options.releaseThrows) throw new Error('release failed');
    }),
    destroy: vi.fn(async () => {
      events.push('destroy');
      if (options.destroyThrows) throw new Error('destroy failed');
    }),
  };
  const adapter: RuntimeDatabaseAuthorityAdapter = {
    adapterBinding,
    poolBinding,
    adapterBindingDigest,
    poolBindingDigest,
    connect: vi.fn(async (url, target, digestValue) => {
      events.push('connect');
      exactUrl = url;
      connectedTarget = target;
      connectionDigest = digestValue;
      exactTargetDigest = runtimeDatabaseTargetDigest(target);
      return session;
    }),
  };
  return {
    adapter,
    session,
    events,
    setStatus(value) {
      status = value;
    },
    connectedTarget: () => connectedTarget,
    connectedUrl: () => exactUrl,
  };
}

function verifiers(
  proofOverrides: ProofOverrides = {},
  topology: RuntimeDatabaseAuthorityVerifier = async () => ({ status: 'READY' }),
  targetTip: RuntimeDatabaseAuthorityVerifier = async () => ({ status: 'READY' })
): RuntimeDatabaseAuthorityVerifiers {
  return {
    verifyReleaseAuthority: vi.fn(async (request) => releaseProof(request, proofOverrides)),
    verifyEightRoleTopology: vi.fn(topology),
    verifyWorkOrderTargetTip: vi.fn(targetTip),
  };
}

async function refused(
  request: RuntimeDatabaseAuthorityInput,
  testHarness = harness(),
  testVerifiers = verifiers()
): Promise<string> {
  try {
    await attestRuntimeDatabaseAuthority(request, testHarness.adapter, testVerifiers);
    return 'NO_REFUSAL';
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeDatabaseAuthorityError);
    return (error as RuntimeDatabaseAuthorityError).code;
  }
}

describe('trusted runtime database release and target authority', () => {
  it('returns only an opaque pool-bound capability and redacted exact provenance', async () => {
    const testHarness = harness();
    const testVerifiers = verifiers();
    const capability = await attestRuntimeDatabaseAuthority(
      authorityInput(),
      testHarness.adapter,
      testVerifiers
    );
    const health = runtimeDatabaseAuthorityHealth(capability);

    expect(Object.keys(capability)).toEqual([]);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(health).toEqual({
      component: 'api',
      environment: 'staging',
      authorityDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      databaseTargetDigest: targetDigest,
      roleTopologyDigest,
      manifestDigest,
      revision,
      artifactDigest,
      workOrderTargetAuthorityId: '11111111-1111-4111-8111-111111111111',
      workOrderTargetAuthorityVersion: 1,
      workOrderTargetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      workOrderSealDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      attestedAt: identityRow.attested_at,
    });
    expect(Object.keys(health).sort()).toEqual([
      'artifactDigest',
      'attestedAt',
      'authorityDigest',
      'component',
      'databaseTargetDigest',
      'environment',
      'manifestDigest',
      'revision',
      'roleTopologyDigest',
      'workOrderSealDigest',
      'workOrderTargetAuthorityId',
      'workOrderTargetAuthorityVersion',
      'workOrderTargetDigest',
    ]);
    expect(assertRuntimeDatabaseAuthorityCapabilityFor(capability, testHarness.adapter)).toBe(
      health
    );
    expect(runtimeDatabaseWorkOrderAuthorityBinding(capability, testHarness.adapter)).toEqual(
      expect.objectContaining({
        targetAuthorityId: health.workOrderTargetAuthorityId,
        authorityVersion: health.workOrderTargetAuthorityVersion,
        bindingDigest: health.workOrderTargetDigest,
      })
    );
    expect(testHarness.connectedUrl()).toBe(primaryUrl);
    expect(Object.isFrozen(testHarness.connectedTarget())).toBe(true);
    expect(JSON.stringify([health, capability])).not.toMatch(/credential|hx_api_candidate/u);
  });

  it('invalidates health and use when the bound adapter authority epoch changes', async () => {
    const testHarness = harness();
    const capability = await attestRuntimeDatabaseAuthority(
      authorityInput(),
      testHarness.adapter,
      verifiers()
    );
    Object.defineProperty(testHarness.adapter, 'adapterBindingDigest', {
      configurable: true,
      enumerable: true,
      get: () => bindingDigest('f'),
    });

    for (const [operation, code] of [
      [() => runtimeDatabaseAuthorityHealth(capability), 'DATABASE_AUTHORITY_EVALUATION_FAILED'],
      [
        () => assertRuntimeDatabaseAuthorityCapabilityFor(capability, testHarness.adapter),
        'DATABASE_SESSION_BINDING_MISMATCH',
      ],
    ] as const) {
      expect(operation).toThrowError(expect.objectContaining({ code }));
    }
  });

  it('does not accept caller-asserted trust booleans and binds recomputed proof to the target', async () => {
    const request = authorityInput();
    expect(request).not.toHaveProperty('signatureStatus');
    expect(request).not.toHaveProperty('trustStatus');
    expect(request.releasePins).not.toHaveProperty('signatureStatus');
    expect(request.releasePins).not.toHaveProperty('trustStatus');

    const oldTarget = digest('e');
    await expect(
      refused(request, harness(), verifiers({ databaseTargetDigest: oldTarget }))
    ).resolves.toBe('RELEASE_DATABASE_TARGET_MISMATCH');
    await expect(
      refused(request, harness(), verifiers({ build: { databaseTargetDigest: oldTarget } }))
    ).resolves.toBe('BUILD_PROOF_MISMATCH');
  });

  it('rejects zero, signer, manifest, revision, artifact, and canonical-build proof drift', async () => {
    const cases: Array<[ProofOverrides, string]> = [
      [{ canonicalManifestDigest: digest('f') }, 'RELEASE_MANIFEST_DIGEST_MISMATCH'],
      [{ signerKeyId: 'wrong-signer' }, 'RELEASE_SIGNER_MISMATCH'],
      [{ revision: 'e'.repeat(40) }, 'RELEASE_REVISION_MISMATCH'],
      [{ artifactDigest: digest('f') }, 'RELEASE_ARTIFACT_DIGEST_MISMATCH'],
      [{ manifestDigest: `sha256:${'0'.repeat(64)}` }, 'RELEASE_PROOF_INVALID'],
      [{ build: { identityDigest: digest('f') } }, 'BUILD_PROOF_MISMATCH'],
    ];
    for (const [proofOverrides, code] of cases) {
      const testHarness = harness();
      await expect(refused(authorityInput(), testHarness, verifiers(proofOverrides))).resolves.toBe(
        code
      );
      expect(testHarness.adapter.connect).not.toHaveBeenCalled();
    }
  });

  it('deep-copies and freezes authority input before the first await', async () => {
    const request = authorityInput();
    const originalUrl = request.primaryDatabaseUrl;
    const testHarness = harness();
    const testVerifiers = verifiers();
    vi.mocked(testVerifiers.verifyReleaseAuthority).mockImplementationOnce(async (proofRequest) => {
      (request.expectedTarget as { hostname: string }).hostname = 'mutated.invalid';
      (request.roleTopology as { apiRole: string }).apiRole = 'mutated_role';
      (request.releasePins as { revision: string }).revision = 'f'.repeat(40);
      expect(Object.isFrozen(proofRequest)).toBe(true);
      expect(Object.isFrozen(proofRequest.pins)).toBe(true);
      return releaseProof(proofRequest);
    });

    await attestRuntimeDatabaseAuthority(request, testHarness.adapter, testVerifiers);
    expect(testHarness.connectedUrl()).toBe(originalUrl);
    expect(testHarness.connectedTarget()).toEqual(
      expect.objectContaining({ hostname: expectedTarget.hostname, serviceLogin: roles.apiRole })
    );
  });

  it('snapshots every caller-owned input field exactly once before validation', async () => {
    const request = authorityInput();
    const reads = new Map<string, number>();
    const readOnce =
      <T>(name: string, first: T, drift: T): (() => T) =>
      () => {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return count === 1 ? first : drift;
      };
    Object.defineProperties(request, {
      component: {
        configurable: true,
        enumerable: true,
        get: readOnce('component', 'api', 'worker'),
      },
      primaryDatabaseUrl: {
        configurable: true,
        enumerable: true,
        get: readOnce(
          'primaryDatabaseUrl',
          primaryUrl,
          primaryUrl.replace('sslmode=verify-full', 'sslmode=disable')
        ),
      },
      replicaDatabaseUrl: {
        configurable: true,
        enumerable: true,
        get: readOnce('replicaDatabaseUrl', null, 'postgresql://replica.invalid/db'),
      },
      expectedTarget: {
        configurable: true,
        enumerable: true,
        get: readOnce(
          'expectedTarget',
          { ...expectedTarget },
          {
            ...expectedTarget,
            hostname: 'drift.invalid',
          }
        ),
      },
      expectedTargetDigest: {
        configurable: true,
        enumerable: true,
        get: readOnce('expectedTargetDigest', targetDigest, digest('f')),
      },
      roleTopology: {
        configurable: true,
        enumerable: true,
        get: readOnce(
          'roleTopology',
          { ...roles },
          {
            ...roles,
            apiRole: roles.workerRole,
          }
        ),
      },
      releasePins: {
        configurable: true,
        enumerable: true,
        get: readOnce('releasePins', authorityInput().releasePins, {
          ...authorityInput().releasePins,
          revision: 'f'.repeat(40),
        }),
      },
    });
    const testHarness = harness();

    await attestRuntimeDatabaseAuthority(request, testHarness.adapter, verifiers());

    expect(Object.fromEntries(reads)).toEqual({
      component: 1,
      primaryDatabaseUrl: 1,
      replicaDatabaseUrl: 1,
      expectedTarget: 1,
      expectedTargetDigest: 1,
      roleTopology: 1,
      releasePins: 1,
    });
    expect(testHarness.connectedUrl()).toBe(primaryUrl);
    expect(testHarness.connectedTarget()).toEqual(
      expect.objectContaining({ component: 'api', serviceLogin: roles.apiRole })
    );
  });

  it('rejects unknown string or symbol keys without forwarding them', async () => {
    const cases: Array<[RuntimeDatabaseAuthorityInput, string]> = [];

    const topLevel = authorityInput() as RuntimeDatabaseAuthorityInput & { secret: string };
    topLevel.secret = 'must-not-forward';
    cases.push([topLevel, 'EXPECTED_TARGET_INVALID']);

    const target = authorityInput();
    (
      target.expectedTarget as RuntimeDatabaseAuthorityInput['expectedTarget'] & {
        secret: string;
      }
    ).secret = 'must-not-forward';
    cases.push([target, 'EXPECTED_TARGET_INVALID']);

    const topology = authorityInput();
    Object.defineProperty(topology.roleTopology, Symbol('secret'), {
      enumerable: true,
      value: 'must-not-forward',
    });
    cases.push([topology, 'ROLE_TOPOLOGY_INVALID']);

    const pins = authorityInput();
    (pins.releasePins as RuntimeDatabaseAuthorityInput['releasePins'] & { secret: string }).secret =
      'must-not-forward';
    cases.push([pins, 'RELEASE_PIN_INVALID']);

    for (const [request, code] of cases) {
      const testHarness = harness();
      await expect(refused(request, testHarness, verifiers())).resolves.toBe(code);
      expect(testHarness.adapter.connect).not.toHaveBeenCalled();
    }
  });

  it('keeps target and authority provenance stable across password rotation', async () => {
    const first = harness();
    const second = harness();
    const firstCapability = await attestRuntimeDatabaseAuthority(
      authorityInput(),
      first.adapter,
      verifiers()
    );
    const secondCapability = await attestRuntimeDatabaseAuthority(
      authorityInput({
        primaryDatabaseUrl: primaryUrl.replace('credential-one', 'credential-two'),
      }),
      second.adapter,
      verifiers()
    );
    expect(runtimeDatabaseAuthorityHealth(firstCapability)).toEqual(
      runtimeDatabaseAuthorityHealth(secondCapability)
    );
  });
});

describe('canonical runtime Work Order authority path', () => {
  it('takes the target lock before catalog reads and cannot use caller topology verdicts', async () => {
    const testHarness = harness();
    const supplied = verifiers();
    await expect(
      attestCanonicalRuntimeDatabaseAuthority(authorityInput(), testHarness.adapter, supplied)
    ).rejects.toMatchObject({ code: 'ROLE_TOPOLOGY_VERIFICATION_FAILED' });

    expect(supplied.verifyEightRoleTopology).not.toHaveBeenCalled();
    expect(supplied.verifyWorkOrderTargetTip).not.toHaveBeenCalled();
    expect(testHarness.events.slice(0, 4)).toEqual([
      'connect',
      'sql:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'sql:SET LOCAL search_path = pg_catalog',
      `sql:${RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL}`,
    ]);
    expect(testHarness.events.slice(-2)).toEqual(['sql:ROLLBACK', 'release']);
  });

  it('destroys a protocol-ambiguous target barrier failure and rolls back a proven SQL refusal', async () => {
    const ambiguousLock = harness({
      workOrderLockThrows: true,
      workOrderLockFailureStatus: 'UNKNOWN',
    });
    await expect(
      attestCanonicalRuntimeDatabaseAuthority(authorityInput(), ambiguousLock.adapter, verifiers())
    ).rejects.toMatchObject({ code: 'WORK_ORDER_TARGET_LOCK_FAILED' });
    expect(ambiguousLock.events.at(-1)).toBe('destroy');
    expect(ambiguousLock.events).not.toContain('sql:ROLLBACK');

    const refusedLock = harness({ workOrderLockThrows: true });
    await expect(
      attestCanonicalRuntimeDatabaseAuthority(authorityInput(), refusedLock.adapter, verifiers())
    ).rejects.toMatchObject({ code: 'WORK_ORDER_TARGET_LOCK_FAILED' });
    expect(refusedLock.events.slice(-2)).toEqual(['sql:ROLLBACK', 'release']);
  });
});

describe('configured runtime database target', () => {
  it('accepts only explicit conservative TLS options and holds downgrade or target overrides', async () => {
    for (const [url, code] of [
      [
        primaryUrl.replace('sslmode=verify-full', 'sslmode=verify-ca'),
        'PRIMARY_DATABASE_URL_TLS_INVALID',
      ],
      [
        primaryUrl.replace('sslmode=verify-full', 'sslmode=require'),
        'PRIMARY_DATABASE_URL_TLS_INVALID',
      ],
      [
        primaryUrl.replace('sslmode=verify-full', 'sslmode=prefer'),
        'PRIMARY_DATABASE_URL_TLS_INVALID',
      ],
      [
        primaryUrl.replace('sslmode=verify-full', 'sslmode=disable'),
        'PRIMARY_DATABASE_URL_TLS_INVALID',
      ],
      [primaryUrl.replace('&channel_binding=require', ''), 'PRIMARY_DATABASE_URL_TLS_INVALID'],
      [
        primaryUrl + '&options=-crole%3Dhx_migration_candidate',
        'PRIMARY_DATABASE_URL_OPTION_UNSUPPORTED',
      ],
      [primaryUrl + '&host=%2Fvar%2Frun%2Fpostgresql', 'PRIMARY_DATABASE_LOCAL_SOCKET_UNSUPPORTED'],
    ] as const) {
      await expect(refused(authorityInput({ primaryDatabaseUrl: url }))).resolves.toBe(code);
    }
  });

  it('holds replica, configured target, role topology, and target-digest drift before verification', async () => {
    const cases: Array<[RuntimeDatabaseAuthorityInput, string]> = [
      [
        authorityInput({ replicaDatabaseUrl: 'postgresql://replica.invalid/db' }),
        'REPLICA_DATABASE_CONFIGURED',
      ],
      [
        authorityInput({ primaryDatabaseUrl: primaryUrl.replace('hustlexp_nonprod', 'wrong_db') }),
        'CONFIGURED_DATABASE_NAME_MISMATCH',
      ],
      [
        authorityInput({
          primaryDatabaseUrl: primaryUrl.replace('postgres.railway.internal', 'wrong.internal'),
        }),
        'CONFIGURED_DATABASE_HOST_MISMATCH',
      ],
      [
        authorityInput({
          primaryDatabaseUrl: primaryUrl.replace('hx_api_candidate', 'wrong_login'),
        }),
        'CONFIGURED_DATABASE_USER_MISMATCH',
      ],
      [
        authorityInput({ roleTopology: { ...roles, financeOwnerRole: roles.commandOwnerRole } }),
        'ROLE_TOPOLOGY_INVALID',
      ],
      [
        authorityInput({ roleTopology: { ...roles, telemetryOwnerRole: roles.commandOwnerRole } }),
        'ROLE_TOPOLOGY_INVALID',
      ],
      [
        authorityInput({
          roleTopology: {
            ...roles,
            rogueOwnerRole: 'hx_rogue_owner_candidate',
          } as RuntimeDatabaseRoleTopology,
        }),
        'ROLE_TOPOLOGY_INVALID',
      ],
      [
        authorityInput({
          roleTopology: { ...roles, telemetryOwnerRole: 'hx_telemetry_owner_candidate_v2' },
        }),
        'TARGET_DIGEST_MISMATCH',
      ],
      [authorityInput({ expectedTargetDigest: digest('f') }), 'TARGET_DIGEST_MISMATCH'],
    ];
    for (const [request, code] of cases) {
      const testHarness = harness();
      const testVerifiers = verifiers();
      await expect(refused(request, testHarness, testVerifiers)).resolves.toBe(code);
      expect(testVerifiers.verifyReleaseAuthority).not.toHaveBeenCalled();
      expect(testHarness.adapter.connect).not.toHaveBeenCalled();
    }
  });
});

describe('repeatable-read runtime authority snapshot', () => {
  it('attests transaction state before identity and after each verifier', async () => {
    const testHarness = harness();
    await attestRuntimeDatabaseAuthority(authorityInput(), testHarness.adapter, verifiers());
    expect(testHarness.events).toEqual([
      'connect',
      'sql:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      `sql:${RUNTIME_DATABASE_TRANSACTION_STATE_SQL}`,
      `sql:${RUNTIME_DATABASE_IDENTITY_SQL}`,
      `sql:${RUNTIME_DATABASE_TRANSACTION_STATE_SQL}`,
      `sql:${RUNTIME_DATABASE_TRANSACTION_STATE_SQL}`,
      'sql:COMMIT',
      'release',
    ]);
  });

  it('rejects every nonregistered or side-effecting verifier statement before PostgreSQL', async () => {
    for (const forbiddenSql of [
      'COMMIT',
      'SELECT 1',
      'SELECT 1; COMMIT',
      'SET TRANSACTION READ WRITE',
      "SELECT pg_catalog.set_config('application_name','compromised',false)",
      'SELECT pg_catalog.pg_advisory_lock(42)',
      "WITH changed AS (SELECT pg_catalog.set_config('search_path','public',false)) SELECT * FROM changed",
      'SHOW search_path',
    ]) {
      const testHarness = harness();
      const malicious: RuntimeDatabaseAuthorityVerifier = async (context) => {
        await context.query(forbiddenSql);
        return { status: 'READY' };
      };
      await expect(refused(authorityInput(), testHarness, verifiers({}, malicious))).resolves.toBe(
        'VERIFIER_QUERY_PROTOCOL_VIOLATION'
      );
      expect(testHarness.events).not.toContain(`sql:${forbiddenSql}`);
      expect(testHarness.events.slice(-2)).toEqual(['sql:ROLLBACK', 'release']);
    }
  });

  it('permits each exact module-owned verifier read at most once without parameters', async () => {
    const accepted = harness();
    const exactReads: RuntimeDatabaseAuthorityVerifier = async (context) => {
      await context.query(RUNTIME_DATABASE_IDENTITY_SQL);
      await context.query(RUNTIME_DATABASE_TRANSACTION_STATE_SQL);
      return { status: 'READY' };
    };
    await expect(refused(authorityInput(), accepted, verifiers({}, exactReads))).resolves.toBe(
      'NO_REFUSAL'
    );
    expect(accepted.events).toContain(`sql:${RUNTIME_DATABASE_IDENTITY_SQL}`);

    const duplicate = harness();
    const repeatedRead: RuntimeDatabaseAuthorityVerifier = async (context) => {
      await context.query(RUNTIME_DATABASE_IDENTITY_SQL);
      await context.query(RUNTIME_DATABASE_IDENTITY_SQL);
      return { status: 'READY' };
    };
    await expect(refused(authorityInput(), duplicate, verifiers({}, repeatedRead))).resolves.toBe(
      'VERIFIER_QUERY_PROTOCOL_VIOLATION'
    );

    const parameterized = harness();
    const valuesOnExactRead: RuntimeDatabaseAuthorityVerifier = async (context) => {
      await context.query(RUNTIME_DATABASE_IDENTITY_SQL, ['unexpected']);
      return { status: 'READY' };
    };
    await expect(
      refused(authorityInput(), parameterized, verifiers({}, valuesOnExactRead))
    ).resolves.toBe('VERIFIER_QUERY_PROTOCOL_VIOLATION');
    expect(
      parameterized.events.filter((event) => event === `sql:${RUNTIME_DATABASE_IDENTITY_SQL}`)
    ).toHaveLength(1);
  });

  it('destroys a session if a verifier changes protocol transaction state', async () => {
    const testHarness = harness();
    const stateChanging: RuntimeDatabaseAuthorityVerifier = async () => {
      testHarness.setStatus('IDLE');
      return { status: 'READY' };
    };
    await expect(
      refused(authorityInput(), testHarness, verifiers({}, stateChanging))
    ).resolves.toBe('TRANSACTION_STATE_MISMATCH');
    expect(testHarness.events.at(-1)).toBe('destroy');
    expect(testHarness.events).not.toContain('release');
  });

  it('destroys dirty, binding-mismatched, and transaction-state-mismatched sessions', async () => {
    for (const [testHarness, code] of [
      [harness({ initialStatus: 'IN_TRANSACTION' }), 'DATABASE_SESSION_NOT_FRESH'],
      [harness({ bindingMismatch: true }), 'DATABASE_SESSION_BINDING_MISMATCH'],
      [harness({ stateMismatch: true }), 'TRANSACTION_STATE_MISMATCH'],
      [harness({ stateRowCount: 0 }), 'TRANSACTION_STATE_MISMATCH'],
      [harness({ identityRowCount: 0 }), 'LIVE_IDENTITY_ROW_COUNT_INVALID'],
      [harness({ statusThrows: true }), 'DATABASE_SESSION_STATUS_UNAVAILABLE'],
    ] as const) {
      await expect(refused(authorityInput(), testHarness, verifiers())).resolves.toBe(code);
      expect(testHarness.events.at(-1)).toBe('destroy');
      expect(testHarness.events).not.toContain('release');
    }
  });
});

describe('runtime database session cleanup and pool binding', () => {
  it('destroys on ambiguous BEGIN and COMMIT without ordinary release', async () => {
    for (const [testHarness, code] of [
      [harness({ beginThrows: true }), 'SNAPSHOT_BEGIN_AMBIGUOUS'],
      [harness({ commitThrows: true }), 'SNAPSHOT_COMMIT_AMBIGUOUS'],
    ] as const) {
      await expect(refused(authorityInput(), testHarness, verifiers())).resolves.toBe(code);
      expect(testHarness.events.at(-1)).toBe('destroy');
      expect(testHarness.events).not.toContain('release');
    }
  });

  it('destroys on rollback ambiguity, release failure, and destroy failure', async () => {
    const blocked: RuntimeDatabaseAuthorityVerifier = async () => ({ status: 'BLOCKED' });
    const rollbackFailure = harness({ rollbackThrows: true });
    await expect(refused(authorityInput(), rollbackFailure, verifiers({}, blocked))).resolves.toBe(
      'SNAPSHOT_ROLLBACK_AMBIGUOUS'
    );
    expect(rollbackFailure.events.slice(-2)).toEqual(['sql:ROLLBACK', 'destroy']);
    expect(rollbackFailure.events).not.toContain('release');

    const releaseFailure = harness({ releaseThrows: true });
    await expect(refused(authorityInput(), releaseFailure, verifiers())).resolves.toBe(
      'DATABASE_SESSION_RELEASE_FAILED'
    );
    expect(releaseFailure.events.slice(-2)).toEqual(['release', 'destroy']);

    const destroyFailure = harness({ beginThrows: true, destroyThrows: true });
    await expect(refused(authorityInput(), destroyFailure, verifiers())).resolves.toBe(
      'DATABASE_SESSION_DESTROY_FAILED'
    );
  });

  it('destroys when protocol status becomes unavailable after COMMIT or ROLLBACK', async () => {
    const afterCommit = harness({ statusThrowsAtCall: 5 });
    await expect(refused(authorityInput(), afterCommit, verifiers())).resolves.toBe(
      'DATABASE_SESSION_STATUS_UNAVAILABLE'
    );
    expect(afterCommit.events.at(-1)).toBe('destroy');
    expect(afterCommit.events).not.toContain('release');

    const blocked: RuntimeDatabaseAuthorityVerifier = async () => ({ status: 'BLOCKED' });
    const afterRollback = harness({ statusThrowsAtCall: 3 });
    await expect(refused(authorityInput(), afterRollback, verifiers({}, blocked))).resolves.toBe(
      'SNAPSHOT_ROLLBACK_AMBIGUOUS'
    );
    expect(afterRollback.events.slice(-2)).toEqual(['sql:ROLLBACK', 'destroy']);
    expect(afterRollback.events).not.toContain('release');
  });

  it('cannot reuse a capability with a sacrificial verifier adapter or pool', async () => {
    const certified = harness();
    const other = harness();
    const capability = await attestRuntimeDatabaseAuthority(
      authorityInput(),
      certified.adapter,
      verifiers()
    );
    expect(() => assertRuntimeDatabaseAuthorityCapabilityFor(capability, other.adapter)).toThrow(
      'DATABASE_SESSION_BINDING_MISMATCH'
    );
  });
});
