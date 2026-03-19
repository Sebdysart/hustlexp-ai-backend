/**
 * payment-worker unit tests
 *
 * Critical bug-fix coverage:
 * - On transient error: claimed_at is reset to NULL, processed_at is NOT set
 *   (so BullMQ retries can re-claim the event)
 * - On success: processed_at is set via the success UPDATE only
 * - BullMQ retry after error: claim guard passes because claimed_at is NULL again
 * - Already-claimed/processed events: silent no-op
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: {
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { processPaymentJob } from '../../src/jobs/payment-worker';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);

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
  mockDb.query.mockResolvedValueOnce({
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
 * Sequence:
 *   1. Claim UPDATE → row
 *   2. SELECT escrows ... FOR UPDATE → PENDING escrow
 *   3. UPDATE escrows SET state='FUNDED' → updated row
 *   4. (writeToOutbox is separately mocked)
 *   5. UPDATE stripe_events SET processed_at=NOW(), result='success'
 */
function setupSuccessfulPaymentIntentSucceeded(stripeEventId = 'evt_pay_123') {
  const paymentIntent = { id: 'pi_abc', amount: 5000 };

  // 1. Claim
  setupClaim('payment_intent.succeeded', paymentIntent, stripeEventId);

  // 2. Escrow SELECT
  mockDb.query.mockResolvedValueOnce({
    rows: [{ id: 'escrow-1', state: 'PENDING', version: 1, amount: 5000 }],
    rowCount: 1,
  } as never);

  // 3. Escrow UPDATE (PENDING → FUNDED)
  mockDb.query.mockResolvedValueOnce({
    rows: [{ id: 'escrow-1', state: 'FUNDED', version: 2 }],
    rowCount: 1,
  } as never);

  // 4. writeToOutbox is a separate mock (already set up globally)

  // 5. Final success UPDATE for stripe_events
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

  return paymentIntent;
}

/** Set up the claim to return 0 rows (already claimed/processed). */
function setupAlreadyClaimed(stripeEventId = 'evt_pay_123', existingResult = 'processing') {
  // Claim UPDATE returns 0 rows
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
  // SELECT to check existing status
  mockDb.query.mockResolvedValueOnce({
    rows: [{ result: existingResult, claimed_at: new Date(), processed_at: null }],
    rowCount: 1,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
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
      // Escrow SELECT throws a transient DB error
      mockDb.query.mockRejectedValueOnce(new Error('DB connection timeout'));
      // Error UPDATE — captured below
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('DB connection timeout');

      const calls = mockDb.query.mock.calls;
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
      mockDb.query.mockRejectedValueOnce(new Error('timeout error'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded', 'evt_xyz'))
      ).rejects.toThrow('timeout error');

      const calls = mockDb.query.mock.calls;
      const errorUpdateCall = calls[calls.length - 1];
      const params = errorUpdateCall[1] as unknown[];
      // params: [errorMessage, stripeEventId]
      expect(params[0]).toBe('timeout error');
      expect(params[1]).toBe('evt_xyz');
    });

    it('after error: BullMQ can re-claim because claimed_at is reset to NULL', async () => {
      // First attempt: DB throws during escrow lookup
      setupClaim('payment_intent.succeeded', { id: 'pi_abc', amount: 5000 });
      mockDb.query.mockRejectedValueOnce(new Error('transient'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('transient');

      // Confirm claim was released (claimed_at = NULL)
      const firstErrorUpdate = mockDb.query.mock.calls[mockDb.query.mock.calls.length - 1];
      expect((firstErrorUpdate[0] as string)).toContain('claimed_at = NULL');

      // Second attempt (BullMQ retry): claim guard (AND claimed_at IS NULL) passes again
      vi.clearAllMocks();
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

      const calls = mockDb.query.mock.calls;
      const successUpdateCall = calls[calls.length - 1];
      const sql: string = successUpdateCall[0] as string;
      expect(sql).toContain('processed_at = NOW()');
      expect(sql).toContain("result = 'success'");
    });

    it('success UPDATE does not contain claimed_at = NULL', async () => {
      setupSuccessfulPaymentIntentSucceeded();

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      const calls = mockDb.query.mock.calls;
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
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('returns early without processing when event is already processed (success)', async () => {
      setupAlreadyClaimed('evt_pay_123', 'success');

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('throws when the event row is not found at all', async () => {
      // Claim UPDATE returns 0 rows
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // SELECT returns 0 rows (event not in table)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

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
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('unknown.event'));

      const calls = mockDb.query.mock.calls;
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
      // Escrow lookup returns empty → handler throws
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Error UPDATE (claim released)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow('Escrow not found');

      const calls = mockDb.query.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
      expect(errorUpdateSql).not.toContain('processed_at');
    });

    it('when amount mismatch: releases claim, does NOT tombstone with processed_at', async () => {
      setupClaim('payment_intent.succeeded', { id: 'pi_mismatch', amount: 9999 });
      // Escrow with different amount
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'escrow-2', state: 'PENDING', version: 1, amount: 5000 }],
        rowCount: 1,
      } as never);
      // Error UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('payment_intent.succeeded'))
      ).rejects.toThrow(/amount.*does not match/i);

      const calls = mockDb.query.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
      expect(errorUpdateSql).not.toContain('processed_at');
    });
  });
});
