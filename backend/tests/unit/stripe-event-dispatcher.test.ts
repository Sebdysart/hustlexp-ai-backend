import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));

const { processPaymentJob, processPayoutEventJob, processStripeEventJob } = vi.hoisted(() => ({
  processPaymentJob: vi.fn(),
  processPayoutEventJob: vi.fn(),
  processStripeEventJob: vi.fn(),
}));

vi.mock('../../src/jobs/payout-event-worker.js', () => ({
  isPayoutEventType: (type: string) => type.startsWith('payout.'),
  processPayoutEventJob,
}));
vi.mock('../../src/jobs/payment-worker.js', () => ({ processPaymentJob }));
vi.mock('../../src/jobs/stripe-event-worker.js', () => ({ processStripeEventJob }));

import { db } from '../../src/db';
import { processStripeEventDispatchJob } from '../../src/jobs/stripe-event-dispatcher';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';

const mockDb = vi.mocked(db);

function makeJob(type?: string): Job {
  const outboxKey = 'stripe.event_received:evt_dispatch';
  return {
    id: outboxTransportJobId(outboxKey),
    data: {
      aggregate_id: 'evt_dispatch',
      payload: {
        stripeEventId: 'evt_dispatch',
        type,
        _outbox_key: outboxKey,
        _sig: 'signed',
      },
    },
  } as Job;
}

beforeEach(() => vi.clearAllMocks());

describe('Stripe event dispatcher', () => {
  it('routes payout events to the isolated provider-payout worker', async () => {
    const job = makeJob('payout.failed');
    await processStripeEventDispatchJob(job);
    expect(processPayoutEventJob).toHaveBeenCalledWith(job);
    expect(processStripeEventJob).not.toHaveBeenCalled();
  });

  it('normalizes signed outbox payload fields for the legacy worker', async () => {
    await processStripeEventDispatchJob(makeJob('invoice.paid'));
    expect(processStripeEventJob).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        stripeEventId: 'evt_dispatch',
        type: 'invoice.paid',
      }),
    }));
  });

  it.each([
    'payment_intent.payment_failed',
    'transfer.created',
    'transfer.failed',
    'transfer.reversed',
    'charge.refunded',
  ])('routes %s to the authoritative payment lifecycle worker', async (type) => {
    const job = makeJob(type);
    await processStripeEventDispatchJob(job);
    expect(processPaymentJob).toHaveBeenCalledWith(job);
    expect(processPayoutEventJob).not.toHaveBeenCalled();
    expect(processStripeEventJob).not.toHaveBeenCalled();
  });

  it('preserves an exact valid financial signature while routing transfer.reversed', async () => {
    const { signJobPayload, verifyJobSignature } = await vi.importActual<
      typeof import('../../src/jobs/queues')
    >('../../src/jobs/queues');
    const outboxKey = 'stripe.event_received:evt_dispatch';
    const payload = {
      stripeEventId: 'evt_dispatch',
      type: 'transfer.reversed',
      _outbox_key: outboxKey,
    };
    const signature = signJobPayload(payload);
    const job = {
      id: outboxTransportJobId(outboxKey),
      data: {
        aggregate_id: 'evt_dispatch',
        payload: { ...payload, _sig: signature },
      },
    } as Job;

    await processStripeEventDispatchJob(job);

    expect(processPaymentJob).toHaveBeenCalledWith(job);
    const forwarded = (vi.mocked(processPaymentJob).mock.calls[0]?.[0].data as {
      payload: Record<string, unknown>;
    }).payload;
    const { _sig, ...unsigned } = forwarded;
    expect(verifyJobSignature(unsigned, String(_sig))).toBe(true);
    expect(unsigned).toEqual(payload);
  });

  it('keeps payment_intent.succeeded on the single entitlement and escrow-funding worker', async () => {
    await processStripeEventDispatchJob(makeJob('payment_intent.succeeded'));
    expect(processStripeEventJob).toHaveBeenCalledTimes(1);
    expect(processPaymentJob).not.toHaveBeenCalled();
  });

  it('uses the stored type when an older signed payload omits it', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ type: 'payout.paid' }], rowCount: 1 } as never);
    const job = makeJob();
    await processStripeEventDispatchJob(job);
    expect(processPayoutEventJob).toHaveBeenCalledWith(job);
  });
});
