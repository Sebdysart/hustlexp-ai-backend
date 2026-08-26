import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, writeToOutbox } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  writeToOutbox: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { query: mockQuery } }));
vi.mock('../../src/logger', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/lib/outbox-helpers.js', () => ({ writeToOutbox }));

import {
  claimStripeEventInbox,
  finalizeStripeEventInboxClaim,
  requireExactStripeEventOutboxKey,
  releaseStripeEventInboxClaim,
  STRIPE_EVENT_INBOX_LEASE_MINUTES,
} from '../../src/jobs/StripeEventInboxLease';
import { recoverStuckStripeEvents } from '../../src/jobs/maintenance-worker';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  writeToOutbox.mockResolvedValue({ id: 'recovery-outbox', idempotencyKey: 'recovery-key' });
});

describe('Stripe inbox claim lease fencing', () => {
  it('derives one deterministic full-SHA BullMQ transport ID without colons', () => {
    const first = outboxTransportJobId('stripe.event_received:evt_lease');
    const replay = outboxTransportJobId('stripe.event_received:evt_lease');
    const other = outboxTransportJobId('stripe.event_received:evt_other');

    expect(first).toMatch(/^hxoutbox-[a-f0-9]{64}$/u);
    expect(first).not.toContain(':');
    expect(replay).toBe(first);
    expect(other).not.toBe(first);
  });

  it('accepts only a canonical or generated recovery key bound to the BullMQ job ID', () => {
    expect(requireExactStripeEventOutboxKey(
      { id: outboxTransportJobId('stripe.event_received:evt_lease') } as Job,
      { _outbox_key: 'stripe.event_received:evt_lease' },
      'evt_lease',
    )).toBe('stripe.event_received:evt_lease');
    expect(requireExactStripeEventOutboxKey(
      {
        id: outboxTransportJobId(
          'stripe.event_received.recovery:evt_lease:1787668800000',
        ),
      } as Job,
      { _outbox_key: 'stripe.event_received.recovery:evt_lease:1787668800000' },
      'evt_lease',
    )).toBe('stripe.event_received.recovery:evt_lease:1787668800000');
  });

  it.each([
    ['forged job ID', 'stripe.event_received:evt_lease', 'forged-job'],
    [
      'wrong event key',
      'stripe.event_received:evt_other',
      outboxTransportJobId('stripe.event_received:evt_other'),
    ],
    [
      'unbounded recovery suffix',
      'stripe.event_received.recovery:evt_lease:not-a-generation',
      outboxTransportJobId('stripe.event_received.recovery:evt_lease:not-a-generation'),
    ],
  ])('rejects %s before inbox state can be claimed', (_label, key, jobId) => {
    expect(() => requireExactStripeEventOutboxKey(
      { id: jobId } as Job,
      { _outbox_key: key },
      'evt_lease',
    )).toThrow('JOB_IDENTITY_INVALID');
  });

  it('claims an unowned row or atomically rotates only an expired processing lease', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        stripe_event_id: 'evt_lease',
        type: 'transfer.reversed',
        payload_json: { id: 'evt_lease' },
      }],
      rowCount: 1,
    });

    const claim = await claimStripeEventInbox('evt_lease');

    expect(claim?.claimToken).toMatch(/^STRIPE_EVENT_CLAIM:/);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('claimed_at=NOW()');
    expect(sql).toContain('claimed_at IS NULL');
    expect(sql).toContain("result='processing'");
    expect(sql).toContain("claimed_at < NOW() - INTERVAL '1 minute' * $3");
    expect(params).toEqual([
      'evt_lease',
      claim?.claimToken,
      STRIPE_EVENT_INBOX_LEASE_MINUTES,
    ]);
  });

  it('does not steal a fresh processing lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 });

    await expect(claimStripeEventInbox('evt_fresh')).resolves.toBeNull();

    expect(String(mockQuery.mock.calls[0]?.[0])).toContain(
      "claimed_at < NOW() - INTERVAL '1 minute' * $3",
    );
  });

  it('rejects a stale worker terminal ACK after another worker rotates the token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(finalizeStripeEventInboxClaim({
      stripeEventId: 'evt_lease',
      claimToken: 'STRIPE_EVENT_CLAIM:old',
      result: 'success',
    })).rejects.toThrow('STRIPE_EVENT_INBOX_CLAIM_LOST');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("result = 'processing'");
    expect(sql).toContain('processed_at IS NULL');
    expect(sql).toContain('error_message=$2');
    expect(params).toContain('STRIPE_EVENT_CLAIM:old');
  });

  it('cannot release or overwrite a newer claim with an obsolete token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(releaseStripeEventInboxClaim({
      stripeEventId: 'evt_lease',
      claimToken: 'STRIPE_EVENT_CLAIM:old',
      errorMessage: 'old worker failed late',
    })).resolves.toBe(false);

    const sql = String(mockQuery.mock.calls[0]?.[0]);
    expect(sql).toContain('claimed_at = NULL');
    expect(sql).toContain('error_message=$2');
    expect(sql).toContain('processed_at IS NULL');
  });
});

describe('Stripe inbox hard-crash recovery', () => {
  it('requeues an expired claim through the signed canonical dispatcher without clearing durable state', async () => {
    const claimedAt = new Date('2026-08-25T12:00:00.000Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{
        stripe_event_id: 'evt_crashed',
        type: 'transfer.reversed',
        claimed_at: claimedAt,
      }],
      rowCount: 1,
    });

    await recoverStuckStripeEvents({ data: { timeoutMinutes: 10, limit: 500 } } as Job);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql.trimStart()).toMatch(/^SELECT stripe_event_id,type,claimed_at/);
    expect(sql).not.toContain('claimed_at = NULL');
    expect(params).toEqual([10, 100]);
    expect(writeToOutbox).toHaveBeenCalledWith({
      eventType: 'stripe.event_received',
      aggregateType: 'stripe_event',
      aggregateId: 'evt_crashed',
      eventVersion: 1,
      idempotencyKey: `stripe.event_received.recovery:evt_crashed:${claimedAt.getTime()}`,
      payload: { stripeEventId: 'evt_crashed', type: 'transfer.reversed' },
      queueName: 'critical_payments',
    });
  });

  it('leaves the stale row discoverable when queue delivery fails', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        stripe_event_id: 'evt_crashed',
        type: 'payout.failed',
        claimed_at: new Date('2026-08-25T12:00:00.000Z'),
      }],
      rowCount: 1,
    });
    writeToOutbox.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(recoverStuckStripeEvents({ data: { timeoutMinutes: 10 } } as Job))
      .rejects.toThrow('STRIPE_EVENT_RECOVERY_REQUEUE_FAILED');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0]?.[0])).not.toContain('UPDATE stripe_events');
  });

  it('does not queue fresh or terminal inbox rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await recoverStuckStripeEvents({ data: { timeoutMinutes: 10 } } as Job);

    expect(writeToOutbox).not.toHaveBeenCalled();
  });
});
