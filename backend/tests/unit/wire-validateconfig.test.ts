/**
 * validateConfig boot-wiring tests
 *
 * Proves the wiring fix that supersedes PR #232:
 *   - validateConfig() is NOT called inside startWorkers(), so direct
 *     startWorkers() unit calls (e.g. scheduled-jobs.test.ts, which mocks
 *     '../config' WITHOUT a validateConfig export) cannot throw
 *     "validateConfig is not a function". This was the exact #232 regression.
 *   - validateConfig() IS called by the worker process-entry guard
 *     (bootWorkerProcess), giving fail-fast on real worker boot.
 *
 * validateConfig()'s own env-matrix behavior (test/dev no-exit, production
 * fail-fast, valid-prod passes, TAX key format) is covered in config.test.ts.
 *
 * @see backend/src/jobs/workers.ts (bootWorkerProcess + entry guard)
 * @see backend/src/config.ts (validateConfig)
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted spy so vi.mock('../../src/config') and the tests share one reference.
const validateConfigSpy = vi.hoisted(() => vi.fn());
const publisherHandle = vi.hoisted(() => ({
  ready: Promise.resolve(),
  status: vi.fn(() => ({
    stopped: false,
    running: false,
    consecutiveFailures: 0,
    lastResult: {
      claimed: 0,
      confirmed: 0,
      retryableFailures: 0,
      terminalFailures: 0,
      persistenceErrors: 0,
    },
  })),
  stop: vi.fn().mockResolvedValue(undefined),
}));
const startPublisherSpy = vi.hoisted(() => vi.fn(() => publisherHandle));
vi.mock('../../src/jobs/fake-financial-publisher-runtime', () => ({
  startFakeFinancialOutboxPublisher: startPublisherSpy,
}));
const installedDatabaseClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const installDatabaseSpy = vi.hoisted(() => vi.fn(async () => ({ close: installedDatabaseClose })));
vi.mock('../../src/jobs/install-runtime-database', () => ({
  installConfiguredRuntimeDatabase: installDatabaseSpy,
}));
const workerHealthHandle = vi.hoisted(() => ({
  markReady: vi.fn(),
  markShuttingDown: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));
const startWorkerHealthServerSpy = vi.hoisted(() =>
  vi.fn(
    async (
      _options?: Required<
        NonNullable<
          Parameters<
            typeof import('../../src/jobs/worker-health-server.js').startWorkerHealthServer
          >[0]
        >
      >
    ) => workerHealthHandle
  )
);
const replayHandle = vi.hoisted(() => ({
  workerId: 'provider-event-replay:unit',
  interval: {} as NodeJS.Timeout,
  health: vi.fn(() => ({
    status: 'healthy' as const,
    inFlight: false,
    consecutiveFailures: 0,
    lastFailureCode: null,
  })),
  stop: vi.fn().mockResolvedValue(undefined),
}));
const startProviderEventReplayWorkerSpy = vi.hoisted(() => vi.fn(() => replayHandle));
const recoveryHandle = vi.hoisted(() => ({
  workerId: 'fake-financial-recovery:unit',
  ready: Promise.resolve(),
  interval: {} as NodeJS.Timeout,
  health: vi.fn(() => ({
    status: 'healthy' as const,
    inFlight: false,
    consecutiveFailures: 0,
    lastFailureCode: null,
  })),
  stop: vi.fn().mockResolvedValue(undefined),
}));
const startFakeFinancialRecoveryPollerSpy = vi.hoisted(() => vi.fn(() => recoveryHandle));
const fakeFinancialProviderConstructorSpy = vi.hoisted(() => vi.fn());
const legacyExpiryCompensationConstructorSpy = vi.hoisted(() => vi.fn());
const legacyExpiryCompensationInstances = vi.hoisted(() => [] as unknown[]);
const fakeFinancialRecoveryWorkerConstructorSpy = vi.hoisted(() => vi.fn());
const compensationHandle = vi.hoisted(() => ({
  workerId: 'work-order-compensation:unit',
  interval: {} as NodeJS.Timeout,
  health: vi.fn(() => ({
    status: 'healthy' as const,
    inFlight: false,
    consecutiveFailures: 0,
    lastFailureCode: null,
  })),
  stop: vi.fn().mockResolvedValue(undefined),
}));
const startWorkOrderCompensationPollerSpy = vi.hoisted(() =>
  vi.fn(
    (_interval?: number, _dependencies?: { assertAuthorized: () => void }) => compensationHandle
  )
);
const changeOrderRecoveryHandle = vi.hoisted(() => ({
  workerId: 'change-order-recovery:unit',
  interval: {} as NodeJS.Timeout,
  health: vi.fn(() => ({
    status: 'healthy' as const,
    inFlight: false,
    consecutiveFailures: 0,
    lastFailureCode: null,
    compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED' as const,
    priorSecuredStateRestored: false as const,
    executionMayResumeAfterCompensation: false as const,
  })),
  stop: vi.fn().mockResolvedValue(undefined),
}));
const startChangeOrderRecoveryPollerSpy = vi.hoisted(() => vi.fn(() => changeOrderRecoveryHandle));
const assertNonproductionFakeFinanceAuthorizedSpy = vi.hoisted(() => vi.fn());
const financialBootstrapReadinessSpy = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ready: true,
    status: 'ready',
  })
);

// ── Mock workers.ts's heavy module-load dependencies (mirrors scheduled-jobs.test.ts) ──
vi.mock('../../src/jobs/queues', () => {
  const mockQueue = (name: string) => ({ name, add: vi.fn(async () => ({ id: `mock-${name}` })) });
  const queues: Record<string, ReturnType<typeof mockQueue>> = {};
  return {
    getQueue: vi.fn((name: string) => (queues[name] ??= mockQueue(name))),
    enqueueRepeatableJob: vi.fn(async (queueName: string, jobName: string) => ({
      id: `mock-${queueName}-${jobName}`,
    })),
    createWorker: vi.fn(() => ({ name: 'mock-worker', close: vi.fn() })),
    Queue: class {},
    Worker: class {},
  };
});

vi.mock('../../src/jobs/outbox-worker', () => ({ startOutboxWorker: vi.fn() }));
vi.mock('../../src/lib/redis-runtime-shutdown', () => ({
  closeRedisRuntime: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/serverStartupMigrations', () => ({
  productionStartupMigrationRuntime: vi.fn(() => ({})),
  runStartupMigrations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/jobs/worker-health-server', () => ({
  startWorkerHealthServer: startWorkerHealthServerSpy,
}));
vi.mock('../../src/jobs/provider-event-replay-worker', () => ({
  startProviderEventReplayWorker: startProviderEventReplayWorkerSpy,
}));
vi.mock('../../src/jobs/fake-financial-durable-recovery-runtime', () => ({
  ExactFakeFinancialCommandRecoveryExecutor: class {},
  NonproductionFakeFinancialCommandRecoveryWorker: class {
    constructor(...args: unknown[]) {
      fakeFinancialRecoveryWorkerConstructorSpy(...args);
    }
  },
  startFakeFinancialDurableRecovery: startFakeFinancialRecoveryPollerSpy,
}));
vi.mock('../../src/jobs/universal-v1-work-order-compensation-worker', () => ({
  PostgresUniversalV1WorkOrderCompensationRepository: class {},
  UniversalV1WorkOrderCompensationWorker: class {},
  startUniversalV1WorkOrderCompensationPoller: startWorkOrderCompensationPollerSpy,
}));
vi.mock('../../src/jobs/universal-v1-change-order-recovery-worker', () => ({
  UniversalV1ChangeOrderRecoveryWorker: class {},
  startUniversalV1ChangeOrderRecoveryPoller: startChangeOrderRecoveryPollerSpy,
}));
vi.mock('../../src/services/UniversalV1ChangeOrderRecovery', () => ({
  PostgresUniversalV1ChangeOrderRecoveryRepository: class {},
  UniversalV1ChangeOrderRecoveryService: class {},
}));
vi.mock('../../src/services/UniversalV1ChangeOrderPostgresRepository', () => ({
  PostgresUniversalV1ChangeOrderRepository: class {},
}));
vi.mock('../../src/services/payment/UniversalV1FinancialApplicationService', () => ({
  createUniversalV1FakeFinancialApplicationService: vi.fn(),
}));
vi.mock('../../src/services/payment/FakeFinancialProvider', () => ({
  FakeFinancialProvider: class {
    constructor(...args: unknown[]) {
      fakeFinancialProviderConstructorSpy(...args);
    }
  },
  PostgresFakeFinancialOperationRepository: class {},
}));
vi.mock('../../src/services/payment/LegacyFakeFinancialExpiryCompensation', () => ({
  LegacyFakeFinancialExpiryCompensationWorker: class {
    constructor(...args: unknown[]) {
      legacyExpiryCompensationConstructorSpy(...args);
      legacyExpiryCompensationInstances.push(this);
    }
  },
  PostgresLegacyFakeFinancialExpiryCompensationRepository: class {},
}));
vi.mock('../../src/services/payment/FinancialProviderCommandRecovery', () => ({
  PostgresFinancialProviderCommandRecoveryRepository: class {},
}));
vi.mock('../../src/services/payment/NonproductionFinancialAuthorization', () => ({
  assertNonproductionFakeFinanceAuthorized: assertNonproductionFakeFinanceAuthorizedSpy,
}));
vi.mock('../../src/services/payment/NonproductionFinancialBootstrapReadiness', () => ({
  readNonproductionFinancialBootstrapReadiness: financialBootstrapReadinessSpy,
}));
vi.mock('../../src/buildIdentity', () => ({ buildIdentity: { revision: 'unit' } }));
vi.mock('../../src/releaseManifest', () => ({
  readReleaseManifest: vi.fn(() => ({ status: 'valid' })),
}));
vi.mock('../../src/jobs/export-worker', () => ({ processExportJob: vi.fn() }));
vi.mock('../../src/jobs/email-worker', () => ({ processEmailJob: vi.fn() }));
vi.mock('../../src/jobs/biometric-analyzer-worker', () => ({
  processBiometricAnalysisJob: vi.fn(),
}));
vi.mock('../../src/jobs/expertise-recalc-worker', () => ({ processExpertiseRecalcJob: vi.fn() }));
vi.mock('../../src/jobs/xp-tax-reminder-worker', () => ({ processXPTaxReminderJob: vi.fn() }));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  workerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));

// Crucially: this mock DOES export validateConfig (as a spy). The fix must ensure
// startWorkers() never touches it, while bootWorkerProcess() does.
vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: null },
    redis: { url: 'redis://localhost:6379' },
    firebase: { projectId: null, clientEmail: null, privateKey: null },
  },
  validateConfig: validateConfigSpy,
}));

vi.mock('../../src/services/PushNotificationService', () => ({
  sendPushNotification: vi.fn().mockResolvedValue({ success: true }),
}));

describe('validateConfig boot wiring (supersedes #232)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    legacyExpiryCompensationInstances.length = 0;
    validateConfigSpy.mockReset();
    startWorkerHealthServerSpy.mockImplementation(async () => workerHealthHandle);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('startWorkers() does NOT invoke validateConfig (direct unit calls stay safe)', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();
    // This is the #232 regression guard: a direct startWorkers() call must never
    // reach validateConfig, so a config mock lacking the export can't break it.
    expect(validateConfigSpy).not.toHaveBeenCalled();
  });

  it('bootWorkerProcess() invokes validateConfig before starting workers', async () => {
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await bootWorkerProcess();
    expect(validateConfigSpy).toHaveBeenCalledTimes(1);
    expect(installDatabaseSpy).toHaveBeenCalledWith('worker');
    expect(validateConfigSpy.mock.invocationCallOrder[0]).toBeLessThan(
      installDatabaseSpy.mock.invocationCallOrder[0]!
    );
    expect(installDatabaseSpy.mock.invocationCallOrder[0]).toBeLessThan(
      startWorkerHealthServerSpy.mock.invocationCallOrder[0]!
    );
    expect(startWorkerHealthServerSpy).toHaveBeenCalledTimes(1);
    expect(workerHealthHandle.markReady).toHaveBeenCalledTimes(1);
  });

  it('bootWorkerProcess() surfaces a validateConfig failure (fail-fast)', async () => {
    validateConfigSpy.mockImplementationOnce(() => {
      throw new Error('FATAL config');
    });
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('FATAL config');
    expect(startWorkerHealthServerSpy).not.toHaveBeenCalled();
    expect(installDatabaseSpy).not.toHaveBeenCalled();
  });
  it('does not open health or workers when database installation fails', async () => {
    installDatabaseSpy.mockRejectedValueOnce(new Error('DATABASE_AUTHORITY_REFUSED'));
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('DATABASE_AUTHORITY_REFUSED');
    expect(startWorkerHealthServerSpy).not.toHaveBeenCalled();
    expect(installedDatabaseClose).not.toHaveBeenCalled();
  });
  it('closes the newly installed database after health startup fails', async () => {
    startWorkerHealthServerSpy.mockRejectedValueOnce(new Error('HEALTH_BIND_FAILED'));
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('HEALTH_BIND_FAILED');
    expect(installedDatabaseClose).toHaveBeenCalledOnce();
    expect(workerHealthHandle.markReady).not.toHaveBeenCalled();
  });

  it.each(['local', 'preview', 'staging'])(
    'starts all four financial pollers in %s only after exact bootstrap readiness',
    async (environment) => {
      vi.stubEnv('HX_ENVIRONMENT', environment);
      const { bootWorkerProcess } = await import('../../src/jobs/workers');

      await bootWorkerProcess();

      expect(financialBootstrapReadinessSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          environment,
          component: 'worker',
        })
      );
      expect(startProviderEventReplayWorkerSpy).toHaveBeenCalledTimes(1);
      expect(startPublisherSpy).toHaveBeenCalledOnce();
      expect(startFakeFinancialRecoveryPollerSpy).toHaveBeenCalledTimes(1);
      expect(startWorkOrderCompensationPollerSpy).toHaveBeenCalledTimes(1);
      expect(startChangeOrderRecoveryPollerSpy).toHaveBeenCalledTimes(1);
      expect(fakeFinancialProviderConstructorSpy).not.toHaveBeenCalled();
      expect(legacyExpiryCompensationConstructorSpy).not.toHaveBeenCalled();
      expect(fakeFinancialRecoveryWorkerConstructorSpy).not.toHaveBeenCalled();
      expect(financialBootstrapReadinessSpy.mock.invocationCallOrder[0]).toBeLessThan(
        startProviderEventReplayWorkerSpy.mock.invocationCallOrder[0] ?? Infinity
      );
      expect(financialBootstrapReadinessSpy.mock.invocationCallOrder[1]).toBeLessThan(
        startFakeFinancialRecoveryPollerSpy.mock.invocationCallOrder[0] ?? Infinity
      );
      expect(financialBootstrapReadinessSpy.mock.invocationCallOrder[2]).toBeLessThan(
        startWorkOrderCompensationPollerSpy.mock.invocationCallOrder[0] ?? Infinity
      );
      expect(financialBootstrapReadinessSpy.mock.invocationCallOrder[3]).toBeLessThan(
        startChangeOrderRecoveryPollerSpy.mock.invocationCallOrder[0] ?? Infinity
      );
      const compensationDependencies = startWorkOrderCompensationPollerSpy.mock.calls[0]?.[1];
      compensationDependencies?.assertAuthorized();
      expect(assertNonproductionFakeFinanceAuthorizedSpy).toHaveBeenCalledWith({
        component: 'worker',
      });
      const healthOptions = startWorkerHealthServerSpy.mock.calls.at(-1)?.[0];
      expect(healthOptions?.fakeFinancialPublisherHealth()).toEqual(publisherHandle.status());
      expect(healthOptions?.providerEventReplayHealth()).toEqual(replayHandle.health());
      expect(healthOptions?.fakeFinancialCommandRecoveryHealth()).toEqual(recoveryHandle.health());
      expect(healthOptions?.workOrderCompensationHealth()).toEqual(compensationHandle.health());
      expect(healthOptions?.changeOrderRecoveryHealth()).toEqual(
        changeOrderRecoveryHandle.health()
      );
      expect(workerHealthHandle.markReady).toHaveBeenCalled();
    }
  );

  it.each(['production', 'unknown'])(
    'keeps financial pollers disabled in %s',
    async (environment) => {
      vi.stubEnv('HX_ENVIRONMENT', environment);
      const { bootWorkerProcess } = await import('../../src/jobs/workers');

      await bootWorkerProcess();

      expect(startProviderEventReplayWorkerSpy).not.toHaveBeenCalled();
      expect(startFakeFinancialRecoveryPollerSpy).not.toHaveBeenCalled();
      expect(startWorkOrderCompensationPollerSpy).not.toHaveBeenCalled();
      expect(startChangeOrderRecoveryPollerSpy).not.toHaveBeenCalled();
      const healthOptions = startWorkerHealthServerSpy.mock.calls.at(-1)?.[0];
      expect(healthOptions?.providerEventReplayHealth()).toBeNull();
      expect(healthOptions?.fakeFinancialCommandRecoveryHealth()).toBeNull();
      expect(healthOptions?.workOrderCompensationHealth()).toBeNull();
      expect(healthOptions?.changeOrderRecoveryHealth()).toBeNull();
    }
  );
  it('closes an initially failing publisher and refuses worker readiness', async () => {
    vi.stubEnv('HX_ENVIRONMENT', 'local');
    startPublisherSpy.mockImplementationOnce(() => ({
      ...publisherHandle,
      ready: Promise.reject(new Error('PUBLISHER_INITIAL_ACK_LOST')),
    }));
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('PUBLISHER_INITIAL_ACK_LOST');
    expect(publisherHandle.stop).toHaveBeenCalledOnce();
    expect(workerHealthHandle.markReady).not.toHaveBeenCalled();
    expect(startProviderEventReplayWorkerSpy).not.toHaveBeenCalled();
    expect(installedDatabaseClose).toHaveBeenCalledOnce();
  });
  it('closes an initially failing durable recovery loop and refuses readiness', async () => {
    vi.stubEnv('HX_ENVIRONMENT', 'local');
    const failure = new Error('RECOVERY_SCAN_UNCONFIRMED');
    startFakeFinancialRecoveryPollerSpy.mockImplementationOnce(() => ({
      ...recoveryHandle,
      ready: Promise.reject(failure),
    }));
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('RECOVERY_SCAN_UNCONFIRMED');
    expect(recoveryHandle.stop).toHaveBeenCalledOnce();
    expect(workerHealthHandle.markReady).not.toHaveBeenCalled();
  });
  it('owns a publisher during initial startup and refuses continuation after shutdown', async () => {
    vi.stubEnv('HX_ENVIRONMENT', 'local');
    let resolveReady!: () => void;
    let announceStarted!: () => void;
    const announced = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    startPublisherSpy.mockImplementationOnce(() => {
      announceStarted();
      return { ...publisherHandle, ready };
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { bootWorkerProcess, gracefulShutdown } = await import('../../src/jobs/workers');
      const boot = expect(bootWorkerProcess()).rejects.toThrow('WORKER_STARTUP_ABORTED');
      await announced;
      await gracefulShutdown('SIGTERM');
      expect(publisherHandle.stop).toHaveBeenCalledOnce();
      resolveReady();
      await boot;
      expect(startProviderEventReplayWorkerSpy).not.toHaveBeenCalled();
      expect(workerHealthHandle.markReady).not.toHaveBeenCalled();
    } finally {
      resolveReady();
      exit.mockRestore();
    }
  });
});
