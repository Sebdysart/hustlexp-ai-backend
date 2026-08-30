import { beforeEach, describe, expect, it, vi } from 'vitest';

const { closeCommandClient, closePubSub, closeQueues, order } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    closeQueues: vi.fn(async () => { order.push('queues'); }),
    closePubSub: vi.fn(async () => { order.push('pubsub'); }),
    closeCommandClient: vi.fn(async () => { order.push('command'); }),
  };
});

vi.mock('../../src/jobs/queues', () => ({
  closeAllConnections: closeQueues,
}));
vi.mock('../../src/realtime/redis-pubsub', () => ({
  shutdownPubSub: closePubSub,
}));
vi.mock('../../src/redis/RedisCommandPort', () => ({
  closeRedisCommandClient: closeCommandClient,
}));

describe('Redis runtime shutdown', () => {
  beforeEach(() => {
    vi.resetModules();
    order.length = 0;
    closeQueues.mockReset().mockImplementation(async () => { order.push('queues'); });
    closePubSub.mockReset().mockImplementation(async () => { order.push('pubsub'); });
    closeCommandClient.mockReset().mockImplementation(async () => { order.push('command'); });
  });

  it('closes queues, pub/sub, and command Redis in order exactly once', async () => {
    const { closeRedisRuntime } = await import('../../src/lib/redis-runtime-shutdown');
    await Promise.all([closeRedisRuntime(), closeRedisRuntime()]);

    expect(order).toEqual(['queues', 'pubsub', 'command']);
    expect(closeQueues).toHaveBeenCalledTimes(1);
    expect(closePubSub).toHaveBeenCalledTimes(1);
    expect(closeCommandClient).toHaveBeenCalledTimes(1);
  });

  it('attempts every role and aggregates failures without changing the close order', async () => {
    const queueError = new Error('queue close failed');
    const pubSubError = new Error('pubsub close failed');
    closeQueues.mockImplementationOnce(async () => {
      order.push('queues');
      throw queueError;
    });
    closePubSub.mockImplementationOnce(async () => {
      order.push('pubsub');
      throw pubSubError;
    });

    const { closeRedisRuntime } = await import('../../src/lib/redis-runtime-shutdown');
    const close = closeRedisRuntime();
    await expect(close).rejects.toThrow('Failed to close one or more Redis runtime roles');

    const error = await close.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([queueError, pubSubError]);
    expect(order).toEqual(['queues', 'pubsub', 'command']);
    expect(closeCommandClient).toHaveBeenCalledTimes(1);
  });

  it('returns the same terminal rejection to concurrent and later callers', async () => {
    const queueError = new Error('queue close failed');
    closeQueues.mockRejectedValueOnce(queueError);
    const { closeRedisRuntime } = await import('../../src/lib/redis-runtime-shutdown');

    const first = closeRedisRuntime();
    const concurrent = closeRedisRuntime();
    expect(concurrent).toBe(first);
    const firstError = await first.catch((caught: unknown) => caught);
    const laterError = await closeRedisRuntime().catch((caught: unknown) => caught);

    expect(laterError).toBe(firstError);
    expect(closeQueues).toHaveBeenCalledTimes(1);
    expect(closePubSub).toHaveBeenCalledTimes(1);
    expect(closeCommandClient).toHaveBeenCalledTimes(1);
  });
});
