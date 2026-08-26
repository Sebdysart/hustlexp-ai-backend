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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted spy so vi.mock('../../src/config') and the tests share one reference.
const validateConfigSpy = vi.hoisted(() => vi.fn());
const verifyRuntimeSchemaSpy = vi.hoisted(() => vi.fn().mockResolvedValue({
  migrationCount: 116,
  schemaVersion: '1.0.0',
  invariantTriggerCount: 1,
  acceptanceTriggerCount: 1,
  pinnedFunctionCount: 1,
  frozenTableCount: 1,
  databaseIdentitySha256: '1'.repeat(64),
  migrationLedgerSha256: '2'.repeat(64),
  migrationArtifactSha256: '3'.repeat(64),
}));
const registerWorkersSpy = vi.hoisted(() => vi.fn());
const registerScheduledJobsSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const workerHealthHandle = vi.hoisted(() => ({
  markReady: vi.fn(),
  markShuttingDown: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));
const startWorkerHealthServerSpy = vi.hoisted(() => vi.fn(async () => workerHealthHandle));

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
vi.mock('../../src/jobs/worker-registration', () => ({
  registerWorkers: registerWorkersSpy,
}));
vi.mock('../../src/jobs/worker-schedules', () => ({
  registerScheduledJobs: registerScheduledJobsSpy,
}));
vi.mock('../../src/jobs/engine-automation-migration', () => ({
  runEngineAutomationMigration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/jobs/worker-health-server', () => ({
  startWorkerHealthServer: startWorkerHealthServerSpy,
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
vi.mock('../../src/serverStartupMigrations', () => ({
  verifyRuntimeSchema: verifyRuntimeSchemaSpy,
}));

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

  it('startWorkers() does NOT invoke validateConfig (direct unit calls stay safe)', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();
    // This is the #232 regression guard: a direct startWorkers() call must never
    // reach validateConfig, so a config mock lacking the export can't break it.
    expect(validateConfigSpy).not.toHaveBeenCalled();
    expect(verifyRuntimeSchemaSpy).not.toHaveBeenCalled();
  });

  it('bootWorkerProcess() validates config, verifies runtime schema, then starts workers', async () => {
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await bootWorkerProcess();
    expect(validateConfigSpy).toHaveBeenCalledTimes(1);
    expect(verifyRuntimeSchemaSpy).toHaveBeenCalledTimes(1);
    expect(registerWorkersSpy).toHaveBeenCalledTimes(1);
    expect(startWorkerHealthServerSpy).toHaveBeenCalledTimes(1);
    expect(startWorkerHealthServerSpy).toHaveBeenCalledWith({
      databaseAdmission: await verifyRuntimeSchemaSpy.mock.results[0]?.value,
      taskLocationCrypto: undefined,
    });
    expect(workerHealthHandle.markReady).toHaveBeenCalledTimes(1);

    const configOrder = validateConfigSpy.mock.invocationCallOrder[0];
    const schemaOrder = verifyRuntimeSchemaSpy.mock.invocationCallOrder[0];
    const workersOrder = registerWorkersSpy.mock.invocationCallOrder[0];
    expect(configOrder).toBeLessThan(schemaOrder);
    expect(schemaOrder).toBeLessThan(workersOrder);
  });

  it('bootWorkerProcess() surfaces a validateConfig failure (fail-fast)', async () => {
    validateConfigSpy.mockImplementationOnce(() => {
      throw new Error('FATAL config');
    });
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('FATAL config');
    expect(verifyRuntimeSchemaSpy).not.toHaveBeenCalled();
    expect(registerWorkersSpy).not.toHaveBeenCalled();
    expect(startWorkerHealthServerSpy).not.toHaveBeenCalled();
  });

  it('bootWorkerProcess() fails closed when runtime schema verification fails', async () => {
    verifyRuntimeSchemaSpy.mockRejectedValueOnce(new Error('FATAL schema'));
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('FATAL schema');
    expect(validateConfigSpy).toHaveBeenCalledTimes(1);
    expect(verifyRuntimeSchemaSpy).toHaveBeenCalledTimes(1);
    expect(registerWorkersSpy).not.toHaveBeenCalled();
    expect(startWorkerHealthServerSpy).not.toHaveBeenCalled();
  });
});
