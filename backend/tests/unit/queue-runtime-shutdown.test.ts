import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RedisMock = {
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

const { closeOrder, queueClose, redisInstances } = vi.hoisted(() => ({
  closeOrder: [] as string[],
  queueClose: vi.fn(),
  redisInstances: [] as RedisMock[],
}));

vi.mock('bullmq', () => {
  class QueueMock {
    add = vi.fn().mockResolvedValue({ id: 'job-1' });
    close = queueClose;
  }
  class WorkerMock {
    name: string;
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    constructor(name: string) {
      this.name = name;
    }
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

vi.mock('ioredis', () => {
  class RedisMockClass {
    quit = vi.fn(async () => { closeOrder.push('redis'); });
    disconnect = vi.fn(() => { closeOrder.push('disconnect'); });
    constructor() {
      redisInstances.push(this);
    }
  }
  return { default: RedisMockClass };
});

vi.mock('../../src/config', () => ({
  config: {
    redis: { url: 'redis://localhost:6379' },
    queue: { hmacSecret: 'test-hmac-secret' },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

describe('BullMQ runtime shutdown', () => {
  beforeEach(() => {
    vi.resetModules();
    closeOrder.length = 0;
    redisInstances.length = 0;
    queueClose.mockReset().mockImplementation(async () => { closeOrder.push('queue'); });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes queue producers before all Redis connections and shares one terminal result', async () => {
    const { closeAllConnections, createWorker, enqueueJob } = await import('../../src/jobs/queues');
    await enqueueJob('maintenance', 'cleanup', {}, { jobId: 'cleanup-1' });
    createWorker('exports', async () => undefined);

    const first = closeAllConnections();
    const concurrent = closeAllConnections();
    expect(concurrent).toBe(first);
    await first;

    expect(closeOrder).toEqual(['queue', 'redis', 'redis']);
    expect(redisInstances).toHaveLength(2);
    expect(redisInstances.every(instance => instance.quit.mock.calls.length === 1)).toBe(true);
    expect(closeAllConnections()).toBe(first);
    await expect(closeAllConnections()).resolves.toBeUndefined();
    expect(queueClose).toHaveBeenCalledTimes(1);
  });

  it('attempts every connection and aggregates queue and Redis close failures', async () => {
    const queueError = new Error('queue close failed');
    const redisError = new Error('redis close failed');
    queueClose.mockImplementationOnce(async () => {
      closeOrder.push('queue');
      throw queueError;
    });
    const { closeAllConnections, createWorker, enqueueJob } = await import('../../src/jobs/queues');
    await enqueueJob('maintenance', 'cleanup', {}, { jobId: 'cleanup-2' });
    createWorker('exports', async () => undefined);
    redisInstances[0].quit.mockImplementationOnce(async () => {
      closeOrder.push('redis-failed');
      throw redisError;
    });

    const close = closeAllConnections();
    await expect(close).rejects.toThrow('Failed to close one or more BullMQ queues or Redis connections');
    const error = await close.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([queueError, redisError]);
    expect(closeOrder[0]).toBe('queue');
    expect(closeOrder.slice(1)).toEqual(expect.arrayContaining(['redis-failed', 'disconnect', 'redis']));
    expect(redisInstances.every(instance => instance.quit.mock.calls.length === 1)).toBe(true);
    expect(redisInstances[0].disconnect).toHaveBeenCalledWith(false);
    expect(redisInstances[1].disconnect).not.toHaveBeenCalled();
    expect(closeAllConnections()).toBe(close);
  });

  it('bounds hung queue close and Redis quit, forces disconnect, and reports both failures', async () => {
    vi.useFakeTimers();
    queueClose.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const {
      BULLMQ_SHUTDOWN_TIMEOUT_MS,
      closeAllConnections,
      enqueueJob,
    } = await import('../../src/jobs/queues');
    await enqueueJob('maintenance', 'cleanup', {}, { jobId: 'cleanup-timeout' });
    redisInstances[0].quit.mockImplementationOnce(() => new Promise<string>(() => undefined));

    const close = closeAllConnections();
    const outcome = close.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(BULLMQ_SHUTDOWN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(BULLMQ_SHUTDOWN_TIMEOUT_MS);
    const error = await outcome as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect((error.errors[0] as Error).message).toContain('BULLMQ_QUEUE_CLOSE_TIMEOUT:maintenance');
    expect((error.errors[1] as Error).message).toContain('BULLMQ_REDIS_QUIT_TIMEOUT:maintenance:queue');
    expect(redisInstances[0].disconnect).toHaveBeenCalledWith(false);
    expect(closeOrder).toEqual(['disconnect']);
  });
});
