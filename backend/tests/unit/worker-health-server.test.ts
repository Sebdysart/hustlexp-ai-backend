import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildIdentity } from '../../src/buildIdentity';
import {
  startWorkerHealthServer,
  type WorkerHealthServer,
} from '../../src/jobs/worker-health-server';
import type { ReleaseManifestEvidence } from '../../src/releaseManifest';

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

const release: ReleaseManifestEvidence = {
  schema_version: 1,
  status: 'valid',
  digest: `sha256:${'d'.repeat(64)}`,
  source: 'test',
  errors: [],
  authentication: {
    status: 'verified',
    algorithm: 'ed25519',
    keyId: 'unit-test-release-authority',
    keyFingerprint: `sha256:${'c'.repeat(64)}`,
    signatureDigest: `sha256:${'f'.repeat(64)}`,
    source: 'unit-test-detached-signature',
    errors: [],
  },
  manifest: {
    version: 1,
    environment: 'production',
    releaseId: 'production-20260826-001',
    createdAt: '2026-08-26T12:00:00.000Z',
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
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: `sha256:${'e'.repeat(64)}`,
      },
    },
    capabilities: {
      financialProvider: 'disabled',
      fakeFinancialEvents: false,
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication: 'bounded_live',
      dataClass: 'approved_customer',
    },
    promotion: {
      baseManifestDigest: null,
      changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
    },
    health: {
      backend: { component: 'backend', path: '/health' },
      worker: { component: 'worker', path: '/health' },
      web: { component: 'web', path: '/version.json' },
    },
  },
};

const handles: WorkerHealthServer[] = [];

async function create(options: Parameters<typeof startWorkerHealthServer>[0] = {}) {
  const handle = await startWorkerHealthServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    release,
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
  await Promise.allSettled(handles.splice(0).map(handle => handle.close()));
});

describe('worker deployment health server', () => {
  it('stays unavailable until every worker and schedule has registered', async () => {
    const { handle, url } = await create({ production: true });

    const starting = await fetch(`${url}/health`);
    expect(starting.status).toBe(503);
    expect(await starting.json()).toMatchObject({
      service: 'hustlexp-worker',
      state: 'starting',
      ready: false,
    });

    handle.markReady();
    const ready = await fetch(`${url}/health/readiness`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      service: 'hustlexp-worker',
      state: 'ready',
      ready: true,
      build: identity,
      releaseManifest: { ...release, status: 'compatible' },
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
