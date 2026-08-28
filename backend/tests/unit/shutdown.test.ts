import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

import { GracefulShutdown } from '../../src/lib/shutdown';

// Prevent actual process.exit in tests
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

describe('GracefulShutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // register
  // ===========================================================================
  describe('register', () => {
    it('registers a shutdown handler', () => {
      const gs = new GracefulShutdown();
      gs.register('test', 0, async () => {});
      // No error means success — internal state is private
    });

    it('allows registering multiple handlers', () => {
      const gs = new GracefulShutdown();
      gs.register('h1', 0, async () => {});
      gs.register('h2', 10, async () => {});
      gs.register('h3', 20, async () => {});
      // No error means success
    });
  });

  // ===========================================================================
  // shutdown
  // ===========================================================================
  describe('shutdown', () => {
    it('runs handlers in priority order', async () => {
      const gs = new GracefulShutdown();
      const order: string[] = [];

      gs.register('second', 10, async () => { order.push('second'); });
      gs.register('first', 0, async () => { order.push('first'); });
      gs.register('third', 20, async () => { order.push('third'); });

      await gs.shutdown();

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('calls process.exit(0) on success', async () => {
      const gs = new GracefulShutdown();
      gs.register('test', 0, async () => {});

      await gs.shutdown();

      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('continues to next handler if one fails', async () => {
      const gs = new GracefulShutdown();
      const order: string[] = [];

      gs.register('failing', 0, async () => { throw new Error('fail'); });
      gs.register('passing', 10, async () => { order.push('passing'); });

      await gs.shutdown();

      expect(order).toContain('passing');
    });

    it('only shuts down once (idempotent)', async () => {
      const gs = new GracefulShutdown();
      let callCount = 0;
      gs.register('counter', 0, async () => { callCount++; });

      await gs.shutdown();
      await gs.shutdown(); // Second call should be no-op

      expect(callCount).toBe(1);
    });
  });

  // ===========================================================================
  // registerDefaults
  // ===========================================================================
  describe('registerDefaults', () => {
    it('registers httpServer handler', async () => {
      const gs = new GracefulShutdown();
      const mockServer = {
        close: vi.fn((cb: (err?: Error) => void) => cb()),
      };

      gs.registerDefaults({ httpServer: mockServer });
      await gs.shutdown();

      expect(mockServer.close).toHaveBeenCalled();
    });

    it('registers bullmq workers handler', async () => {
      const gs = new GracefulShutdown();
      const mockWorker = { close: vi.fn().mockResolvedValue(undefined) };

      gs.registerDefaults({ bullmqWorkers: [mockWorker] });
      await gs.shutdown();

      expect(mockWorker.close).toHaveBeenCalled();
    });

    it('registers redis handler', async () => {
      const gs = new GracefulShutdown();
      const mockRedis = { quit: vi.fn().mockResolvedValue(undefined) };

      gs.registerDefaults({ redis: [mockRedis] });
      await gs.shutdown();

      expect(mockRedis.quit).toHaveBeenCalled();
    });

    it('registers prisma handler', async () => {
      const gs = new GracefulShutdown();
      const mockPrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };

      gs.registerDefaults({ prismaClients: [mockPrisma] });
      await gs.shutdown();

      expect(mockPrisma.$disconnect).toHaveBeenCalled();
    });

    it('handles empty deps', () => {
      const gs = new GracefulShutdown();
      expect(() => gs.registerDefaults({})).not.toThrow();
    });
  });

  // ===========================================================================
  // setup
  // ===========================================================================
  describe('setup', () => {
    it('registers SIGTERM and SIGINT listeners', () => {
      const gs = new GracefulShutdown();
      const onSpy = vi.spyOn(process, 'on');

      gs.setup();

      expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

      onSpy.mockRestore();
    });
  });
});
