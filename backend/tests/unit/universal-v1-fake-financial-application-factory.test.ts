import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const moduleDatabase = {
    query: vi.fn(),
    readQuery: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
    healthCheck: vi.fn(),
    getPool: vi.fn(),
    getPoolStats: vi.fn(),
    close: vi.fn(),
  };
  const liveCapability = Object.freeze({
    databaseTarget: `sha256:${'a'.repeat(64)}`,
    environment: 'local' as const,
  });
  return {
    moduleDatabase,
    liveCapability,
    provider: { providerKind: 'FAKE' },
    assertAuthorized: vi.fn(),
    issueCapability: vi.fn(),
    consumeCapability: vi.fn(),
    repositoryDatabases: [] as unknown[],
  };
});

vi.mock('../../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db.js')>();
  return { ...actual, db: mocks.moduleDatabase };
});

vi.mock('../../src/buildIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/buildIdentity.js')>();
  return {
    ...actual,
    buildIdentity: Object.freeze({
      schema_version: 1,
      service: 'hustlexp-engine',
      revision: '1'.repeat(40),
      built_at: '2026-08-31T00:00:00.000Z',
      environment: 'local',
      clean_source: true,
      source: 'unit-test-module-measurement',
      artifact_digest: `sha256:${'b'.repeat(64)}`,
      artifact_verified: true,
    }),
  };
});

vi.mock('../../src/releaseManifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/releaseManifest.js')>();
  return {
    ...actual,
    readReleaseManifest: vi.fn(() => ({
      schema_version: 1,
      status: 'valid',
      digest: `sha256:${'c'.repeat(64)}`,
      source: 'unit-test-module-release',
      errors: [],
      manifest: null,
    })),
  };
});

vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/services/payment/NonproductionFinancialAuthorization.js')
  >();
  return {
    ...actual,
    assertNonproductionFakeFinanceAuthorized: mocks.assertAuthorized,
  };
});

vi.mock('../../src/services/payment/FakeFinancialProvider.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/services/payment/FakeFinancialProvider.js')
  >();
  return {
    ...actual,
    issueLiveFakeFinancialDatabaseCapability: mocks.issueCapability,
    createDatabaseBackedFakeFinancialProvider: mocks.consumeCapability,
    PostgresFakeFinancialOperationRepository: class {
      constructor(database: unknown) {
        mocks.repositoryDatabases.push(database);
      }
    },
  };
});

import {
  createUniversalV1FakeFinancialApplicationService,
  UniversalV1FakeFinancialApplicationService,
} from '../../src/services/payment/UniversalV1FinancialApplicationService.js';

describe('Universal V1 runtime fake-finance application factory authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoryDatabases.length = 0;
    mocks.issueCapability.mockResolvedValue(mocks.liveCapability);
    mocks.consumeCapability.mockReturnValue(mocks.provider);
    vi.stubEnv('SERVICE_ROLE', 'backend');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('rejects arbitrary database and evidence arguments before any authority check', async () => {
    const arbitraryDatabase = { query: vi.fn() };
    const callerShapedFactory = createUniversalV1FakeFinancialApplicationService as unknown as (
      ...args: readonly unknown[]
    ) => Promise<UniversalV1FakeFinancialApplicationService>;

    await expect(
      callerShapedFactory(
        arbitraryDatabase,
        { HX_ENVIRONMENT: 'local' },
        { status: 'valid', digest: `sha256:${'d'.repeat(64)}` },
        { revision: '2'.repeat(40) }
      )
    ).rejects.toThrow(
      'NONPRODUCTION_FAKE_FINANCE_REFUSED:CALLER_SHAPED_APPLICATION_FACTORY_INPUT'
    );
    expect(mocks.assertAuthorized).not.toHaveBeenCalled();
    expect(mocks.issueCapability).not.toHaveBeenCalled();
    expect(mocks.consumeCapability).not.toHaveBeenCalled();
    expect(mocks.repositoryDatabases).toEqual([]);
  });

  it('constructs only after the exact one-use live capability is issued and consumed', async () => {
    const service = await createUniversalV1FakeFinancialApplicationService();

    expect(service).toBeInstanceOf(UniversalV1FakeFinancialApplicationService);
    expect(mocks.assertAuthorized).toHaveBeenCalledWith({ component: 'backend' });
    expect(mocks.issueCapability).toHaveBeenCalledWith({ component: 'backend' });
    expect(mocks.consumeCapability).toHaveBeenCalledWith(mocks.liveCapability);
    expect(mocks.consumeCapability).toHaveBeenCalledTimes(1);
    expect(mocks.repositoryDatabases).toEqual([mocks.moduleDatabase]);
  });

  it('does not construct persistence when live database readback refuses authority', async () => {
    mocks.issueCapability.mockRejectedValueOnce(
      new Error('NONPRODUCTION_FAKE_FINANCE_REFUSED:LIVE_FAKE_FINANCE_SCHEMA_REQUIRED')
    );

    await expect(createUniversalV1FakeFinancialApplicationService()).rejects.toThrow(
      'NONPRODUCTION_FAKE_FINANCE_REFUSED:LIVE_FAKE_FINANCE_SCHEMA_REQUIRED'
    );
    expect(mocks.consumeCapability).not.toHaveBeenCalled();
    expect(mocks.repositoryDatabases).toEqual([]);
  });
});
