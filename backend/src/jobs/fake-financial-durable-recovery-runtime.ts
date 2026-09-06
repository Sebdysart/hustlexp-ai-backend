import { workerLogger as log } from '../logger.js';
import { createFakeFinancialOutboxTransport } from './queues.js';
import {
  createFakeFinancialDurableRecovery,
  type FakeFinancialDurableRecovery,
} from './fake-financial-durable-recovery.js';

export interface FakeFinancialDurableRecoveryHandle {
  readonly ready: Promise<void>;
  stop(): Promise<void>;
  health(): Readonly<{
    status: 'healthy' | 'degraded' | 'stopped';
    inFlight: boolean;
    consecutiveFailures: number;
    lastFailureCode: string | null;
  }>;
}

/** Synchronously owned startup, serialized pages and abort/drain shutdown. */
export function startFakeFinancialDurableRecovery(
  intervalMs = 5_000,
  dependencies?: { recovery: Pick<FakeFinancialDurableRecovery, 'runOnce'>; onError: () => void }
): FakeFinancialDurableRecoveryHandle {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000)
    throw new Error('FAKE_FINANCIAL_DURABLE_RECOVERY_INTERVAL_INVALID');
  const recovery =
    dependencies?.recovery ??
    createFakeFinancialDurableRecovery(createFakeFinancialOutboxTransport());
  const onError =
    dependencies?.onError ??
    (() => log.error('Fake-financial durable recovery requires attention'));
  const controller = new AbortController();
  let inFlight: Promise<void> | null = null,
    stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let healthy = false,
    sweepHasFailure = false,
    consecutiveFailures = 0;
  const tick = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await recovery.runOnce(controller.signal);
        const failed = result.errors > 0 || result.held > 0;
        sweepHasFailure ||= failed;
        if (failed) {
          healthy = false;
          consecutiveFailures++;
        }
        if (result.sweepCompleted) {
          healthy = !sweepHasFailure;
          if (healthy) consecutiveFailures = 0;
          sweepHasFailure = false;
        }
      } catch (error) {
        healthy = false;
        sweepHasFailure = true;
        consecutiveFailures++;
        throw error;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const ready = tick().then(() => {
    if (controller.signal.aborted)
      throw new Error('FAKE_FINANCIAL_DURABLE_RECOVERY_STARTUP_ABORTED');
    timer = setInterval(() => {
      if (inFlight) return;
      void tick().catch(() => {
        try {
          onError();
        } catch {
          /* Reporting cannot reject the timer. */
        }
      });
    }, intervalMs);
    timer.unref();
  });
  return Object.freeze({
    ready,
    stop: () => {
      if (stopping) return stopping;
      controller.abort();
      if (timer) clearInterval(timer);
      stopping = (async () => {
        if (inFlight) await inFlight;
      })();
      return stopping;
    },
    health: () =>
      Object.freeze({
        status: controller.signal.aborted
          ? ('stopped' as const)
          : healthy
            ? ('healthy' as const)
            : ('degraded' as const),
        inFlight: inFlight !== null,
        consecutiveFailures,
        lastFailureCode: healthy ? null : 'FAKE_FINANCIAL_DURABLE_RECOVERY_UNRESOLVED',
      }),
  });
}
