import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { expireDue: vi.fn() },
}));

import type { Job } from 'bullmq';
import { processMaintenanceJob } from '../../src/jobs/maintenance-worker';
import { AutomationLifecycleService } from '../../src/services/AutomationLifecycleService';

const expireDue = vi.mocked(AutomationLifecycleService.expireDue);

beforeEach(() => vi.clearAllMocks());

describe('dispatch expiry maintenance worker', () => {
  it('runs a bounded batch', async () => {
    expireDue.mockResolvedValueOnce({
      success: true,
      data: { inspected: 2, expired: 1, blocked: 1, results: [] },
    });
    await processMaintenanceJob({ name: 'dispatch.expire_unfilled', data: { limit: 10_000 } } as Job);
    expect(expireDue).toHaveBeenCalledWith({ limit: 100 });
  });

  it('throws so BullMQ retries a failed batch', async () => {
    expireDue.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'down' },
    });
    await expect(processMaintenanceJob({ name: 'dispatch.expire_unfilled', data: { limit: 50 } } as Job))
      .rejects.toThrow('DB_ERROR');
  });
});
