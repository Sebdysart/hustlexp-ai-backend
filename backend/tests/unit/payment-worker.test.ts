/**
 * payment-worker unit tests
 *
 * Critical bug-fix coverage:
 * - On transient error: claimed_at is reset to NULL, processed_at is NOT set
 *   (so BullMQ retries can re-claim the event)
 * - On success: processed_at is set via the success UPDATE only
 * - BullMQ retry after error: claim guard passes because claimed_at is NULL again
 * - Already-claimed/processed events: silent no-op
 * - transfer.created accepts LOCKED_DISPUTE state (Bug 3 fix — dispute-won path)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Use vi.hoisted so that mockQuery is available inside the vi.mock factory.
// vi.mock factories are hoisted above all imports (and above top-level const),
// so a plain `const mockQuery = vi.fn()` cannot be closed over inside them.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../../src/db', () => ({
  db: {
    query: mockQuery,
    transaction: vi.fn((fn: (trx: typeof mockQuery) => Promise<unknown>) => fn(mockQuery)),
  },
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  // F-15 FIX: payment-worker now imports StripeService which uses stripeLogger
  stripeLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/lib/outbox-helpers.js', () => ({
  writeToOutbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: {
    advanceProgress: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/services/PushNotificationService.js', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/jobs/queues.js', () => ({
  verifyJobSignature: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createTransferReversal: vi.fn().mockResolvedValue({ success: true, data: { reversalId: 'trr_test' } }),
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { processPaymentJob } from '../../src/jobs/payment-worker';
import { RevenueService } from '../../src/services/RevenueService.js';
import { StripeService } from '../../src/services/StripeService.js';
import type { Job } from 'bullmq';

const mockDb = { query: mockQuery, transaction: vi.mocked(db.transaction) };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(eventType: string, stripeEventId = 'evt_pay_123'): Job {
  return {
    id: 'job-1',
    data: {
      payload: { stripeEventId, eventType, eventCreated: new Date().toISOString() },
    },
  } as unknown as Job;
}

/**
 * Set up the atomic claim mock to return a claimed event row.
 * payloadJson must include data.object for the event handlers.
 */
function setupClaim(eventType: string, dataObject: Record<string, unknown>, stripeEventId = 'evt_pay_123') {
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        stripe_event_id: stripeEventId,
        type: eventType,
        payload_json: { data: { object: dataObject } },
      },
    ],
    rowCount: 1,
  } as never);
}

/**
 * Set up mock sequence for a full successful payment_intent.succeeded path.
 * Sequence (all go through the shared mockQuery):
 *   1. Claim UPDATE (db.query) → row
 *   2. Inside db.transaction: SELECT escrows ... FOR UPDATE → PENDING escrow
 *   3. Inside db.transaction: UPDATE escrows SET state='FUNDED' → updated row
 *   4. writeToOutbox is separately mocked
 *   5. UPDATE stripe_events SET processed_at=NOW(), result='success' (db.query)
 */
function setupSuccessfulPaymentIntentSucceeded(stripeEventId = 'evt_pay_123') {
  const paymentIntent = { id: 'pi_abc', amount: 5000 };

  // 1. Claim
  setupClaim('payment_intent.succeeded', paymentIntent, stripeEventId);

  // 2. Escrow SELECT (inside transaction callback)
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: 'escrow-1', state: 'PENDING', version: 1, amount: 5000 }],
    rowCount: 1,
  } as never);

  // 3. Escrow UPDATE (PENDING → FUNDED, inside transaction callback)
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: 'escrow-1', state: 'FUNDED', version: 2 }],
    rowCount: 1,
  } as never);

  // 4. writeToOutbox is a separate mock (already set up globally)

  // 5. Final success UPDATE for stripe_events (db.query)
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

  return paymentIntent;
}

