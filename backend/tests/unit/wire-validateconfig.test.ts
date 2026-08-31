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
const workerHealthHandle = vi.hoisted(() => ({
  markReady: vi.fn(),
  markShuttingDown: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));
const startWorkerHealthServerSpy = vi.hoisted(() => vi.fn(async () => workerHealthHandle));
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
  vi.fn(() => compensationHandle)
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
const startChangeOrderRecoveryPollerSpy = vi.hoisted(() =>
  vi.fn(() => changeOrderRecoveryHandle)
);
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
vi.mock('../../src/serverStartupMigrations', () => ({
  runStartupMigrations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/jobs/worker-health-server', () => ({
  startWorkerHealthServer: startWorkerHealthServerSpy,
}));
vi.mock('../../src/jobs/provider-event-replay-worker', () => ({
  startProviderEventReplayWorker: startProviderEventReplayWorkerSpy,
}));
vi.mock('../../src/jobs/financial-provider-command-recovery-worker', () => ({
  ExactFakeFinancialCommandRecoveryExecutor: class {},
  NonproductionFakeFinancialCommandRecoveryWorker: class {},
  startNonproductionFakeFinancialCommandRecoveryPoller: startFakeFinancialRecoveryPollerSpy,
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
  PostgresFakeFinancialOperationRepository: class {},
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
      expect(startFakeFinancialRecoveryPollerSpy).toHaveBeenCalledTimes(1);
      expect(startWorkOrderCompensationPollerSpy).toHaveBeenCalledTimes(1);
      expect(startChangeOrderRecoveryPollerSpy).toHaveBeenCalledTimes(1);
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
});
