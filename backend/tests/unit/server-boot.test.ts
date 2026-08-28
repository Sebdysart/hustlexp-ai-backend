import { describe, expect, it, vi } from 'vitest';
import { bootHttpServer } from '../../src/serverBoot';

describe('fail-closed HTTP server boot', () => {
  it('listens only after startup attestation succeeds', async () => {
    const order: string[] = [];
    const server = { close: vi.fn() };

    await expect(bootHttpServer({
      startup: async () => { order.push('startup'); },
      listen: () => { order.push('listen'); return server; },
      installHandlers: (actual) => {
        order.push('handlers');
        expect(actual).toBe(server);
      },
    })).resolves.toBe(server);

    expect(order).toEqual(['startup', 'listen', 'handlers']);
  });

  it('never opens a listener when startup or migration attestation fails', async () => {
    const listen = vi.fn(() => ({ close: vi.fn() }));
    const installHandlers = vi.fn();

    await expect(bootHttpServer({
      startup: async () => { throw new Error('STARTUP_MIGRATION_ATTESTATION_FAILED'); },
      listen,
      installHandlers,
    })).rejects.toThrow('STARTUP_MIGRATION_ATTESTATION_FAILED');

    expect(listen).not.toHaveBeenCalled();
    expect(installHandlers).not.toHaveBeenCalled();
  });
});
