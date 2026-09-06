import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { workerLogger as log } from '../logger.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import { createFakeFinancialOutboxTransport } from './queues.js';
import {
  FakeFinancialOutboxPublisher,
  PostgresFakeFinancialOutboxRepository,
  type FakeFinancialOutboxPublisherResult,
} from './fake-financial-outbox-publisher.js';

export interface FakeFinancialPublisherHandle {
  readonly ready: Promise<void>;
  stop(): Promise<void>;
  status(): Readonly<{
    stopped: boolean;
    running: boolean;
    lastResult: FakeFinancialOutboxPublisherResult | null;
    consecutiveFailures: number;
  }>;
}

/** Own one serialized publisher loop. Claim sockets are bounded by the transport;
 * stopping aborts publication and drains the active database/Redis operation. */
export function startFakeFinancialOutboxPublisher(
  intervalMs = 5_000,
  dependencies?: {
    publisher: Pick<FakeFinancialOutboxPublisher, 'runOnce'>;
    onError: () => void;
  }
): FakeFinancialPublisherHandle {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000)
    throw new Error('FAKE_FINANCIAL_PUBLISHER_INTERVAL_INVALID');
  const publisher =
    dependencies?.publisher ??
    new FakeFinancialOutboxPublisher(
      new PostgresFakeFinancialOutboxRepository(db),
      createFakeFinancialOutboxTransport(),
      () => {
        assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
      },
      { publisherId: randomUUID() }
    );
  const onError =
    dependencies?.onError ?? (() => log.error('Fake-financial outbox publisher requires recovery'));
  const controller = new AbortController();
  let inFlight: Promise<void> | null = null;
  let lastResult: FakeFinancialOutboxPublisherResult | null = null;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        lastResult = Object.freeze(await publisher.runOnce(controller.signal));
        if (lastResult.persistenceErrors > 0)
          throw new Error('FAKE_FINANCIAL_PUBLISHER_PERSISTENCE_UNCONFIRMED');
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures++;
        throw error;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  // A failed initial authority/read/commit check cannot report successful startup.
  const ready = tick().then(() => {
    if (controller.signal.aborted) throw new Error('FAKE_FINANCIAL_PUBLISHER_STARTUP_ABORTED');
    timer = setInterval(() => {
      if (inFlight) return;
      void tick().catch(() => {
        try {
          onError();
        } catch {
          /* Error reporting cannot create an unhandled timer rejection. */
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
    status: () =>
      Object.freeze({
        stopped: controller.signal.aborted,
        running: inFlight !== null,
        lastResult,
        consecutiveFailures,
      }),
  });
}
