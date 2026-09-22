import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getJob: vi.fn(), add: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: class { getJob = mocks.getJob; add = mocks.add; }, Worker: class {} }));
vi.mock('ioredis', () => ({ default: class {} }));
vi.mock('../../src/config.js', () => ({ config: { redis: { url: 'redis://mock' }, queue: { hmacSecret: 'mock' } } }));
vi.mock('../../src/logger.js', () => { const logger = { child: () => logger }; return { logger }; });
import { enqueueJob } from '../../src/jobs/queues.js';

describe('outbox queue identity recovery', () => {
  beforeEach(() => vi.clearAllMocks());
  it('creates the missing job with its original identity, routing and priority', async () => {
    mocks.getJob.mockResolvedValue(undefined);
    mocks.add.mockResolvedValue({ id: 'durable-id' });
    await enqueueJob('critical_payments', 'escrow.completion_release_requested', { task_id: 'task-1' }, { jobId: 'durable-id', priority: 2, retryTerminal: true });
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith('escrow.completion_release_requested', { task_id: 'task-1' }, { jobId: 'durable-id', priority: 2 });
  });
  it.each(['waiting', 'active', 'delayed'])('deduplicates an existing %s job', async (state) => {
    const job = { getState: vi.fn().mockResolvedValue(state), retry: vi.fn() };
    mocks.getJob.mockResolvedValue(job);
    await expect(enqueueJob('critical_payments', 'completion', {}, { jobId: 'durable-id', retryTerminal: true })).resolves.toBe(job);
    expect(job.retry).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it.each(['failed', 'completed'] as const)('retries retained %s jobs with the same logical identity', async (state) => {
    const job = { getState: vi.fn().mockResolvedValue(state), retry: vi.fn() };
    mocks.getJob.mockResolvedValue(job);
    await enqueueJob('critical_payments', 'completion', {}, { jobId: 'durable-id', retryTerminal: true });
    expect(job.retry).toHaveBeenCalledExactlyOnceWith(state);
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
