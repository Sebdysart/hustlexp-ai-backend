import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildIdentity } from '../../src/buildIdentity';
import {
  startWorkerHealthServer,
  type WorkerHealthServer,
} from '../../src/jobs/worker-health-server';
import {
  readReleaseManifest,
  releaseManifestDigest,
  releaseManifestSignaturePayload,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest';

const identity: BuildIdentity = {
  schema_version: 1,
  service: 'hustlexp-engine',
  revision: '00fb492f0c10ff23eb4db234f9dfbbb1e99b9ecf',
  built_at: '2026-07-22T10:23:48.000Z',
  environment: 'production',
  clean_source: true,
  source: 'test',
  artifact_digest: `sha256:${'e'.repeat(64)}`,
  artifact_verified: true,
};

const releaseManifest: ReleaseManifestV2 = {
  version: 2,
  environment: 'staging',
  releaseId: 'staging-20260826-001',
  createdAt: '2026-08-26T12:00:00.000Z',
  authority: {
    document: 'HustleXP Business and Universal V1 Charter',
    charterVersion: '1.1.0',
    charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
    capabilityPolicyDigest: `sha256:${'9'.repeat(64)}`,
  },
  components: {
    backend: {
      revision: identity.revision,
      artifactDigest: `sha256:${'d'.repeat(64)}`,
      imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
      imageDigest: `sha256:${'a'.repeat(64)}`,
    },
    worker: {
      revision: identity.revision,
      artifactDigest: identity.artifact_digest,
      imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
      imageDigest: `sha256:${'b'.repeat(64)}`,
    },
    web: {
      revision: 'f'.repeat(40),
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
      imageDigest: `sha256:${'c'.repeat(64)}`,
    },
    migration: { revision: identity.revision, artifactDigest: `sha256:${'b'.repeat(64)}` },
    policy: { revision: identity.revision, artifactDigest: `sha256:${'c'.repeat(64)}` },
    fixtures: {
      revision: identity.revision,
      artifactDigest: `sha256:${'d'.repeat(64)}`,
      providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
      providerImageDigest: `sha256:${'e'.repeat(64)}`,
      databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
      databaseImageDigest: `sha256:${'f'.repeat(64)}`,
    },
  },
  infrastructure: {
    revision: identity.revision,
    artifactDigest: `sha256:${'6'.repeat(64)}`,
    desiredTopologyDigest: `sha256:${'7'.repeat(64)}`,
  },
  databaseTargets: {
    api: {
      component: 'api',
      environment: 'staging',
      databaseTargetDigest: `sha256:${'8'.repeat(64)}`,
    },
    worker: {
      component: 'worker',
      environment: 'staging',
      databaseTargetDigest: `sha256:${'9'.repeat(64)}`,
    },
    attester: {
      component: 'attester',
      environment: 'staging',
      databaseTargetDigest: `sha256:${'a'.repeat(64)}`,
    },
  },
  capabilities: {
    financialProvider: 'fake',
    fakeFinancialEvents: true,
    customerMoneyCreation: false,
    hardAssignment: false,
    realSettlement: false,
    outboundCommunication: 'sink',
    dataClass: 'synthetic',
  },
  promotion: {
    baseManifestDigest: null,
    changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
    infrastructureChanged: true,
  },
  acceptance: {
    backend: { kind: 'http', component: 'backend', path: '/health' },
    worker: { kind: 'http', component: 'worker', path: '/health' },
    web: { kind: 'http', component: 'web', path: '/version.json' },
    migration: { kind: 'receipt', component: 'migration', receiptType: 'migration-execution-v1' },
    policy: { kind: 'receipt', component: 'policy', receiptType: 'canonical-policy-digest-v1' },
    fixtures: { kind: 'receipt', component: 'fixtures', receiptType: 'fixture-seed-v1' },
    infrastructure: {
      kind: 'readback',
      binding: 'infrastructure',
      receiptType: 'infrastructure-readback-v1',
    },
  },
};

const originalPromotionMode = process.env.HX_RELEASE_PROMOTION_MODE;
const TEST_KEY_ID = 'worker-health-test-release-authority';
const TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('4f'.repeat(32), 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const TEST_PUBLIC_KEY_PEM = createPublicKey(TEST_PRIVATE_KEY)
  .export({ type: 'spki', format: 'pem' })
  .toString();
const releaseDirectory = mkdtempSync(join(tmpdir(), 'hx-worker-health-release-'));
const releasePath = join(releaseDirectory, 'manifest.json');
const exactReleaseDigest = releaseManifestDigest(releaseManifest);
writeFileSync(releasePath, JSON.stringify(releaseManifest), 'utf8');
process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
const release: ReleaseManifestEvidence = readReleaseManifest(releasePath, {
  signatureRaw: JSON.stringify({
    version: 1,
    algorithm: 'ed25519',
    keyId: TEST_KEY_ID,
    manifestDigest: exactReleaseDigest,
    signature: sign(
      null,
      releaseManifestSignaturePayload(exactReleaseDigest, releaseManifest.version),
      TEST_PRIVATE_KEY
    ).toString('base64'),
  }),
  signatureSource: 'unit-test-detached-signature',
  trustedPublicKeys: { [TEST_KEY_ID]: TEST_PUBLIC_KEY_PEM },
});
if (originalPromotionMode === undefined) delete process.env.HX_RELEASE_PROMOTION_MODE;
else process.env.HX_RELEASE_PROMOTION_MODE = originalPromotionMode;

const handles: WorkerHealthServer[] = [];

async function create(options: Parameters<typeof startWorkerHealthServer>[0] = {}) {
  const handle = await startWorkerHealthServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    release,
    dependencyReadiness: async () => ({ database: 'ok', redis: 'ok' }),
    ...options,
  });
  handles.push(handle);
  const address = handle.server.address() as AddressInfo;
  return {
    handle,
    url: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  if (originalPromotionMode === undefined) delete process.env.HX_RELEASE_PROMOTION_MODE;
  else process.env.HX_RELEASE_PROMOTION_MODE = originalPromotionMode;
});

