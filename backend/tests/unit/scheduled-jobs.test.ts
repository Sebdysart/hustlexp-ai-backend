/**
 * Scheduled Jobs Activation Tests
 *
 * Validates that workers.ts properly registers repeatable BullMQ jobs
 * for maintenance, fraud detection, and cleanup operations.
 *
 * @see backend/src/jobs/workers.ts (registerScheduledJobs)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Track all Queue.add calls ───────────────────────────────────────────────
const queueAddCalls: Array<{ queueName: string; jobName: string; data: unknown; opts: unknown }> = [];

vi.mock('../../src/jobs/queues', () => {
  const mockQueue = (name: string) => ({
    name,
    add: vi.fn(async (jobName: string, data: unknown, opts?: unknown) => {
      queueAddCalls.push({ queueName: name, jobName, data, opts });
      return { id: `mock-job-${name}-${jobName}` };
    }),
  });

  const queues: Record<string, ReturnType<typeof mockQueue>> = {};

  return {
    getQueue: vi.fn((name: string) => {
      if (!queues[name]) queues[name] = mockQueue(name);
      return queues[name];
    }),
    createWorker: vi.fn(() => ({
      name: 'mock-worker',
      close: vi.fn(),
    })),
    Queue: class {},
    Worker: class {},
  };
});

vi.mock('../../src/jobs/outbox-worker', () => ({
  startOutboxWorker: vi.fn(),
}));

vi.mock('../../src/jobs/export-worker', () => ({
  processExportJob: vi.fn(),
}));

vi.mock('../../src/jobs/email-worker', () => ({
  processEmailJob: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: null },
    redis: { url: 'redis://localhost:6379' },
  },
}));

describe('Scheduled Jobs Registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueAddCalls.length = 0;
  });

  it('startWorkers registers scheduled jobs', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();

    // Verify scheduled jobs were registered
    expect(queueAddCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('registers recover_stuck_stripe_events on maintenance queue', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();

    const recoverJob = queueAddCalls.find(
      c => c.queueName === 'maintenance' && c.jobName === 'recover_stuck_stripe_events'
    );
    expect(recoverJob).toBeDefined();
    expect((recoverJob!.opts as Record<string, unknown>).repeat).toBeDefined();
    expect(((recoverJob!.opts as Record<string, Record<string, string>>).repeat).pattern).toBe('*/10 * * * *');
    expect((recoverJob!.data as Record<string, unknown>).timeoutMinutes).toBe(10);
  });

  it('registers cleanup_expired_exports on maintenance queue', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();

    const cleanupJob = queueAddCalls.find(
      c => c.queueName === 'maintenance' && c.jobName === 'cleanup_expired_exports'
    );
    expect(cleanupJob).toBeDefined();
    expect(((cleanupJob!.opts as Record<string, Record<string, string>>).repeat).pattern).toBe('0 */6 * * *');
  });

  it('registers cleanup_expired_notifications on maintenance queue', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();

    const notifJob = queueAddCalls.find(
      c => c.queueName === 'maintenance' && c.jobName === 'cleanup_expired_notifications'
    );
    expect(notifJob).toBeDefined();
    expect(((notifJob!.opts as Record<string, Record<string, string>>).repeat).pattern).toBe('30 */6 * * *');
  });

  it('registers fraud detection on critical_trust queue', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();

    const fraudJob = queueAddCalls.find(
      c => c.queueName === 'critical_trust' && c.jobName === 'fraud.scan_requested'
    );
    expect(fraudJob).toBeDefined();
    expect(((fraudJob!.opts as Record<string, Record<string, string>>).repeat).pattern).toBe('*/5 * * * *');
  });

  it('uses unique jobIds to prevent duplicate schedules on restart', async () => {
    const { startWorkers } = await import('../../src/jobs/workers');
    await startWorkers();

    // Every scheduled job should have a jobId prefixed with 'scheduled:'
    const scheduledJobs = queueAddCalls.filter(
      c => (c.opts as Record<string, unknown>).jobId && ((c.opts as Record<string, unknown>).jobId as string).startsWith('scheduled:')
    );
    expect(scheduledJobs.length).toBeGreaterThanOrEqual(4);

    // All jobIds should be unique
    const jobIds = scheduledJobs.map(j => (j.opts as Record<string, unknown>).jobId);
    expect(new Set(jobIds).size).toBe(jobIds.length);
  });
});

describe('Worker Routing', () => {
  it('workers.ts file routes fraud.scan_requested to fraud-detection-worker', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const workersPath = path.resolve(__dirname, '../../src/jobs/workers.ts');
    const workersSource = fs.readFileSync(workersPath, 'utf-8');

    expect(workersSource).toContain("'fraud.scan_requested'");
    expect(workersSource).toContain('./fraud-detection-worker');
  });

  it('workers.ts registers workers for all 6 queues', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const workersPath = path.resolve(__dirname, '../../src/jobs/workers.ts');
    const workersSource = fs.readFileSync(workersPath, 'utf-8');

    expect(workersSource).toContain("'exports'");
    expect(workersSource).toContain("'user_notifications'");
    expect(workersSource).toContain("'critical_payments'");
    expect(workersSource).toContain("'critical_trust'");
    expect(workersSource).toContain("'maintenance'");
    expect(workersSource).toContain("'tax_reporting'");
  });
});
