import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  compose: vi.fn(),
  adapter: vi.fn(),
  attest: vi.fn(),
  plane: vi.fn(),
  install: vi.fn(),
  adapterClose: vi.fn(),
  planeClose: vi.fn(),
  globalClose: vi.fn(),
}));
vi.mock('../../src/db', () => ({
  installAttestedDatabaseRuntime: mocks.install,
  db: { close: mocks.globalClose },
}));
vi.mock('../../src/releaseManifest', () => ({
  releaseManifestEvidence: Object.freeze({ source: 'process' }),
}));
vi.mock('../../src/jobs/runtime-database-startup-config', () => ({
  configuredRuntimeDatabaseStartup: mocks.configured,
}));
vi.mock('../../src/jobs/runtime-database-release-authority', () => ({
  composeRuntimeDatabaseReleaseAuthority: mocks.compose,
}));
vi.mock('../../src/jobs/runtime-database-pg-adapter', () => ({
  createPgRuntimeDatabaseAuthorityAdapter: mocks.adapter,
}));
vi.mock('../../src/jobs/runtime-database-authority', () => ({
  attestRuntimeDatabaseAuthority: mocks.attest,
}));
vi.mock('../../src/jobs/runtime-database-data-plane', () => ({
  createRuntimeDatabaseDataPlane: mocks.plane,
}));

const configured = {
  primaryDatabaseUrl: 'postgresql://synthetic.invalid',
  replicaDatabaseUrl: null,
  expectedTarget: { environment: 'local' },
  target: { component: 'api' },
  targetDigest: 'exact-target',
  roleTopology: { apiRole: 'synthetic-api' },
  poolConfig: { max: 2 },
};
const verifier = Object.freeze({ verifyReleaseAuthority: vi.fn() });
const pins = Object.freeze({ manifestDigest: 'exact-manifest' });
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.configured.mockReturnValue(configured);
  mocks.compose.mockReturnValue({
    environment: 'local',
    databaseTargetDigest: 'exact-target',
    releasePins: pins,
    verifier,
  });
  mocks.adapterClose.mockResolvedValue(undefined);
  mocks.planeClose.mockResolvedValue(undefined);
  mocks.adapter.mockReturnValue({ close: mocks.adapterClose });
  mocks.attest.mockResolvedValue({ genuine: 'mock-issued-for-composition-test' });
  mocks.plane.mockReturnValue({ close: mocks.planeClose });
});
describe('process-owned database startup installer', () => {
  it.each(['api', 'worker', 'attester'] as const)(
    'composes and installs %s authority before returning a close handle',
    async (component) => {
      const { installConfiguredRuntimeDatabase } =
        await import('../../src/jobs/install-runtime-database');
      const installed = await installConfiguredRuntimeDatabase(component);
      expect(mocks.configured).toHaveBeenCalledWith(component);
      expect(mocks.compose).toHaveBeenCalledWith({ source: 'process' }, component);
      expect(mocks.attest).toHaveBeenCalledWith(
        {
          component,
          primaryDatabaseUrl: configured.primaryDatabaseUrl,
          replicaDatabaseUrl: null,
          expectedTarget: configured.expectedTarget,
          expectedTargetDigest: 'exact-target',
          roleTopology: configured.roleTopology,
          releasePins: pins,
        },
        { close: mocks.adapterClose },
        verifier
      );
      expect(mocks.attest.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.plane.mock.invocationCallOrder[0]!
      );
      expect(mocks.plane.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.install.mock.invocationCallOrder[0]!
      );
      expect(mocks.adapterClose).not.toHaveBeenCalled();
      await installed.close();
      expect(mocks.planeClose).toHaveBeenCalledOnce();
      expect(mocks.globalClose).not.toHaveBeenCalled();
    }
  );
  it.each(['environment', 'databaseTargetDigest'])(
    'rejects mismatched release %s before creating a pool',
    async (field) => {
      mocks.compose.mockReturnValue({
        environment: 'local',
        databaseTargetDigest: 'exact-target',
        [field]: 'wrong',
      });
      const { installConfiguredRuntimeDatabase } =
        await import('../../src/jobs/install-runtime-database');
      await expect(installConfiguredRuntimeDatabase('api')).rejects.toThrow(
        'RELEASE_TARGET_MISMATCH'
      );
      expect(mocks.adapter).not.toHaveBeenCalled();
    }
  );
  it.each(['attest', 'plane', 'install'] as const)(
    'cleans only this attempt after %s fails',
    async (boundary) => {
      const failure = new Error('EXPECTED_FAILURE');
      if (boundary === 'attest') mocks.attest.mockRejectedValueOnce(failure);
      else
        mocks[boundary].mockImplementationOnce(() => {
          throw failure;
        });
      const { installConfiguredRuntimeDatabase } =
        await import('../../src/jobs/install-runtime-database');
      await expect(installConfiguredRuntimeDatabase('api')).rejects.toBe(failure);
      expect(boundary === 'install' ? mocks.planeClose : mocks.adapterClose).toHaveBeenCalledOnce();
      expect(mocks.globalClose).not.toHaveBeenCalled();
    }
  );
  it('preserves original and cleanup failures without retrying installation', async () => {
    const original = new Error('ATTEST_FAILED');
    const cleanup = new Error('CLOSE_FAILED');
    mocks.attest.mockRejectedValueOnce(original);
    mocks.adapterClose.mockRejectedValueOnce(cleanup);
    const { installConfiguredRuntimeDatabase } =
      await import('../../src/jobs/install-runtime-database');
    const result = await installConfiguredRuntimeDatabase('api').catch((error) => error);
    expect(result.errors).toEqual([original, cleanup]);
    await expect(installConfiguredRuntimeDatabase('api')).rejects.toThrow('ALREADY_ATTEMPTED');
    expect(mocks.adapter).toHaveBeenCalledOnce();
  });
  it('rejects concurrent/duplicate attempts without touching the live installation', async () => {
    let finish!: (value: unknown) => void;
    mocks.attest.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { installConfiguredRuntimeDatabase } =
      await import('../../src/jobs/install-runtime-database');
    const first = installConfiguredRuntimeDatabase('api');
    await expect(installConfiguredRuntimeDatabase('worker')).rejects.toThrow('ALREADY_ATTEMPTED');
    finish({ capability: true });
    await first;
    await expect(installConfiguredRuntimeDatabase('api')).rejects.toThrow('ALREADY_ATTEMPTED');
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.adapterClose).not.toHaveBeenCalled();
    expect(mocks.planeClose).not.toHaveBeenCalled();
  });
});