/** Set up the claim to return 0 rows (already claimed/processed). */
function setupAlreadyClaimed(stripeEventId = 'evt_pay_123', existingResult = 'processing') {
  // Claim UPDATE returns 0 rows
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
  // SELECT to check existing status
  mockQuery.mockResolvedValueOnce({
    rows: [{ result: existingResult, claimed_at: new Date(), processed_at: null }],
    rowCount: 1,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire db.transaction mock after clearAllMocks resets it
  vi.mocked(db.transaction).mockImplementation(
    (fn: (trx: typeof mockQuery) => Promise<unknown>) => fn(mockQuery)
  );
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('processPaymentJob', () => {
  // -------------------------------------------------------------------------
  // Retry-safety: error path must NOT tombstone with processed_at
  // -------------------------------------------------------------------------
  describe('error path — retry safety', () => {
    it('on transient error: sets claimed_at=NULL and result=failed, does NOT set processed_at', async () => {
      // Claim succeeds: event is claimed
      setupClaim('payment_intent.succeeded', { id: 'pi_abc', amount: 5000 });
      // Escrow SELECT throws a transient DB error (inside transaction)
      mockQuery.mockRejectedValueOnce(new Error('DB connection timeout'));
      // Error UPDATE — captured below
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('DB connection timeout');

      const calls = mockQuery.mock.calls;
      const errorUpdateCall = calls[calls.length - 1];
      const sql: string = errorUpdateCall[0] as string;

      // Must reset claimed_at to NULL so BullMQ retries can re-claim
      expect(sql).toContain('claimed_at = NULL');
      // Must NOT set processed_at — that is the terminal tombstone
      expect(sql).not.toContain('processed_at');
      // Must record failure
      expect(sql).toContain("result = 'failed'");
    });

    it('error UPDATE passes error message and stripeEventId as parameters', async () => {
      setupClaim('payment_intent.succeeded', { id: 'pi_abc', amount: 5000 }, 'evt_xyz');
      mockQuery.mockRejectedValueOnce(new Error('timeout error'));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded', 'evt_xyz'))
      ).rejects.toThrow('timeout error');

      const calls = mockQuery.mock.calls;
      const errorUpdateCall = calls[calls.length - 1];
      const params = errorUpdateCall[1] as unknown[];
      // params: [errorMessage, stripeEventId]
      expect(params[0]).toBe('timeout error');
      expect(params[1]).toBe('evt_xyz');
    });

    it('after error: BullMQ can re-claim because claimed_at is reset to NULL', async () => {
      // First attempt: DB throws during escrow lookup
      setupClaim('payment_intent.succeeded', { id: 'pi_abc', amount: 5000 });
      mockQuery.mockRejectedValueOnce(new Error('transient'));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('transient');

      // Confirm claim was released (claimed_at = NULL)
      const firstErrorUpdate = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
      expect((firstErrorUpdate[0] as string)).toContain('claimed_at = NULL');

      // Second attempt (BullMQ retry): claim guard (AND claimed_at IS NULL) passes again
      vi.clearAllMocks();
      vi.mocked(db.transaction).mockImplementation(
        (fn: (trx: typeof mockQuery) => Promise<unknown>) => fn(mockQuery)
      );
      setupSuccessfulPaymentIntentSucceeded();

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Success path: processed_at must be set, claimed_at must NOT be reset
  // -------------------------------------------------------------------------
  describe('success path', () => {
    it('on success: sets processed_at=NOW() and result=success', async () => {
      setupSuccessfulPaymentIntentSucceeded();

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      const calls = mockQuery.mock.calls;
      const successUpdateCall = calls[calls.length - 1];
      const sql: string = successUpdateCall[0] as string;
      expect(sql).toContain('processed_at = NOW()');
      expect(sql).toContain("result = 'success'");
    });

    it('success UPDATE does not contain claimed_at = NULL', async () => {
      setupSuccessfulPaymentIntentSucceeded();

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      const calls = mockQuery.mock.calls;
      const successUpdateCall = calls[calls.length - 1];
      expect((successUpdateCall[0] as string)).not.toContain('claimed_at = NULL');
    });
  });

  // -------------------------------------------------------------------------
  // Already claimed / processed — silent no-op
  // -------------------------------------------------------------------------
  describe('already claimed or processed', () => {
    it('returns early without processing when event is already claimed', async () => {
      setupAlreadyClaimed('evt_pay_123', 'processing');

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      // Only 2 DB calls: claim attempt + SELECT to check existing status
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('returns early without processing when event is already processed (success)', async () => {
      setupAlreadyClaimed('evt_pay_123', 'success');

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('throws when the event row is not found at all', async () => {
      // Claim UPDATE returns 0 rows
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // SELECT returns 0 rows (event not in table)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('not found');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown event type → skipped (terminal, NOT an error retry)
  // -------------------------------------------------------------------------
  describe('unknown event type', () => {
    it('marks event as skipped (not failed) for unknown event types', async () => {
      setupClaim('unknown.event', {});
      // Skipped UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('unknown.event'));

      const calls = mockQuery.mock.calls;
      const skipUpdateCall = calls[calls.length - 1];
      const sql: string = skipUpdateCall[0] as string;
      expect(sql).toContain("result = 'skipped'");
      expect(sql).toContain('processed_at = NOW()');
    });
  });

  // -------------------------------------------------------------------------
  // payment_intent.succeeded — error releases claim so retry can proceed
  // -------------------------------------------------------------------------
  describe('payment_intent.succeeded — transient handler error', () => {
    it('when escrow not found: releases claim (claimed_at=NULL), NOT processed_at', async () => {
      setupClaim('payment_intent.succeeded', { id: 'pi_no_escrow', amount: 1000 });
      // Escrow lookup returns empty → handler throws (inside transaction)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Error UPDATE (claim released)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('Escrow not found');

      const calls = mockQuery.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
      expect(errorUpdateSql).not.toContain('processed_at');
    });

    it('when amount mismatch: releases claim, does NOT tombstone with processed_at', async () => {
      // BUG 1 FIX: amount_received is now the coverage check (must be >= escrow.amount).
      // Simulate an underpayment: PI collected less than the escrow amount.
      setupClaim('payment_intent.succeeded', { id: 'pi_mismatch', amount: 3000, amount_received: 2999 });
      // Escrow with amount that exceeds what was received (inside transaction)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'escrow-2', state: 'PENDING', version: 1, amount: 5000 }],
        rowCount: 1,
      } as never);
      // Error UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow(/insufficient payment|less than escrow/i);

      const calls = mockQuery.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
      expect(errorUpdateSql).not.toContain('processed_at');
    });
  });

  // -------------------------------------------------------------------------
  // transfer.created — BUG FIX: accept LOCKED_DISPUTE state (dispute-won path)
  // -------------------------------------------------------------------------
  describe('transfer.created — dispute-won path (LOCKED_DISPUTE → RELEASED)', () => {
    /**
     * Set up mock sequence for a successful transfer.created from LOCKED_DISPUTE state.
     * Sequence (all through shared mockQuery):
     *   1. Claim UPDATE (db.query) → row
     *   2. Inside db.transaction: SELECT escrows ... FOR UPDATE → LOCKED_DISPUTE escrow
     *   3. Inside db.transaction: UPDATE escrows SET state='RELEASED' → updated row
     *   4. TaskService.advanceProgress (already mocked)
     *   5. writeToOutbox (already mocked)
     *   6. UPDATE stripe_events SET processed_at=NOW(), result='success' (db.query)
     */
    function setupTransferCreatedFromLockedDispute(escrowId = 'escrow-dispute-111') {
      const transfer = {
        id: 'tr_dispute_abc',
        metadata: { escrow_id: escrowId },
      };

      // 1. Claim
      setupClaim('transfer.created', transfer, 'evt_transfer_dispute');

      // 2. Escrow SELECT inside transaction — in LOCKED_DISPUTE state
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, task_id: 'task-999', state: 'LOCKED_DISPUTE', version: 3, stripe_transfer_id: null }],
        rowCount: 1,
      } as never);

      // 3. Escrow UPDATE → RELEASED (inside transaction)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'RELEASED', version: 4 }],
        rowCount: 1,
      } as never);

      // 4. TaskService.advanceProgress + writeToOutbox are globally mocked

      // 5. Final success UPDATE for stripe_events (db.query)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      return transfer;
    }

    it('successfully releases a LOCKED_DISPUTE escrow on transfer.created', async () => {
      setupTransferCreatedFromLockedDispute();

      await expect(
        processPaymentJob(makeJob('transfer.created', 'evt_transfer_dispute'))
      ).resolves.toBeUndefined();

      const calls = mockQuery.mock.calls;
      const successUpdateCall = calls[calls.length - 1];
      const sql: string = successUpdateCall[0] as string;
      expect(sql).toContain('processed_at = NOW()');
      expect(sql).toContain("result = 'success'");
    });

    it('the escrow UPDATE WHERE clause accepts both FUNDED and LOCKED_DISPUTE states', async () => {
      setupTransferCreatedFromLockedDispute('escrow-dispute-222');

      await processPaymentJob(makeJob('transfer.created', 'evt_transfer_dispute'));

      // Find the UPDATE escrows call — it's call index 2 (0=claim, 1=select, 2=update)
      const escrowUpdateCall = mockQuery.mock.calls[2];
      const sql: string = escrowUpdateCall[0] as string;
      // The WHERE clause must accept both FUNDED and LOCKED_DISPUTE
      expect(sql).toMatch(/state IN \('FUNDED', 'LOCKED_DISPUTE'\)/);
    });

    it('throws and releases claim for an unexpected state (e.g. PENDING)', async () => {
      setupClaim('transfer.created', { id: 'tr_wrong', metadata: { escrow_id: 'escrow-bad-state' } }, 'evt_tr_bad');
      // Escrow in PENDING state — invalid for transfer.created (inside transaction)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'escrow-bad-state', task_id: 'task-x', state: 'PENDING', version: 1, stripe_transfer_id: null }],
        rowCount: 1,
      } as never);
      // Error UPDATE (claim released)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('transfer.created', 'evt_tr_bad'))
      ).rejects.toThrow(/Cannot release escrow.*expected FUNDED or LOCKED_DISPUTE/);

      const calls = mockQuery.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
    });

    it('skips (terminal) when escrow is already RELEASED on transfer.created', async () => {
      setupClaim('transfer.created', { id: 'tr_skip', metadata: { escrow_id: 'escrow-released' } }, 'evt_tr_skip');
      // Already RELEASED → terminal skip path (inside transaction)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'escrow-released', task_id: 'task-y', state: 'RELEASED', version: 5, stripe_transfer_id: 'tr_skip' }],
        rowCount: 1,
      } as never);
      // Inside transaction: UPDATE stripe_events SET result='skipped'
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // No final success UPDATE (early return after skip)

      await processPaymentJob(makeJob('transfer.created', 'evt_tr_skip'));

      // Verify the skipped update was issued inside the transaction
      const allSqls = mockQuery.mock.calls.map(c => c[0] as string);
      const skipSql = allSqls.find(s => s.includes("result = 'skipped'"));
      expect(skipSql).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // charge.refunded — BUG FIX: revenue ledger entry must be written on refund
  // -------------------------------------------------------------------------
  describe('charge.refunded — revenue ledger platform_fee_reversal (bug fix)', () => {
    /**
     * Before the fix: handleChargeRefunded updated escrow state but never called
     * RevenueService.logEvent.  P&L was inaccurate — platform fees appeared earned
     * even after the charge was fully refunded.
     *
     * Fix: After the escrow UPDATE, call RevenueService.logEvent with
     *   eventType: 'platform_fee_reversal' and amountCents = -(platform fee).
     *
     * This mirrors the pattern used by handleTransferFailed for failed_transfer entries.
     */

    /**
     * Set up mock sequence for a successful charge.refunded path.
     * Sequence (all through shared mockQuery):
     *   1. Claim UPDATE → row
     *   2. Inside db.transaction: SELECT escrows FOR UPDATE → FUNDED escrow (with amount)
     *   3. Inside db.transaction: UPDATE escrows SET state='REFUNDED' → updated row
     *   4. TaskService.advanceProgress (mocked globally)
     *   5. RevenueService.logEvent (mocked globally)
     *   6. writeToOutbox (mocked globally)
     *   7. UPDATE stripe_events SET processed_at=NOW(), result='success' (db.query)
     */
    // Setup helper: escrow was RELEASED (fee collected) — reversal SHOULD fire
    // F-03 FIX: charge.refunded now uses three phases. Phase 1 and Phase 3 are each
    // their own db.transaction(), and the Stripe transfer reversal call is outside
    // (Phase 2). Mock sequence:
    //   1. Claim UPDATE → row
    //   Phase 1 (transaction):
    //     2. Escrow SELECT FOR UPDATE → RELEASED
    //   Phase 2 (outside transaction):
    //     StripeService.createTransferReversal — globally mocked
    //   Phase 3 (transaction):
    //     3. Escrow SELECT FOR UPDATE re-read → RELEASED (not yet REFUNDED)
    //     4. UPDATE escrows → REFUNDED
    //     5. INSERT escrow_events (RELEASED→REFUNDED audit row)
    //   Post-Phase-3:
    //     6. TaskService.advanceProgress — globally mocked
    //     7. RevenueService.logEvent — globally mocked (fires because state was RELEASED)
    //     8. writeToOutbox — globally mocked
    //     9. Final success UPDATE stripe_events
    function setupSuccessfulChargeRefundedFromReleased(escrowId = 'escrow-refund-1', escrowAmount = 5000) {
      const charge = {
        id: 'ch_abc',
        metadata: { escrow_id: escrowId },
        refunds: { data: [{ id: 'ref_abc' }] },
        payment_intent: 'pi_abc',
      };

      // 1. Claim
      setupClaim('charge.refunded', charge, 'evt_charge_refunded');

      // Phase 1: Escrow SELECT FOR UPDATE → RELEASED state
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, task_id: 'task-ref-1', state: 'RELEASED', version: 2, amount: escrowAmount, stripe_refund_id: null, stripe_transfer_id: 'tr_existing' }],
        rowCount: 1,
      } as never);

      // Phase 3: Escrow SELECT FOR UPDATE re-read → still RELEASED (not yet REFUNDED)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'RELEASED', version: 2, stripe_refund_id: null }],
        rowCount: 1,
      } as never);

      // Phase 3: UPDATE escrows → REFUNDED
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'REFUNDED', version: 3 }],
        rowCount: 1,
      } as never);

      // Phase 3: INSERT escrow_events (RELEASED→REFUNDED audit row)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      // Post-Phase-3: TaskService.advanceProgress, RevenueService.logEvent, writeToOutbox — globally mocked

      // Final success UPDATE stripe_events
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      return { charge, escrowId, escrowAmount };
    }

    // Setup helper: escrow was FUNDED (no fee collected yet) — reversal must NOT fire
    // F-03 FIX: Phase 1 + Phase 3 two-transaction pattern; no transfer reversal for FUNDED.
    //   1. Claim UPDATE → row
    //   Phase 1 (transaction):
    //     2. Escrow SELECT FOR UPDATE → FUNDED
    //   Phase 3 (transaction):
    //     3. Escrow SELECT FOR UPDATE re-read → still FUNDED
    //     4. UPDATE escrows → REFUNDED (no escrow_events INSERT — state was not RELEASED)
    //   Post-Phase-3:
    //     5. TaskService.advanceProgress — globally mocked
    //     6. writeToOutbox — globally mocked (RevenueService.logEvent NOT called)
    //     7. Final success UPDATE stripe_events
    function setupSuccessfulChargeRefundedFromFunded(escrowId = 'escrow-refund-1', escrowAmount = 5000) {
      const charge = {
        id: 'ch_abc',
        metadata: { escrow_id: escrowId },
        refunds: { data: [{ id: 'ref_abc' }] },
        payment_intent: 'pi_abc',
      };

      // 1. Claim
      setupClaim('charge.refunded', charge, 'evt_charge_refunded');

      // Phase 1: Escrow SELECT FOR UPDATE → FUNDED state
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, task_id: 'task-ref-1', state: 'FUNDED', version: 2, amount: escrowAmount, stripe_refund_id: null, stripe_transfer_id: null }],
        rowCount: 1,
      } as never);

      // Phase 3: Escrow SELECT FOR UPDATE re-read → still FUNDED
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'FUNDED', version: 2, stripe_refund_id: null }],
        rowCount: 1,
      } as never);

      // Phase 3: UPDATE escrows → REFUNDED
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'REFUNDED', version: 3 }],
        rowCount: 1,
      } as never);

      // Post-Phase-3: TaskService.advanceProgress, writeToOutbox — globally mocked
      // RevenueService.logEvent — NOT called (state was not RELEASED)

      // Final success UPDATE stripe_events
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      return { charge, escrowId, escrowAmount };
    }

    it('calls RevenueService.logEvent after charge.refunded when escrow was RELEASED (fee collected)', async () => {
      setupSuccessfulChargeRefundedFromReleased();

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded'));

      expect(vi.mocked(RevenueService.logEvent)).toHaveBeenCalledOnce();
    });

    it('does NOT call RevenueService.logEvent when escrow was FUNDED (no fee collected yet)', async () => {
      setupSuccessfulChargeRefundedFromFunded('escrow-refund-funded', 5000);

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded'));

      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    it('logs platform_fee_reversal with negative amountCents proportional to escrow amount', async () => {
      const escrowAmount = 10000; // $100 escrow
      setupSuccessfulChargeRefundedFromReleased('escrow-refund-2', escrowAmount);

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded'));

      const logEventCall = vi.mocked(RevenueService.logEvent).mock.calls[0][0];
      expect(logEventCall.eventType).toBe('platform_fee_reversal');
      // Platform fee = 15% of 10000 = 1500, reversed = -1500
      expect(logEventCall.amountCents).toBe(-1500);
      expect(logEventCall.escrowId).toBe('escrow-refund-2');
    });

    it('revenue ledger entry includes stripeEventId and stripeChargeId for audit trail', async () => {
      setupSuccessfulChargeRefundedFromReleased('escrow-refund-3', 5000);

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded'));

      const logEventCall = vi.mocked(RevenueService.logEvent).mock.calls[0][0];
      expect(logEventCall.stripeEventId).toBe('evt_charge_refunded');
      expect(logEventCall.stripeChargeId).toBe('ch_abc');
    });

    it('does NOT call RevenueService.logEvent when escrow is already terminal (skipped path)', async () => {
      const charge = {
        id: 'ch_skip',
        metadata: { escrow_id: 'escrow-skip' },
        refunds: { data: [{ id: 'ref_skip' }] },
        payment_intent: 'pi_skip',
      };

      // 1. Claim
      setupClaim('charge.refunded', charge, 'evt_charge_skip');

      // Phase 1: Escrow SELECT → already REFUNDED (terminal skip path)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'escrow-skip', task_id: 'task-skip', state: 'REFUNDED', version: 5, amount: 3000, stripe_refund_id: 'ref_old', stripe_transfer_id: null }],
        rowCount: 1,
      } as never);

      // Phase 1: stripe_events UPDATE (skipped inside Phase 1 transaction)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      // Phase 1 returns skipped=true, escrow.state='REFUNDED' → retry-recovery block runs
      // (uses db.query, not db.transaction)
      // Retry-recovery: SELECT revenue_ledger (no existing reversal)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Retry-recovery: SELECT escrow_events (no RELEASED→REFUNDED event for this stripe_event_id)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Retry-recovery: priorFromState is undefined → logEvent NOT called, returns early

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_skip'));

      // RevenueService.logEvent must NOT be called on the skip path
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    it('charge.refunded succeeds end-to-end (processed_at set, result=success)', async () => {
      setupSuccessfulChargeRefundedFromFunded('escrow-refund-4', 5000);

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded'));

      const calls = mockQuery.mock.calls;
      const successUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(successUpdateSql).toContain('processed_at = NOW()');
      expect(successUpdateSql).toContain("result = 'success'");
    });
  });
});
