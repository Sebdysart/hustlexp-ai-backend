import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  isolation: vi.fn(),
  validate: vi.fn(),
  install: vi.fn(),
  close: vi.fn(),
  query: vi.fn(),
  migrations: vi.fn(),
}));
vi.mock('../../src/auth/universal-v1-actor-attestation-runtime-boundary', () => ({
  assertApiActorAttesterCredentialIsolation: m.isolation,
}));
vi.mock('../../src/config', () => ({
  validateConfig: m.validate,
  config: { database: {}, firebase: {}, stripe: {}, redis: {}, app: {} },
}));
vi.mock('../../src/jobs/install-runtime-database', () => ({
  installConfiguredRuntimeDatabase: m.install,
}));
vi.mock('../../src/db', () => ({ db: { query: m.query, readQuery: m.query } }));
vi.mock('../../src/logger', () => ({ logger: { child: () => ({ info: vi.fn() }) } }));
vi.mock('../../src/serverStartupMigrations', () => ({
  runStartupMigrations: m.migrations,
  productionStartupMigrationRuntime: () => ({}),
}));
import { startServer } from '../../src/serverStartup';
beforeEach(() => {
  vi.resetAllMocks();
  m.close.mockResolvedValue(undefined);
  m.install.mockResolvedValue({ close: m.close });
  m.query.mockResolvedValue({ rows: [] });
  m.migrations.mockResolvedValue(undefined);
});
describe('API database startup wiring', () => {
  it('installs after credential/config checks and before any facade query', async () => {
    const started = await startServer();
    expect(m.isolation.mock.invocationCallOrder[0]).toBeLessThan(
      m.validate.mock.invocationCallOrder[0]!
    );
    expect(m.validate.mock.invocationCallOrder[0]).toBeLessThan(
      m.install.mock.invocationCallOrder[0]!
    );
    expect(m.install).toHaveBeenCalledWith('api');
    expect(m.install.mock.invocationCallOrder[0]).toBeLessThan(
      m.query.mock.invocationCallOrder[0]!
    );
    expect(m.close).not.toHaveBeenCalled();
    await started.closeDatabase();
    expect(m.close).toHaveBeenCalledOnce();
  });
  it('does not query or close another runtime after installation refusal', async () => {
    m.install.mockRejectedValueOnce(new Error('INSTALL_REFUSED'));
    await expect(startServer()).rejects.toThrow('INSTALL_REFUSED');
    expect(m.query).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
  });
  it.each(['query', 'migrations'] as const)(
    'closes its installed runtime after %s fails',
    async (boundary) => {
      m[boundary].mockRejectedValueOnce(new Error('STARTUP_FAILURE'));
      await expect(startServer()).rejects.toThrow('STARTUP_FAILURE');
      expect(m.close).toHaveBeenCalledOnce();
    }
  );
});
