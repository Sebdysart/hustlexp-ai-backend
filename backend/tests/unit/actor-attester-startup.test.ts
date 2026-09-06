import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  issuer: vi.fn(),
  readiness: vi.fn(),
  issuerClose: vi.fn(),
  app: vi.fn(),
  release: vi.fn(),
  install: vi.fn(),
  databaseClose: vi.fn(),
  globalClose: vi.fn(),
  readQuery: vi.fn(),
  migrations: vi.fn(),
  migrationRuntime: vi.fn(),
}));
vi.mock('../../src/db', () => ({ db: { readQuery: mocks.readQuery, close: mocks.globalClose } }));
vi.mock('../../src/logger', () => ({ logger: { child: () => ({ info: vi.fn() }) } }));
vi.mock('../../src/releaseManifest', () => ({
  releaseManifestEvidence: { source: 'process-owned' },
}));
vi.mock('../../src/jobs/install-runtime-database', () => ({
  installConfiguredRuntimeDatabase: mocks.install,
}));
vi.mock('../../src/serverStartupMigrations', () => ({
  productionStartupMigrationRuntime: mocks.migrationRuntime,
  runStartupMigrations: mocks.migrations,
}));
vi.mock('../../src/services/UniversalV1ActorAssertionIssuer', () => ({
  PostgresUniversalV1ActorAssertionIssuer: mocks.issuer,
}));
vi.mock('../../src/services/UniversalV1ActorAttesterService', () => ({
  createUniversalV1ActorAttesterApp: mocks.app,
}));
vi.mock('../../src/services/UniversalV1ActorAttestationReleaseAuthority', () => ({
  resolveUniversalV1ActorReleaseBinding: mocks.release,
}));
import { startActorAttester } from '../../src/actor-attester-startup.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ACTOR_ATTESTER_PORT', '3002');
  mocks.issuer.mockImplementation(function () {
    return { readiness: mocks.readiness, close: mocks.issuerClose };
  });
  mocks.issuerClose.mockResolvedValue(undefined);
  mocks.app.mockReturnValue({ fetch: vi.fn() });
  mocks.release.mockReturnValue({ environment: 'local' });
  mocks.install.mockResolvedValue({ close: mocks.databaseClose });
  mocks.databaseClose.mockResolvedValue(undefined);
  mocks.migrations.mockResolvedValue(undefined);
  mocks.migrationRuntime.mockReturnValue({ exact: 'production-runtime' });
  mocks.readiness.mockResolvedValue({ databaseRole: 'synthetic-attester' });
});
afterEach(() => vi.unstubAllEnvs());

describe('actor-attester process startup', () => {
  it.each(['local', 'staging'] as const)(
    'installs %s authority and verifies migrations/issuer before returning a listener handle',
    async (environment) => {
      mocks.release.mockReturnValue({ environment });
      const startup = await startActorAttester();
      expect(startup).toMatchObject({
        port: 3002,
        hostname: environment === 'local' ? '127.0.0.1' : '0.0.0.0',
      });
      expect(startup.app).toBe(mocks.app.mock.results[0]!.value);
      expect(mocks.release).toHaveBeenCalledWith(process.env, { source: 'process-owned' });
      const appReleaseBinding = mocks.app.mock.calls[0]![0].releaseBinding;
      appReleaseBinding();
      expect(mocks.release.mock.calls).toEqual([
        [process.env, { source: 'process-owned' }],
        [process.env, { source: 'process-owned' }],
      ]);
      expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.install.mock.invocationCallOrder[0]!
      );
      expect(mocks.install).toHaveBeenCalledWith('attester');
      expect(mocks.install.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.migrations.mock.invocationCallOrder[0]!
      );
      expect(mocks.migrationRuntime).toHaveBeenCalledWith(mocks.readQuery);
      expect(mocks.migrations).toHaveBeenCalledWith(expect.anything(), {
        exact: 'production-runtime',
      });
      expect(mocks.migrations.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.readiness.mock.invocationCallOrder[0]!
      );
      expect(mocks.databaseClose).not.toHaveBeenCalled();
      await startup.closeDatabase();
      expect(mocks.issuerClose).toHaveBeenCalledOnce();
      expect(mocks.databaseClose).toHaveBeenCalledOnce();
      expect(mocks.globalClose).not.toHaveBeenCalled();
    }
  );
  it.each(['issuer', 'app', 'release'] as const)(
    'rejects %s configuration before a pool installation is attempted',
    async (boundary) => {
      mocks[boundary].mockImplementationOnce(function () {
        throw new Error('CONFIGURATION_HELD');
      });
      await expect(startActorAttester()).rejects.toThrow('CONFIGURATION_HELD');
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.readiness).not.toHaveBeenCalled();
    }
  );
  it.each(['1023', '65536', '3e3', '-3002', '3002.1'])(
    'rejects invalid port %s before constructing an issuer',
    async (port) => {
      vi.stubEnv('ACTOR_ATTESTER_PORT', port);
      await expect(startActorAttester()).rejects.toThrow('PORT_INVALID');
      expect(mocks.issuer).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    }
  );
  it('does not close another installation after installer rejection', async () => {
    mocks.install.mockRejectedValueOnce(new Error('ALREADY_INSTALLED'));
    await expect(startActorAttester()).rejects.toThrow('ALREADY_INSTALLED');
    expect(mocks.migrations).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.databaseClose).not.toHaveBeenCalled();
    expect(mocks.globalClose).not.toHaveBeenCalled();
  });
  it.each(['migrations', 'readiness'] as const)(
    'closes only owned resources after %s failure',
    async (boundary) => {
      mocks[boundary].mockRejectedValueOnce(new Error('ATTESTATION_HELD'));
      await expect(startActorAttester()).rejects.toThrow('ATTESTATION_HELD');
      expect(mocks.issuerClose).toHaveBeenCalledOnce();
      expect(mocks.databaseClose).toHaveBeenCalledOnce();
      expect(mocks.globalClose).not.toHaveBeenCalled();
    }
  );
  it('preserves both the startup and cleanup errors', async () => {
    const original = new Error('ATTESTATION_HELD');
    const cleanup = new Error('OWNED_POOL_CLOSE_FAILED');
    mocks.readiness.mockRejectedValueOnce(original);
    mocks.databaseClose.mockRejectedValueOnce(cleanup);
    const outcome = await startActorAttester().catch((error) => error);
    expect(outcome.errors).toEqual([original, cleanup]);
  });
});