afterAll(() => {
  rmSync(releaseDirectory, { recursive: true, force: true });
});

describe('worker deployment health server', () => {
  it('keeps signed staging unavailable after every worker registers while promotion authority is held', async () => {
    process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
    const { handle, url } = await create({
      production: false,
      environment: 'staging',
      financialReadiness: async () => ({
        schemaVersion: 1,
        required: true,
        ready: true,
        status: 'ready',
        environment: 'staging',
        releaseId: releaseManifest.releaseId,
        releaseManifestDigest: release.digest,
        migrationArtifactDigest: releaseManifest.components.migration.artifactDigest,
        requiredMigrationCount: 130,
        fakeFinancialMigrationCount: 8,
        matchedFakeFinancialMigrationCount: 8,
        completedAt: '2026-08-30T12:00:00.000Z',
      }),
      providerEventReplayHealth: () => ({
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      }),
      fakeFinancialCommandRecoveryHealth: () => ({
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      }),
      workOrderCompensationHealth: () => ({
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      }),
      changeOrderRecoveryHealth: () => ({
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      }),
    });

    const starting = await fetch(`${url}/health`);
    expect(starting.status).toBe(503);
    expect(await starting.json()).toMatchObject({
      service: 'hustlexp-worker',
      state: 'starting',
      ready: false,
    });

    handle.markReady();
    const ready = await fetch(`${url}/health/readiness`);
    const readyBody = await ready.json();
    expect(ready.status).toBe(503);
    expect(readyBody).toMatchObject({
      service: 'hustlexp-worker',
      state: 'ready',
      ready: false,
      build: identity,
      releaseManifest: {
        status: 'invalid',
        digest: release.digest,
        authentication: { status: 'verified' },
        errors: [
          'manifest does not match the runtime service revision, artifact, version, or environment',
        ],
      },
      nonproductionFinancialBootstrap: {
        required: true,
        ready: true,
        status: 'ready',
        environment: 'staging',
      },
      dependencies: { database: 'ok', redis: 'ok' },
      providerEventReplay: {
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      },
      fakeFinancialCommandRecovery: {
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      },
      workOrderCompensation: {
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      },
      changeOrderRecovery: {
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      },
    });
  });

  it('fails closed when nonproduction fake-finance bootstrap evidence is not ready', async () => {
    const { handle, url } = await create({
      production: false,
      environment: 'local',
      financialReadiness: async () => ({
        schemaVersion: 1,
        required: true,
        ready: false,
        status: 'bootstrap_missing',
        environment: 'local',
        releaseId: 'test-local-release-0001',
        releaseManifestDigest: `sha256:${'d'.repeat(64)}`,
        migrationArtifactDigest: `sha256:${'b'.repeat(64)}`,
        requiredMigrationCount: 130,
        fakeFinancialMigrationCount: 4,
        matchedFakeFinancialMigrationCount: 0,
        completedAt: null,
      }),
    });
    handle.markReady();

    const response = await fetch(`${url}/health/readiness`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      state: 'ready',
      ready: false,
      nonproductionFinancialBootstrap: {
        required: true,
        ready: false,
        status: 'bootstrap_missing',
      },
      providerEventReplay: {
        status: 'degraded',
        lastFailureCode: 'WORKER_NOT_STARTED',
      },
      fakeFinancialCommandRecovery: {
        status: 'degraded',
        lastFailureCode: 'WORKER_NOT_STARTED',
      },
      workOrderCompensation: {
        status: 'degraded',
        lastFailureCode: 'WORKER_NOT_STARTED',
      },
      changeOrderRecovery: {
        status: 'degraded',
        lastFailureCode: 'WORKER_NOT_STARTED',
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      },
    });
  });

  it('requires the publisher and all four nonproduction financial pollers to report healthy', async () => {
    let publisherState: ReturnType<
      import('../../src/jobs/fake-financial-publisher-runtime.js').FakeFinancialPublisherHandle['status']
    > | null = null;
    let recoveryHealthy = false;
    let compensationHealthy = false;
    let changeOrderRecoveryHealthy = false;
    const { handle, url } = await create({
      production: false,
      environment: 'local',
      financialReadiness: async () => ({
        schemaVersion: 1,
        required: true,
        ready: true,
        status: 'ready',
        environment: 'local',
        releaseId: 'test-local-release-0001',
        releaseManifestDigest: `sha256:${'d'.repeat(64)}`,
        migrationArtifactDigest: `sha256:${'b'.repeat(64)}`,
        requiredMigrationCount: 130,
        fakeFinancialMigrationCount: 8,
        matchedFakeFinancialMigrationCount: 8,
        completedAt: '2026-08-30T12:00:00.000Z',
      }),
      providerEventReplayHealth: () => ({
        status: 'healthy',
        inFlight: false,
        consecutiveFailures: 0,
        lastFailureCode: null,
      }),
      fakeFinancialPublisherHealth: () => publisherState,
      fakeFinancialCommandRecoveryHealth: () => ({
        status: recoveryHealthy ? 'healthy' : 'degraded',
        inFlight: false,
        consecutiveFailures: recoveryHealthy ? 0 : 1,
        lastFailureCode: recoveryHealthy ? null : 'PERSISTENCE_ERRORS',
      }),
      workOrderCompensationHealth: () => ({
        status: compensationHealthy ? 'healthy' : 'degraded',
        inFlight: false,
        consecutiveFailures: compensationHealthy ? 0 : 1,
        lastFailureCode: compensationHealthy ? null : 'BATCH_INCOMPLETE',
      }),
      changeOrderRecoveryHealth: () => ({
        status: changeOrderRecoveryHealthy ? 'healthy' : 'degraded',
        inFlight: false,
        consecutiveFailures: changeOrderRecoveryHealthy ? 0 : 1,
        lastFailureCode: changeOrderRecoveryHealthy ? null : 'BATCH_INCOMPLETE',
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      }),
    });
    handle.markReady();

    const degraded = await fetch(`${url}/health/readiness`);
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toMatchObject({
      ready: false,
      providerEventReplay: { status: 'healthy' },
      fakeFinancialCommandRecovery: {
        status: 'degraded',
        lastFailureCode: 'PERSISTENCE_ERRORS',
      },
      workOrderCompensation: {
        status: 'degraded',
        lastFailureCode: 'BATCH_INCOMPLETE',
      },
      changeOrderRecovery: {
        status: 'degraded',
        lastFailureCode: 'BATCH_INCOMPLETE',
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      },
    });

    recoveryHealthy = true;
    const compensationStillDegraded = await fetch(`${url}/health/readiness`);
    expect(compensationStillDegraded.status).toBe(503);
    expect(await compensationStillDegraded.json()).toMatchObject({
      ready: false,
      providerEventReplay: { status: 'healthy' },
      fakeFinancialCommandRecovery: { status: 'healthy' },
      workOrderCompensation: {
        status: 'degraded',
        lastFailureCode: 'BATCH_INCOMPLETE',
      },
      changeOrderRecovery: { status: 'degraded' },
    });

    compensationHealthy = true;
    const changeOrderRecoveryStillDegraded = await fetch(`${url}/health/readiness`);
    expect(changeOrderRecoveryStillDegraded.status).toBe(503);
    expect(await changeOrderRecoveryStillDegraded.json()).toMatchObject({
      ready: false,
      workOrderCompensation: { status: 'healthy' },
      changeOrderRecovery: {
        status: 'degraded',
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      },
    });

    changeOrderRecoveryHealthy = true;
    const absentPublisher = await fetch(`${url}/health/readiness`);
    expect(absentPublisher.status).toBe(503);
    expect(await absentPublisher.json()).toMatchObject({
      fakeFinancialPublisher: { status: 'degraded', lastFailureCode: 'WORKER_NOT_STARTED' },
    });
    const successfulPublication = {
      claimed: 1,
      confirmed: 1,
      retryableFailures: 0,
      terminalFailures: 0,
      persistenceErrors: 0,
    };
    for (const status of [
      { stopped: false, running: false, consecutiveFailures: 1, lastResult: successfulPublication },
      { stopped: true, running: false, consecutiveFailures: 0, lastResult: successfulPublication },
      { stopped: false, running: false, consecutiveFailures: 0, lastResult: null },
      {
        stopped: false,
        running: false,
        consecutiveFailures: 0,
        lastResult: { ...successfulPublication, persistenceErrors: 1 },
      },
      {
        stopped: false,
        running: false,
        consecutiveFailures: 0,
        lastResult: { ...successfulPublication, retryableFailures: 1 },
      },
      {
        stopped: false,
        running: false,
        consecutiveFailures: 0,
        lastResult: { ...successfulPublication, terminalFailures: 1 },
      },
    ]) {
      publisherState = status;
      expect((await fetch(`${url}/health/readiness`)).status).toBe(503);
    }
    publisherState = {
      stopped: false,
      running: true,
      consecutiveFailures: 0,
      lastResult: successfulPublication,
    };
    const ready = await fetch(`${url}/health/readiness`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ready: true,
      providerEventReplay: { status: 'healthy' },
      fakeFinancialCommandRecovery: { status: 'healthy' },
      workOrderCompensation: { status: 'healthy' },
      changeOrderRecovery: {
        status: 'healthy',
        compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
        priorSecuredStateRestored: false,
        executionMayResumeAfterCompensation: false,
      },
    });
  });

  it('fails closed for an untrusted production build', async () => {
    const { handle, url } = await create({
      production: true,
      trustedIdentity: () => false,
    });
    handle.markReady();

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: 'ready', ready: false });
  });

  it.each([
    ['database', { database: 'unavailable' as const, redis: 'ok' as const }],
    ['redis', { database: 'ok' as const, redis: 'unavailable' as const }],
  ])('fails readiness when the %s dependency is unavailable', async (_name, dependencies) => {
    const { handle, url } = await create({
      production: true,
      dependencyReadiness: async () => dependencies,
    });
    handle.markReady();

    const response = await fetch(`${url}/health/readiness`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ready: false,
      dependencies,
    });
  });

  it('launches readiness probes concurrently and fails closed within a bounded deadline', async () => {
    let financialProbeStarted = false;
    let dependencyProbeStarted = false;
    const financialReadiness = vi.fn(() => {
      financialProbeStarted = true;
      return new Promise<never>(() => undefined);
    });
    const dependencyReadiness = vi.fn(() => {
      dependencyProbeStarted = true;
      return new Promise<never>(() => undefined);
    });
    const { handle, url } = await create({
      production: false,
      environment: 'local',
      readinessTimeoutMs: 25,
      financialReadiness,
      dependencyReadiness,
    });
    handle.markReady();

    const startedAt = Date.now();
    const response = await fetch(`${url}/health/readiness`);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(elapsedMs).toBeLessThan(500);
    expect(financialProbeStarted).toBe(true);
    expect(dependencyProbeStarted).toBe(true);
    expect(financialReadiness).toHaveBeenCalledTimes(1);
    expect(dependencyReadiness).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      ready: false,
      nonproductionFinancialBootstrap: {
        status: 'attestation_unavailable',
      },
      dependencies: {
        database: 'unavailable',
        redis: 'unavailable',
      },
    });
  });

  it.each([
    ['uppercase', 'PRODUCTION', undefined],
    ['surrounding whitespace', ' production ', undefined],
    ['conflicting explicit false', 'PRODUCTION', false],
  ])(
    'normalizes %s production identity and cannot downgrade its trust check',
    async (_caseName, environment, production) => {
      const { handle, url } = await create({
        environment,
        ...(production === undefined ? {} : { production }),
        trustedIdentity: () => false,
      });
      handle.markReady();

      const response = await fetch(`${url}/health/readiness`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        state: 'ready',
        ready: false,
        releaseManifest: { status: 'invalid' },
        nonproductionFinancialBootstrap: {
          required: false,
          status: 'disabled',
          environment: 'production',
        },
      });
    }
  );

  it('fails closed when the exact production manifest is missing or incompatible', async () => {
    const { handle, url } = await create({
      production: true,
      release: { ...release, status: 'unattributed', manifest: null, digest: 'unattributed' },
    });
    handle.markReady();

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: 'ready', ready: false });
  });

  it('withdraws readiness before graceful shutdown', async () => {
    const { handle, url } = await create({ production: true });
    handle.markReady();
    handle.markShuttingDown();

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      state: 'shutting_down',
      ready: false,
    });
  });

  it('keeps liveness process-only while exposing exact build and release identity', async () => {
    const dependencyReadiness = vi.fn(async () => ({
      database: 'unavailable' as const,
      redis: 'unavailable' as const,
    }));
    const { handle, url } = await create({ production: true, dependencyReadiness });

    const response = await fetch(`${url}/health/liveness`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alive: true,
      build: identity,
      releaseManifest: { status: 'invalid' },
    });
    expect(dependencyReadiness).not.toHaveBeenCalled();

    handle.markShuttingDown();
    expect((await fetch(`${url}/health/liveness`)).status).toBe(503);
  });

  it('rejects unsupported paths and methods without leaking runtime state', async () => {
    const { url } = await create({ production: false });

    const missing = await fetch(`${url}/metrics`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    const mutation = await fetch(`${url}/health`, { method: 'POST' });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get('allow')).toBe('GET');
  });
});
