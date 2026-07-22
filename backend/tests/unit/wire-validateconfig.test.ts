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
vi.mock('../../src/jobs/export-worker', () => ({ processExportJob: vi.fn() }));
vi.mock('../../src/jobs/email-worker', () => ({ processEmailJob: vi.fn() }));
vi.mock('../../src/jobs/biometric-analyzer-worker', () => ({ processBiometricAnalysisJob: vi.fn() }));
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
  });

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
  });

  it('bootWorkerProcess() surfaces a validateConfig failure (fail-fast)', async () => {
    validateConfigSpy.mockImplementationOnce(() => {
      throw new Error('FATAL config');
    });
    const { bootWorkerProcess } = await import('../../src/jobs/workers');
    await expect(bootWorkerProcess()).rejects.toThrow('FATAL config');
  });
});
