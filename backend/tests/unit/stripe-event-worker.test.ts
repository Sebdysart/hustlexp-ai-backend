/**
 * stripe-event-worker unit tests
 *
 * Covers new event handlers added in the P1 revenue-leak fix:
 * - invoice.paid       → RevenueService.logEvent subscription renewal
 * - charge.dispute.created  → ChargebackService.handleDisputeCreated
 * - charge.dispute.updated  → ChargebackService.handleDisputeUpdated
 * - charge.dispute.closed   → ChargebackService.handleDisputeClosed
 *
 * Critical bug fix (payment_intent.succeeded escrow funding):
 * - payment_intent.succeeded → EscrowService.fund (PENDING → FUNDED)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    // transaction executes the callback with a per-transaction query function.
    // We expose the inner txQuery as a spy so tests can control its responses.
    transaction: vi.fn(async (fn: (q: ReturnType<typeof vi.fn>) => Promise<unknown>) => {
      const txQuery = vi.fn();
      // Attach txQuery to the module-level ref so individual tests can prime it
      (globalThis as Record<string, unknown>).__txQuery = txQuery;
      return fn(txQuery);
    }),
  },
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/services/StripeSubscriptionProcessor.js', () => ({
  processSubscriptionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/StripeEntitlementProcessor.js', () => ({
  processEntitlementPurchase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/services/ChargebackService.js', () => ({
  ChargebackService: {
    handleDisputeCreated: vi.fn().mockResolvedValue({ success: true, data: { paymentDisputeId: 'pd-1' } }),
    handleDisputeUpdated: vi.fn().mockResolvedValue({ success: true, data: { updated: true } }),
    handleDisputeClosed: vi.fn().mockResolvedValue({ success: true, data: { resolved: true } }),
  },
}));

vi.mock('../../src/services/EscrowService.js', () => ({
  EscrowService: {
    fund: vi.fn().mockResolvedValue({ success: true, data: { id: 'escrow-1', state: 'FUNDED' } }),
  },
}));

vi.mock('../../src/jobs/queues.js', () => ({
  verifyJobSignature: vi.fn(() => true),
  signJobPayload: vi.fn((payload: Record<string, unknown>) => ({ ...payload, _sig: 'test-sig' })),
}));

import { db } from '../../src/db';
import { processStripeEventJob } from '../../src/jobs/stripe-event-worker';
import { RevenueService } from '../../src/services/RevenueService.js';
import { ChargebackService } from '../../src/services/ChargebackService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import { verifyJobSignature } from '../../src/jobs/queues.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(type: string, eventObject: Record<string, unknown>): Job {
  return { data: { stripeEventId: 'evt_test_123', type, payload: { _sig: 'test-sig' } } } as unknown as Job;
}

function setupClaim(type: string, eventObject: Record<string, unknown>) {
  // claim query (UPDATE ... WHERE claimed_at IS NULL) → returns the event
  mockDb.query.mockResolvedValueOnce({
    rows: [{ payload_json: { id: 'evt_test_123', data: { object: eventObject } }, type }],
    rowCount: 1,
  } as never);
  // success update (result = 'success')
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('processStripeEventJob', () => {
  // -------------------------------------------------------------------------
  // invoice.paid
  // -------------------------------------------------------------------------
  describe('invoice.paid', () => {
    it('logs subscription renewal revenue when amount_paid > 0', async () => {
      const invoice = { metadata: { user_id: 'user-abc' }, amount_paid: 999 };
      setupClaim('invoice.paid', invoice);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).toHaveBeenCalledWith({
        eventType: 'subscription',
        userId: 'user-abc',
        amountCents: 999,
        stripeEventId: 'evt_test_123',
      });
    });

    it('skips logEvent when amount_paid is 0', async () => {
      const invoice = { metadata: { user_id: 'user-abc' }, amount_paid: 0 };
      setupClaim('invoice.paid', invoice);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).not.toHaveBeenCalled();
    });

    it('resolves user via stripe_customer_id when user_id metadata is absent', async () => {
      const invoice = { metadata: {}, amount_paid: 999, customer: 'cus_abc' };
      // claim query → event
      mockDb.query.mockResolvedValueOnce({
        rows: [{ payload_json: { id: 'evt_test_123', data: { object: invoice } }, type: 'invoice.paid' }],
        rowCount: 1,
      } as never);
      // customer lookup → found
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'user-from-customer' }],
        rowCount: 1,
      } as never);
      // success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).toHaveBeenCalledWith({
        eventType: 'subscription',
        userId: 'user-from-customer',
        amountCents: 999,
        stripeEventId: 'evt_test_123',
      });
    });

    it('logs revenue with system userId when user_id missing and customer lookup finds no match', async () => {
      const invoice = { metadata: {}, amount_paid: 999, customer: 'cus_unknown' };
      // claim query → event
      mockDb.query.mockResolvedValueOnce({
        rows: [{ payload_json: { id: 'evt_test_123', data: { object: invoice } }, type: 'invoice.paid' }],
        rowCount: 1,
      } as never);
      // customer lookup → not found
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as never);
      // success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'subscription',
          userId: 'system',
          amountCents: 999,
          stripeEventId: 'evt_test_123',
          metadata: expect.objectContaining({ unresolved_user: true }),
        })
      );
    });

    it('logs revenue with system userId when user_id and customer are both absent', async () => {
      // No customer field — no DB lookup, goes straight to system fallback
      const invoice = { metadata: {}, amount_paid: 500 };
      // claim query → event
      mockDb.query.mockResolvedValueOnce({
        rows: [{ payload_json: { id: 'evt_test_123', data: { object: invoice } }, type: 'invoice.paid' }],
        rowCount: 1,
      } as never);
      // success UPDATE (no customer lookup in between)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'system',
          amountCents: 500,
        })
      );
    });

    it('skips logEvent when amount_paid is 0 even with metadata present', async () => {
      const invoice = { metadata: { user_id: 'user-abc' }, amount_paid: 0 };
      setupClaim('invoice.paid', invoice);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // charge.dispute.created
  // -------------------------------------------------------------------------
  describe('charge.dispute.created', () => {
    it('calls ChargebackService.handleDisputeCreated with correct params', async () => {
      const dispute = {
        id: 'dp_abc',
        charge: 'ch_abc',
        payment_intent: 'pi_abc',
        amount: 5000,
        currency: 'usd',
        reason: 'fraudulent',
        status: 'needs_response',
      };
      setupClaim('charge.dispute.created', dispute);

      await processStripeEventJob(makeJob('charge.dispute.created', dispute));

      expect(ChargebackService.handleDisputeCreated).toHaveBeenCalledWith({
        stripeDisputeId: 'dp_abc',
        stripeChargeId: 'ch_abc',
        stripePaymentIntentId: 'pi_abc',
        stripeEventId: 'evt_test_123',
        amountCents: 5000,
        currency: 'usd',
        reason: 'fraudulent',
      });
    });

    it('passes null payment_intent when missing', async () => {
      const dispute = {
        id: 'dp_abc',
        charge: 'ch_abc',
        payment_intent: null,
        amount: 5000,
        currency: 'usd',
        reason: null,
        status: 'needs_response',
      };
      setupClaim('charge.dispute.created', dispute);

      await processStripeEventJob(makeJob('charge.dispute.created', dispute));

      expect(ChargebackService.handleDisputeCreated).toHaveBeenCalledWith(
        expect.objectContaining({ stripePaymentIntentId: null, reason: null })
      );
    });
  });

  // -------------------------------------------------------------------------
  // charge.dispute.updated
  // -------------------------------------------------------------------------
  describe('charge.dispute.updated', () => {
    it('calls ChargebackService.handleDisputeUpdated', async () => {
      const dispute = {
        id: 'dp_abc',
        status: 'under_review',
        reason: 'fraudulent',
      };
      setupClaim('charge.dispute.updated', dispute);

      await processStripeEventJob(makeJob('charge.dispute.updated', dispute));

      expect(ChargebackService.handleDisputeUpdated).toHaveBeenCalledWith({
        stripeDisputeId: 'dp_abc',
        stripeEventId: 'evt_test_123',
        status: 'under_review',
        reason: 'fraudulent',
      });
    });
  });

  // -------------------------------------------------------------------------
  // charge.dispute.closed
  // -------------------------------------------------------------------------
  describe('charge.dispute.closed', () => {
    it('calls ChargebackService.handleDisputeClosed with status "won"', async () => {
      const dispute = {
        id: 'dp_abc',
        status: 'won',
        reason: 'fraudulent',
      };
      setupClaim('charge.dispute.closed', dispute);

      await processStripeEventJob(makeJob('charge.dispute.closed', dispute));

      expect(ChargebackService.handleDisputeClosed).toHaveBeenCalledWith({
        stripeDisputeId: 'dp_abc',
        stripeEventId: 'evt_test_123',
        status: 'won',
        reason: 'fraudulent',
      });
    });

    it('calls ChargebackService.handleDisputeClosed with status "lost" for non-won outcomes', async () => {
      const dispute = {
        id: 'dp_abc',
        status: 'lost',
        reason: null,
      };
      setupClaim('charge.dispute.closed', dispute);

      await processStripeEventJob(makeJob('charge.dispute.closed', dispute));

      expect(ChargebackService.handleDisputeClosed).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'lost' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // payment_intent.succeeded — escrow PENDING → FUNDED (critical bug fix)
  //
  // After deadlock fix: the escrow SELECT is a plain db.query() (no transaction,
  // no FOR UPDATE). EscrowService.fund() handles its own locking internally.
  // All three DB calls (claim UPDATE, escrow SELECT, status UPDATE) go through
  // the same mockDb.query, queued with mockResolvedValueOnce.
  // -------------------------------------------------------------------------
  describe('payment_intent.succeeded', () => {
    const paymentIntent = { id: 'pi_test_abc', amount: 5000 };

    /** Helper: prime the claim query (call 1 of 3) */
    function setupPaymentIntentSucceededClaim() {
      // 1. Atomic claim UPDATE → returns event row
      mockDb.query.mockResolvedValueOnce({
        rows: [{ payload_json: { id: 'evt_pi_1', data: { object: paymentIntent } }, type: 'payment_intent.succeeded' }],
        rowCount: 1,
      } as never);
    }

    /** Helper: prime the escrow SELECT query (call 2 of 3) */
    function primeEscrowSelect(rows: { id: string }[]) {
      // 2. Plain SELECT (no FOR UPDATE, no transaction) → escrow lookup result
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: rows.length } as never);
    }

    it('calls EscrowService.fund with the correct escrowId and paymentIntentId when a PENDING escrow exists', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT → PENDING escrow found
      primeEscrowSelect([{ id: 'escrow-1' }]);
      // 3. Final success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      expect(EscrowService.fund).toHaveBeenCalledWith({
        escrowId: 'escrow-1',
        stripePaymentIntentId: 'pi_test_abc',
      });
    });

    it('skips EscrowService.fund (no-op) when no PENDING escrow exists for the payment intent', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT → no rows (entitlement-only or already funded)
      primeEscrowSelect([]);
      // 3. Final success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      expect(EscrowService.fund).not.toHaveBeenCalled();
    });

    it('throws and marks event failed when EscrowService.fund returns an error', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT → PENDING escrow found
      primeEscrowSelect([{ id: 'escrow-1' }]);
      // EscrowService.fund returns failure
      vi.mocked(EscrowService.fund).mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Cannot fund escrow: current state is FUNDED, expected PENDING' },
      });
      // 3. Error UPDATE (claimed_at = NULL, result = 'failed') — no processed_at
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent))
      ).rejects.toThrow('Cannot fund escrow: current state is FUNDED, expected PENDING');
    });

    it('on transient error: sets result=failed, resets claimed_at to NULL, and does NOT set processed_at', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT → PENDING escrow found
      primeEscrowSelect([{ id: 'escrow-1' }]);
      // EscrowService.fund throws a transient error
      vi.mocked(EscrowService.fund).mockRejectedValueOnce(new Error('DB connection timeout'));
      // 3. Error UPDATE — capture what was called
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent))
      ).rejects.toThrow('DB connection timeout');

      // The last db.query call must be the error UPDATE
      const calls = mockDb.query.mock.calls;
      const errorUpdateCall = calls[calls.length - 1];
      const sql: string = errorUpdateCall[0] as string;
      // MUST reset claimed_at to NULL — this releases the distributed lock so the
      // next BullMQ retry can pass the "WHERE claimed_at IS NULL AND processed_at IS NULL"
      // pick-up guard. Without this reset, retries exit as no-ops (R24 regression).
      // Idempotency is guaranteed by processed_stripe_events INSERT ON CONFLICT, not claimed_at.
      expect(sql).toContain('claimed_at = NULL');
      // Must NOT tombstone with processed_at — that would silently drop all retries
      expect(sql).not.toContain('processed_at');
      // Must record the failure
      expect(sql).toContain("result = 'failed'");
    });

    it('on success: sets processed_at via the success UPDATE (not in catch)', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT → no PENDING escrow (simple success path)
      primeEscrowSelect([]);
      // 3. Success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      const calls = mockDb.query.mock.calls;
      const successUpdateCall = calls[calls.length - 1];
      const sql: string = successUpdateCall[0] as string;
      expect(sql).toContain('processed_at = NOW()');
      expect(sql).toContain("result = 'success'");
    });

    it('after error: error UPDATE resets claimed_at to NULL so BullMQ retry can re-claim the event', async () => {
      // Simulate first attempt: fails with transient error
      setupPaymentIntentSucceededClaim();
      primeEscrowSelect([{ id: 'escrow-1' }]);
      vi.mocked(EscrowService.fund).mockRejectedValueOnce(new Error('transient error'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent))
      ).rejects.toThrow('transient error');

      // Verify claimed_at IS reset to NULL so the next BullMQ retry can pass the
      // "WHERE claimed_at IS NULL AND processed_at IS NULL" pick-up guard.
      // Idempotency is guaranteed by processed_stripe_events INSERT ON CONFLICT,
      // not by claimed_at — claimed_at is only a distributed lock, not a lifetime key.
      const firstErrorUpdate = mockDb.query.mock.calls[mockDb.query.mock.calls.length - 1];
      expect((firstErrorUpdate[0] as string)).toContain('claimed_at = NULL');
    });

    it('also calls processEntitlementPurchase alongside escrow funding', async () => {
      const { processEntitlementPurchase } = await import('../../src/services/StripeEntitlementProcessor.js');
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT → PENDING escrow found
      primeEscrowSelect([{ id: 'escrow-1' }]);
      // 3. Final success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      expect(processEntitlementPurchase).toHaveBeenCalled();
      expect(EscrowService.fund).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist guard — unrecognized event types must be skipped
  // -------------------------------------------------------------------------
  describe('allowlist guard', () => {
    it('skips and marks result=skipped for an unrecognized event type', async () => {
      // claim query → returns the unknown event
      mockDb.query.mockResolvedValueOnce({
        rows: [{ payload_json: { id: 'evt_test_123', data: { object: {} } }, type: 'payment_intent.unknown_future_type' }],
        rowCount: 1,
      } as never);
      // skipped UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.unknown_future_type', {}));

      // No handler should have been called
      expect(RevenueService.logEvent).not.toHaveBeenCalled();
      expect(ChargebackService.handleDisputeCreated).not.toHaveBeenCalled();
      expect(EscrowService.fund).not.toHaveBeenCalled();

      // The second DB call must be the 'skipped' UPDATE with processed_at
      const calls = mockDb.query.mock.calls;
      const skipUpdateCall = calls[calls.length - 1];
      const sql: string = skipUpdateCall[0] as string;
      expect(sql).toContain("result = 'skipped'");
      expect(sql).toContain('processed_at = NOW()');
    });
  });

  // -------------------------------------------------------------------------
  // Already processed — no-op
  // -------------------------------------------------------------------------
  it('returns early when event is already claimed', async () => {
    // claim query returns 0 rows → already processed
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await processStripeEventJob(makeJob('invoice.paid', {}));

    expect(RevenueService.logEvent).not.toHaveBeenCalled();
    expect(ChargebackService.handleDisputeCreated).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // BUG H7 — missing _sig must be rejected immediately (Redis injection defence)
  // -------------------------------------------------------------------------
  describe('_sig mandatory enforcement (BUG H7)', () => {
    function makeJobWithPayload(type: string, payload: Record<string, unknown>): Job {
      return { data: { stripeEventId: 'evt_test_123', type, payload } } as unknown as Job;
    }

    it('throws "Missing _sig — job signature required" when payload exists but _sig is absent', async () => {
      const job = makeJobWithPayload('invoice.paid', { some_field: 'some_value' });
      await expect(processStripeEventJob(job)).rejects.toThrow('Missing _sig — job signature required');
      // No DB claim must have been attempted
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('throws "Missing _sig — job signature required" when _sig is an empty string', async () => {
      const job = makeJobWithPayload('invoice.paid', { some_field: 'some_value', _sig: '' });
      await expect(processStripeEventJob(job)).rejects.toThrow('Missing _sig — job signature required');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('throws JOB_SIGNATURE_INVALID when _sig is present but tampered', async () => {
      // Override the mock to simulate a failed HMAC verification for this test only
      vi.mocked(verifyJobSignature).mockReturnValueOnce(false);
      const job = makeJobWithPayload('invoice.paid', { some_field: 'some_value', _sig: 'a'.repeat(64) });
      await expect(processStripeEventJob(job)).rejects.toThrow('JOB_SIGNATURE_INVALID');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('rejects jobs without a payload object (unsigned direct-inject path)', async () => {
      // Jobs without payload wrapper are unsigned — must be rejected (Redis injection defence)
      const job = { data: { stripeEventId: 'evt_test_123', type: 'invoice.paid' } } as unknown as Job;
      await expect(processStripeEventJob(job)).rejects.toThrow('Missing or invalid job payload');
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });
});
