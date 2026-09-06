import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeFinancialOutboxPublisher } from '../../src/jobs/fake-financial-publisher-runtime.js';
import type { FakeFinancialOutboxPublisherResult } from '../../src/jobs/fake-financial-outbox-publisher.js';

const result = (): FakeFinancialOutboxPublisherResult => ({
  claimed: 0,
  confirmed: 0,
  retryableFailures: 0,
  terminalFailures: 0,
  persistenceErrors: 0,
});
function fixture() {
  const runOnce = vi.fn(async (_signal?: AbortSignal) => result()),
    onError = vi.fn();
  return { runOnce, onError, dependencies: { publisher: { runOnce }, onError } };
}
afterEach(() => vi.useRealTimers());
describe('owned fake financial outbox publisher', () => {
  it.each([0, 99, 60_001, 1.5, NaN])(
    'refuses invalid interval %s before publication',
    async (interval) => {
      const f = fixture();
      expect(() => startFakeFinancialOutboxPublisher(interval, f.dependencies)).toThrow(
        'INTERVAL_INVALID'
      );
      expect(f.runOnce).not.toHaveBeenCalled();
    }
  );
  it('does not report startup success when initial authority or persistence fails', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runOnce.mockRejectedValueOnce(new Error('AUTHORITY_REVOKED'));
    await expect(startFakeFinancialOutboxPublisher(100, f.dependencies).ready).rejects.toThrow(
      'AUTHORITY_REVOKED'
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runOnce).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not report startup success after an uncertain publication outcome commit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runOnce.mockResolvedValueOnce({ ...result(), claimed: 1, persistenceErrors: 1 });
    await expect(startFakeFinancialOutboxPublisher(100, f.dependencies).ready).rejects.toThrow(
      'PERSISTENCE_UNCONFIRMED'
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('owns and drains the initial publication when shutdown interrupts startup', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let complete!: (value: FakeFinancialOutboxPublisherResult) => void;
    let signal: AbortSignal | undefined;
    f.runOnce.mockImplementationOnce(async (current) => {
      signal = current;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const handle = startFakeFinancialOutboxPublisher(100, f.dependencies);
    const readiness = expect(handle.ready).rejects.toThrow('STARTUP_ABORTED');
    const stop = handle.stop();
    expect(signal?.aborted).toBe(true);
    complete(result());
    await stop;
    await readiness;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.runOnce).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('serializes ticks and aborts and drains in-flight work exactly once on shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const handle = startFakeFinancialOutboxPublisher(100, f.dependencies);
    await handle.ready;
    let complete!: (value: FakeFinancialOutboxPublisherResult) => void;
    let signal: AbortSignal | undefined;
    f.runOnce.mockImplementationOnce(async (current) => {
      signal = current;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    expect(handle.status().running).toBe(true);
    const stop = handle.stop();
    expect(handle.stop()).toBe(stop);
    expect(signal?.aborted).toBe(true);
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    complete(result());
    await stop;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    expect(handle.status()).toMatchObject({
      stopped: true,
      running: false,
      consecutiveFailures: 0,
    });
    expect(Object.isFrozen(handle.status())).toBe(true);
    expect(Object.isFrozen(handle.status().lastResult)).toBe(true);
  });
  it('reports one failure per completed tick and resets after a successful later tick', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const handle = startFakeFinancialOutboxPublisher(100, f.dependencies);
    await handle.ready;
    let reject!: (error: Error) => void;
    f.runOnce.mockImplementationOnce(
      async () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    await vi.advanceTimersByTimeAsync(500);
    reject(new Error('CONNECTION_ACK_LOST'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onError).toHaveBeenCalledOnce();
    expect(handle.status().consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(handle.status().consecutiveFailures).toBe(0);
    await handle.stop();
  });
  it('contains a failing error reporter and preserves failure status', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const handle = startFakeFinancialOutboxPublisher(100, f.dependencies);
    await handle.ready;
    f.onError.mockImplementation(() => {
      throw new Error('LOGGER_FAILURE');
    });
    f.runOnce.mockResolvedValueOnce({ ...result(), persistenceErrors: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(handle.status().consecutiveFailures).toBe(1);
    expect(f.onError).toHaveBeenCalledOnce();
    await handle.stop();
  });
  it('propagates active-operation failure to shutdown while cancelling later ticks', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const handle = startFakeFinancialOutboxPublisher(100, f.dependencies);
    await handle.ready;
    let reject!: (error: Error) => void;
    f.runOnce.mockImplementationOnce(
      async () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    await vi.advanceTimersByTimeAsync(100);
    const stopped = expect(handle.stop()).rejects.toThrow('COMMIT_ACK_LOST');
    reject(new Error('COMMIT_ACK_LOST'));
    await stopped;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    expect(handle.status().stopped).toBe(true);
  });
});
