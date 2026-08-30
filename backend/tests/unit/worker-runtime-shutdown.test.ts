import { afterEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));
const redisClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const databaseClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const failingRegisteredWorker = vi.hoisted(() => ({
  name: 'registered-worker',
  close: vi.fn().mockRejectedValue(new Error('registered worker close failed')),
}));

vi.mock('../../src/logger', () => ({ workerLogger: log }));
vi.mock('../../src/config', () => ({ validateConfig: vi.fn() }));
vi.mock('../../src/jobs/outbox-worker', () => ({ startOutboxWorker: vi.fn() }));
vi.mock('../../src/jobs/worker-registration', () => ({
  registerWorkers: vi.fn((workers: unknown[]) => workers.push(failingRegisteredWorker)),
}));
vi.mock('../../src/jobs/worker-schedules', () => ({ registerScheduledJobs: vi.fn() }));
vi.mock('../../src/jobs/worker-health-server', () => ({
  startWorkerHealthServer: vi.fn(),
}));
vi.mock('../../src/serverStartupMigrations', () => ({ runStartupMigrations: vi.fn() }));
vi.mock('../../src/lib/redis-runtime-shutdown', () => ({ closeRedisRuntime: redisClose }));
vi.mock('../../src/db', () => ({ db: { close: databaseClose } }));

import {
  gracefulShutdown,
  registerWorkers,
  shutdownWorkerResources,
} from '../../src/jobs/workers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker runtime shutdown', () => {
  it('drains workers before health, Redis, and database cleanup', async () => {
    const order: string[] = [];
    const worker = (name: string) => ({
      name,
      close: vi.fn(async () => { order.push(name); }),
    });

    await shutdownWorkerResources({
      workers: [worker('worker-1'), worker('worker-2')],
      closeHealthServer: async () => { order.push('health'); },
      closeRedis: async () => { order.push('redis'); },
      closeDatabase: async () => { order.push('database'); },
      workerDrainTimeoutMs: 50,
    });

    expect(order).toEqual(['worker-1', 'worker-2', 'health', 'redis', 'database']);
  });

  it('aggregates worker rejection and still attempts every cleanup step', async () => {
    const order: string[] = [];
    const workerError = new Error('worker close failed');

    const close = shutdownWorkerResources({
      workers: [{
        name: 'worker-1',
        close: vi.fn(async () => {
          order.push('worker');
          throw workerError;
        }),
      }],
      closeHealthServer: async () => { order.push('health'); },
      closeRedis: async () => { order.push('redis'); },
      closeDatabase: async () => { order.push('database'); },
      workerDrainTimeoutMs: 50,
    });

    await expect(close).rejects.toThrow('Worker runtime shutdown encountered one or more failures');
    const error = await close.catch((caught: unknown) => caught);
    expect((error as AggregateError).errors).toEqual([workerError]);
    expect(order).toEqual(['worker', 'health', 'redis', 'database']);
  });

  it('turns a bounded worker drain timeout into failure and still cleans up', async () => {
    const order: string[] = [];
    const close = shutdownWorkerResources({
      workers: [{ name: 'hung-worker', close: vi.fn(() => new Promise<void>(() => undefined)) }],
      closeHealthServer: async () => { order.push('health'); },
      closeRedis: async () => { order.push('redis'); },
      closeDatabase: async () => { order.push('database'); },
      workerDrainTimeoutMs: 5,
    });

    await expect(close).rejects.toThrow('Worker runtime shutdown encountered one or more failures');
    const error = await close.catch((caught: unknown) => caught) as AggregateError;
    expect(error.errors).toHaveLength(1);
    expect((error.errors[0] as Error).message).toContain('WORKER_DRAIN_TIMEOUT');
    expect(order).toEqual(['health', 'redis', 'database']);
  });

  it('aggregates terminal close failures after attempting all terminal resources', async () => {
    const healthError = new Error('health close failed');
    const redisError = new Error('redis close failed');
    const databaseError = new Error('database close failed');
    const order: string[] = [];

    const close = shutdownWorkerResources({
      workers: [],
      closeHealthServer: async () => { order.push('health'); throw healthError; },
      closeRedis: async () => { order.push('redis'); throw redisError; },
      closeDatabase: async () => { order.push('database'); throw databaseError; },
      workerDrainTimeoutMs: 50,
    });

    const error = await close.catch((caught: unknown) => caught) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([healthError, redisError, databaseError]);
    expect(order).toEqual(['health', 'redis', 'database']);
  });

  it('bounds a hung terminal resource and still attempts remaining cleanup', async () => {
    const order: string[] = [];
    const close = shutdownWorkerResources({
      workers: [],
      closeHealthServer: () => new Promise<void>(() => undefined),
      closeRedis: async () => { order.push('redis'); },
      closeDatabase: async () => { order.push('database'); },
      workerDrainTimeoutMs: 50,
      terminalCloseTimeoutMs: 5,
    });

    const error = await close.catch((caught: unknown) => caught) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect((error.errors[0] as Error).message).toContain(
      'WORKER_RESOURCE_CLOSE_TIMEOUT:worker_health_server',
    );
    expect(order).toEqual(['redis', 'database']);
  });

  it('maps a worker close rejection to a non-zero process outcome', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    registerWorkers();

    await gracefulShutdown('SIGTERM');

    expect(failingRegisteredWorker.close).toHaveBeenCalledTimes(1);
    expect(redisClose).toHaveBeenCalledTimes(1);
    expect(databaseClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
