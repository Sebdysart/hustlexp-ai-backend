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

import { db } from '../../src/db';
import { processStripeEventJob } from '../../src/jobs/stripe-event-worker';
import { RevenueService } from '../../src/services/RevenueService.js';
import { ChargebackService } from '../../src/services/ChargebackService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(type: string, eventObject: Record<string, unknown>): Job {
  return { data: { stripeEventId: 'evt_test_123', type } } as unknown as Job;
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
  // After Bug 2 fix: the SELECT FOR UPDATE + EscrowService.fund call happens inside
  // db.transaction(). The transaction mock passes a per-call txQuery spy to the
  // callback; we prime that txQuery for the escrow SELECT. The outer mockDb.query
  // still handles the atomic claim UPDATE and the success/error status UPDATEs.
  // -------------------------------------------------------------------------
  describe('payment_intent.succeeded', () => {
    const paymentIntent = { id: 'pi_test_abc', amount: 5000 };

    /** Helper: prime the outer claim query */
    function setupPaymentIntentSucceededClaim() {
      // 1. Atomic claim UPDATE → returns event row
      mockDb.query.mockResolvedValueOnce({
        rows: [{ payload_json: { id: 'evt_pi_1', data: { object: paymentIntent } }, type: 'payment_intent.succeeded' }],
        rowCount: 1,
      } as never);
    }

    /** Helper: prime txQuery (inner transaction query) for the escrow SELECT */
    function primeTxEscrowSelect(rows: { id: string }[]) {
      // The transaction mock captures txQuery in globalThis.__txQuery before calling fn.
      // We schedule a one-shot implementation that will apply when txQuery is first called
      // inside the transaction callback (the SELECT FOR UPDATE).
      const origTransaction = vi.mocked(mockDb.transaction);
      origTransaction.mockImplementationOnce(async (fn) => {
        const txQuery = vi.fn().mockResolvedValueOnce({ rows, rowCount: rows.length });
        return fn(txQuery as never);
      });
    }

    it('calls EscrowService.fund with the correct escrowId and paymentIntentId when a PENDING escrow exists', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT FOR UPDATE (inside transaction) → PENDING escrow found
      primeTxEscrowSelect([{ id: 'escrow-1' }]);
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
      // 2. Escrow SELECT FOR UPDATE → no rows (entitlement-only or already funded)
      primeTxEscrowSelect([]);
      // 3. Final success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      expect(EscrowService.fund).not.toHaveBeenCalled();
    });

    it('throws and marks event failed when EscrowService.fund returns an error', async () => {
      setupPaymentIntentSucceededClaim();
      // 2. Escrow SELECT FOR UPDATE → PENDING escrow found
      primeTxEscrowSelect([{ id: 'escrow-1' }]);
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

    it('on transient error: sets claimed_at=NULL and result=failed, does NOT set processed_at', async () => {
      setupPaymentIntentSucceededClaim();
      // Escrow SELECT FOR UPDATE → PENDING escrow
      primeTxEscrowSelect([{ id: 'escrow-1' }]);
      // EscrowService.fund throws a transient error
      vi.mocked(EscrowService.fund).mockRejectedValueOnce(new Error('DB connection timeout'));
      // Error UPDATE — capture what was called
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent))
      ).rejects.toThrow('DB connection timeout');

      // The last db.query call must be the error UPDATE
      const calls = mockDb.query.mock.calls;
      const errorUpdateCall = calls[calls.length - 1];
      const sql: string = errorUpdateCall[0] as string;
      // Must reset claimed_at to NULL so BullMQ retries can re-claim
      expect(sql).toContain('claimed_at = NULL');
      // Must NOT tombstone with processed_at — that would silently drop all retries
      expect(sql).not.toContain('processed_at');
    });

    it('on success: sets processed_at via the success UPDATE (not in catch)', async () => {
      setupPaymentIntentSucceededClaim();
      // Escrow SELECT FOR UPDATE → no PENDING escrow (simple success path)
      primeTxEscrowSelect([]);
      // Success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      const calls = mockDb.query.mock.calls;
      const successUpdateCall = calls[calls.length - 1];
      const sql: string = successUpdateCall[0] as string;
      expect(sql).toContain('processed_at = NOW()');
      expect(sql).toContain("result = 'success'");
    });

    it('after error: BullMQ can re-claim because claimed_at is reset to NULL', async () => {
      // Simulate first attempt: fails with transient error
      setupPaymentIntentSucceededClaim();
      primeTxEscrowSelect([{ id: 'escrow-1' }]);
      vi.mocked(EscrowService.fund).mockRejectedValueOnce(new Error('transient error'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent))
      ).rejects.toThrow('transient error');

      // Verify claimed_at was reset (so next attempt can claim)
      const firstErrorUpdate = mockDb.query.mock.calls[mockDb.query.mock.calls.length - 1];
      expect((firstErrorUpdate[0] as string)).toContain('claimed_at = NULL');

      // Simulate second attempt (BullMQ retry): claim succeeds because claimed_at IS NULL
      vi.clearAllMocks();
      setupPaymentIntentSucceededClaim();
      primeTxEscrowSelect([]);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      // Should succeed on retry without throwing
      await expect(
        processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent))
      ).resolves.toBeUndefined();
    });

    it('also calls processEntitlementPurchase alongside escrow funding', async () => {
      const { processEntitlementPurchase } = await import('../../src/services/StripeEntitlementProcessor.js');
      setupPaymentIntentSucceededClaim();
      // Escrow SELECT FOR UPDATE → PENDING escrow
      primeTxEscrowSelect([{ id: 'escrow-1' }]);
      // Final success UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processStripeEventJob(makeJob('payment_intent.succeeded', paymentIntent));

      expect(processEntitlementPurchase).toHaveBeenCalled();
      expect(EscrowService.fund).toHaveBeenCalled();
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
});
