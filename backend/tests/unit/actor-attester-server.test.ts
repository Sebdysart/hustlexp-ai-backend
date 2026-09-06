import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  startup: vi.fn(),
  serve: vi.fn(),
  ownedClose: vi.fn(),
  redisClose: vi.fn(),
  globalClose: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('@hono/node-server', () => ({ serve: mocks.serve }));
vi.mock('../../src/actor-attester-startup', () => ({ startActorAttester: mocks.startup }));
vi.mock('../../src/db', () => ({ db: { close: mocks.globalClose } }));
vi.mock('../../src/redis/RedisCommandPort', () => ({ closeRedisCommandClient: mocks.redisClose }));
vi.mock('../../src/lib/redis-runtime-shutdown', () => ({
  closeRedisRuntime: vi.fn(() => {
    throw new Error('ATTESTER_SHARED_REDIS_SHUTDOWN_FORBIDDEN');
  }),
}));
vi.mock('../../src/logger', () => ({ logger: mocks.log }));
vi.mock('../../src/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

class FakeServer extends EventEmitter {
  listening = true;
  close = vi.fn((callback: (error?: Error) => void) => callback());
}
let server: FakeServer;
let callbacks: Map<string, () => void>;
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  callbacks = new Map();
  server = new FakeServer();
  mocks.startup.mockResolvedValue({
    app: { fetch: vi.fn() },
    port: 3002,
    hostname: '127.0.0.1',
    closeDatabase: mocks.ownedClose,
  });
  mocks.ownedClose.mockResolvedValue(undefined);
  mocks.redisClose.mockResolvedValue(undefined);
  mocks.serve.mockReturnValue(server);
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      callbacks.set(event, listener);
      return process;
    }
    return originalOnce(event, listener);
  });
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => vi.restoreAllMocks());

describe('actor-attester server composition', () => {
  it('opens HTTP only after startup and closes HTTP, revocation Redis and its owned database once', async () => {
    let finishHttp!: (error?: Error) => void;
    server.close.mockImplementationOnce((callback) => {
      finishHttp = callback;
    });
    await import('../../src/actor-attester-server.js');
    expect(mocks.startup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.serve.mock.invocationCallOrder[0]!
    );
    callbacks.get('SIGTERM')!();
    callbacks.get('SIGINT')!();
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce());
    expect(mocks.redisClose).not.toHaveBeenCalled();
    expect(mocks.ownedClose).not.toHaveBeenCalled();
    finishHttp();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledOnce();
    expect(mocks.redisClose).toHaveBeenCalledOnce();
    expect(mocks.ownedClose).toHaveBeenCalledOnce();
    expect(mocks.redisClose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ownedClose.mock.invocationCallOrder[0]!
    );
    expect(mocks.globalClose).not.toHaveBeenCalled();
  });
  it.each(['http', 'redis', 'database'] as const)(
    'reports %s shutdown failure after attempting every owned resource',
    async (boundary) => {
      if (boundary === 'http')
        server.close.mockImplementationOnce((callback) => callback(new Error('HTTP_CLOSE_FAILED')));
      if (boundary === 'redis')
        mocks.redisClose.mockRejectedValueOnce(new Error('REDIS_CLOSE_FAILED'));
      if (boundary === 'database')
        mocks.ownedClose.mockRejectedValueOnce(new Error('DATABASE_CLOSE_FAILED'));
      await import('../../src/actor-attester-server.js');
      callbacks.get('SIGTERM')!();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(server.close).toHaveBeenCalledOnce();
      expect(mocks.redisClose).toHaveBeenCalledOnce();
      expect(mocks.ownedClose).toHaveBeenCalledOnce();
      expect(mocks.globalClose).not.toHaveBeenCalled();
    }
  );
  it('never opens HTTP or closes another runtime after startup rejection', async () => {
    mocks.startup.mockRejectedValueOnce(new Error('STARTUP_HELD'));
    await expect(import('../../src/actor-attester-server.js')).rejects.toThrow('STARTUP_HELD');
    expect(mocks.serve).not.toHaveBeenCalled();
    expect(mocks.redisClose).not.toHaveBeenCalled();
    expect(mocks.ownedClose).not.toHaveBeenCalled();
    expect(mocks.globalClose).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });
  it('closes owned resources after asynchronous bind failure before installing signal handlers', async () => {
    server.listening = false;
    mocks.serve.mockImplementationOnce(() => {
      queueMicrotask(() =>
        server.emit('error', Object.assign(new Error('BIND_FAILED'), { code: 'EADDRINUSE' }))
      );
      return server;
    });
    server.close.mockImplementationOnce((callback) =>
      callback(Object.assign(new Error('NOT_RUNNING'), { code: 'ERR_SERVER_NOT_RUNNING' }))
    );
    await expect(import('../../src/actor-attester-server.js')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(server.close).toHaveBeenCalledOnce();
    expect(mocks.redisClose).toHaveBeenCalledOnce();
    expect(mocks.ownedClose).toHaveBeenCalledOnce();
    expect(mocks.globalClose).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });
});
