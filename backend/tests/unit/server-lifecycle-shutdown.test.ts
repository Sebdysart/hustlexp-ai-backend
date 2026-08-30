import type { ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseClose, log, redisClose, sentryCapture } = vi.hoisted(() => ({
  databaseClose: vi.fn().mockResolvedValue(undefined),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  redisClose: vi.fn().mockResolvedValue(undefined),
  sentryCapture: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { close: databaseClose } }));
vi.mock('../../src/lib/redis-runtime-shutdown', () => ({ closeRedisRuntime: redisClose }));
vi.mock('../../src/logger', () => ({ logger: log }));
vi.mock('../../src/sentry', () => ({ Sentry: { captureException: sentryCapture } }));

function serverThatCloses(error?: Error): ServerType {
  return {
    close: vi.fn((callback: (closeError?: Error) => void) => callback(error)),
  } as unknown as ServerType;
}

describe('API server lifecycle shutdown', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    databaseClose.mockResolvedValue(undefined);
    redisClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attempts HTTP, Redis, and database cleanup in order and aggregates every failure', async () => {
    const httpError = new Error('HTTP close failed');
    const redisError = new Error('Redis close failed');
    const databaseError = new Error('database close failed');
    const order: string[] = [];
    const { shutdownServerResources } = await import('../../src/serverLifecycle');

    const close = shutdownServerResources({
      closeHttp: async () => { order.push('http'); throw httpError; },
      closeRedis: async () => { order.push('redis'); throw redisError; },
      closeDatabase: async () => { order.push('database'); throw databaseError; },
      closeTimeoutMs: 50,
    });
    const error = await close.catch((caught: unknown) => caught) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('API runtime shutdown encountered one or more failures');
    expect(error.errors).toEqual([httpError, redisError, databaseError]);
    expect(order).toEqual(['http', 'redis', 'database']);
  });

  it('turns a hung close into a bounded failure and still attempts later resources', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { shutdownServerResources } = await import('../../src/serverLifecycle');

    const close = shutdownServerResources({
      closeHttp: () => {
        order.push('http');
        return new Promise<void>(() => undefined);
      },
      closeRedis: async () => { order.push('redis'); },
      closeDatabase: async () => { order.push('database'); },
      closeTimeoutMs: 5,
    });
    const outcome = close.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(5);
    const error = await outcome as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect((error.errors[0] as Error).message).toContain('HTTP_CLOSE_TIMEOUT');
    expect(order).toEqual(['http', 'redis', 'database']);
  });

  it.each(['HTTP', 'Redis', 'database'] as const)(
    'exits nonzero after a %s cleanup failure while attempting every resource',
    async (failedResource) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const failure = new Error(`${failedResource} close failed`);
      const server = serverThatCloses(failedResource === 'HTTP' ? failure : undefined);
      if (failedResource === 'Redis') redisClose.mockRejectedValueOnce(failure);
      if (failedResource === 'database') databaseClose.mockRejectedValueOnce(failure);
      const { gracefulShutdown } = await import('../../src/serverLifecycle');

      await gracefulShutdown(server, 'SIGTERM');

      expect(server.close).toHaveBeenCalledTimes(1);
      expect(redisClose).toHaveBeenCalledTimes(1);
      expect(databaseClose).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it('exits zero only after every cleanup resource succeeds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const server = serverThatCloses();
    const { gracefulShutdown } = await import('../../src/serverLifecycle');

    await gracefulShutdown(server, 'SIGINT');

    expect(redisClose).toHaveBeenCalledTimes(1);
    expect(databaseClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('shares one in-flight shutdown and closes each resource exactly once', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let finishHttpClose: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        finishHttpClose = callback;
      }),
    } as unknown as ServerType;
    const { gracefulShutdown } = await import('../../src/serverLifecycle');

    const first = gracefulShutdown(server, 'SIGTERM');
    const concurrent = gracefulShutdown(server, 'SIGINT');
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(server.close).toHaveBeenCalledTimes(1);

    finishHttpClose?.();
    await first;

    expect(redisClose).toHaveBeenCalledTimes(1);
    expect(databaseClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(gracefulShutdown(server, 'SIGTERM')).toBe(first);
  });
});
