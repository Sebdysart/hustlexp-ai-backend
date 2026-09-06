import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { bootHttpServer, waitForHttpListener } from '../../src/serverBoot';

describe('fail-closed HTTP server boot', () => {
  it('cleans up an installed runtime after asynchronous port-binding failure', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await waitForHttpListener(occupied);
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('LOOPBACK_TEST_PORT_REQUIRED');
    const partial = createServer();
    const closeDatabase = vi.fn().mockResolvedValue(undefined);
    const installHandlers = vi.fn();
    const cleanup = vi.fn(async (server, startup) => {
      expect(server).toBe(partial);
      await startup?.closeDatabase();
    });
    try {
      await expect(
        bootHttpServer({
          startup: async () => ({ closeDatabase }),
          listen: () => {
            partial.listen(address.port, '127.0.0.1');
            return partial;
          },
          awaitListening: waitForHttpListener,
          installHandlers,
          cleanupOnFailure: cleanup,
        })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(closeDatabase).toHaveBeenCalledOnce();
      expect(installHandlers).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      if (partial.listening) await new Promise<void>((resolve) => partial.close(() => resolve()));
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it.each(['listen', 'handlers'] as const)(
    'cleans up installed startup resources after %s failure',
    async (boundary) => {
      const server = { close: vi.fn() };
      const startup = { closeDatabase: vi.fn().mockResolvedValue(undefined) };
      const cleanup = vi.fn(async (_server, installed) => {
        await installed?.closeDatabase();
      });
      await expect(
        bootHttpServer({
          startup: async () => startup,
          listen: () => {
            if (boundary === 'listen') throw new Error('LISTEN_FAILED');
            return server;
          },
          installHandlers: () => {
            throw new Error('HANDLERS_FAILED');
          },
          cleanupOnFailure: cleanup,
        })
      ).rejects.toThrow(boundary === 'listen' ? 'LISTEN_FAILED' : 'HANDLERS_FAILED');
      expect(cleanup).toHaveBeenCalledWith(boundary === 'listen' ? undefined : server, startup);
      expect(startup.closeDatabase).toHaveBeenCalledOnce();
    }
  );
  it('preserves startup and cleanup failures and grants no ownership handle for a failed startup', async () => {
    const startupError = new Error('STARTUP_FAILED');
    const cleanupError = new Error('CLEANUP_FAILED');
    const cleanup = vi.fn(async (server, startup) => {
      expect(server).toBeUndefined();
      expect(startup).toBeUndefined();
      throw cleanupError;
    });
    const result = await bootHttpServer({
      startup: async () => {
        throw startupError;
      },
      listen: () => ({}),
      installHandlers: () => undefined,
      cleanupOnFailure: cleanup,
    }).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([startupError, cleanupError]);
  });
  it('listens only after startup attestation succeeds', async () => {
    const order: string[] = [];
    const server = { close: vi.fn() };

    await expect(
      bootHttpServer({
        startup: async () => {
          order.push('startup');
        },
        listen: () => {
          order.push('listen');
          return server;
        },
        installHandlers: (actual) => {
          order.push('handlers');
          expect(actual).toBe(server);
        },
      })
    ).resolves.toBe(server);

    expect(order).toEqual(['startup', 'listen', 'handlers']);
  });

  it('never opens a listener when startup or migration attestation fails', async () => {
    const listen = vi.fn(() => ({ close: vi.fn() }));
    const installHandlers = vi.fn();

    await expect(
      bootHttpServer({
        startup: async () => {
          throw new Error('STARTUP_MIGRATION_ATTESTATION_FAILED');
        },
        listen,
        installHandlers,
      })
    ).rejects.toThrow('STARTUP_MIGRATION_ATTESTATION_FAILED');

    expect(listen).not.toHaveBeenCalled();
    expect(installHandlers).not.toHaveBeenCalled();
  });
});
