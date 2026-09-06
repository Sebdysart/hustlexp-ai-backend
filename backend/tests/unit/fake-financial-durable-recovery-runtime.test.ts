import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeFinancialDurableRecovery } from '../../src/jobs/fake-financial-durable-recovery-runtime.js';
const result = (held = 0, sweepCompleted = true) => ({
  scanned: 1,
  recovered: 0,
  transportConfirmed: 0,
  awaitingPublisher: 0,
  held,
  errors: 0,
  deferred: 0,
  sweepCompleted,
});
afterEach(() => {
  vi.useRealTimers();
});
describe('owned durable recovery loop', () => {
  it('keeps a held earlier page degraded through the sweep boundary and clears only a complete clean sweep', async () => {
    vi.useFakeTimers();
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(result(1, false))
      .mockResolvedValueOnce(result(0, true))
      .mockResolvedValue(result());
    const h = startFakeFinancialDurableRecovery(100, { recovery: { runOnce }, onError: vi.fn() });
    await h.ready;
    expect(h.health().status).toBe('degraded');
    await vi.advanceTimersByTimeAsync(100);
    expect(h.health().status).toBe('degraded');
    await vi.advanceTimersByTimeAsync(100);
    expect(h.health().status).toBe('healthy');
    await h.stop();
  });
  it('owns initial work and aborts/drains it before installing any timer', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let signal!: AbortSignal;
    const runOnce = vi.fn(async (value?: AbortSignal) => {
      signal = value!;
      await new Promise<void>((r) => {
        release = r;
      });
      return result();
    });
    const h = startFakeFinancialDurableRecovery(100, { recovery: { runOnce }, onError: vi.fn() });
    const ready = expect(h.ready).rejects.toThrow('STARTUP_ABORTED');
    const stop = h.stop();
    expect(h.stop()).toBe(stop);
    expect(signal.aborted).toBe(true);
    release();
    await stop;
    await ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledOnce();
    expect(h.health().status).toBe('stopped');
  });
  it('serializes slow pages and drains before shutdown resolves', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return result();
      });
    const h = startFakeFinancialDurableRecovery(100, { recovery: { runOnce }, onError: vi.fn() });
    await h.ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stop = h.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
  });
  it('rejects failed initial authority and cannot report healthy startup', async () => {
    const runOnce = vi.fn().mockRejectedValue(new Error('AUTHORITY_DENIED'));
    const h = startFakeFinancialDurableRecovery(100, { recovery: { runOnce }, onError: vi.fn() });
    await expect(h.ready).rejects.toThrow('AUTHORITY_DENIED');
    expect(h.health().status).toBe('degraded');
    await h.stop();
  });
});
