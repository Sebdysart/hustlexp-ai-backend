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
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Use vi.hoisted so that mockQuery is available inside the vi.mock factory.
// vi.mock factories are hoisted above all imports (and above top-level const),
// so a plain `const mockQuery = vi.fn()` cannot be closed over inside them.
const {
  mockQuery,
  paymentLogWarn,
  releaseReconcile,
  persistRefundWitness,
  persistReversalWitness,
  markStripeEventOutboxesProcessed,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  paymentLogWarn: vi.fn(),
  releaseReconcile: vi.fn(),
  persistRefundWitness: vi.fn(),
  persistReversalWitness: vi.fn(),
  markStripeEventOutboxesProcessed: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: {
    query: mockQuery,
    transaction: vi.fn((fn: (trx: typeof mockQuery) => Promise<unknown>) => fn(mockQuery)),
  },
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: paymentLogWarn, error: vi.fn() }),
  },
  logger: {
    child: () => ({ info: vi.fn(), warn: paymentLogWarn, error: vi.fn() }),
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
vi.mock('../../src/jobs/outbox-worker.js', () => ({ markStripeEventOutboxesProcessed }));

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: {
    advanceProgress: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/EscrowService.js', () => ({
  EscrowService: {
    release: vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'escrow-release', state: 'RELEASED', version: 4 },
    }),
    getById: vi.fn(),
  },
}));

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/XPService.js', () => ({
  XPService: { clawbackXP: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/jobs/queues.js', () => ({
  verifyJobSignature: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    readTransferWitness: vi.fn(),
    createTransferReversal: vi.fn().mockResolvedValue({
      success: true,
      data: {
        reversalId: 'trr_test', reversalAmountCents: 1,
        transferWitness: {
          provider: 'STRIPE', transferId: 'tr_default', amountCents: 1,
          currency: 'usd', destinationAccountId: 'acct_default', reversed: true,
          amountReversedCents: 1, escrowId: 'escrow-default', taskId: 'task-default',
          payoutRecipientUserId: 'worker-default',
        },
      },
    }),
    getPaymentIntentProcessingFee: vi.fn().mockResolvedValue({
      success: true,
      data: {
        paymentIntentId: 'pi_transfer_fee',
        chargeId: 'ch_transfer_fee',
        balanceTransactionId: 'txn_transfer_fee',
        feeCents: 320,
        currency: 'usd',
      },
    }),
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/EscrowReleaseReconciliationService.js', () => ({
  EscrowReleaseReconciliationService: { reconcile: releaseReconcile },
}));

vi.mock('../../src/services/EscrowRefundProviderWitness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/EscrowRefundProviderWitness.js')>();
  return { ...actual, persistExactSucceededRefundWitness: persistRefundWitness };
});

vi.mock('../../src/services/EscrowRefundService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/EscrowRefundService.js')>();
  return { ...actual, persistExactFullTransferReversalWitness: persistReversalWitness };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { processPaymentJob } from '../../src/jobs/payment-worker';
import { RevenueService } from '../../src/services/RevenueService.js';
import { StripeService } from '../../src/services/StripeService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import { TaskService } from '../../src/services/TaskService.js';
import { verifyJobSignature } from '../../src/jobs/queues.js';
import { EscrowReleaseReconciliationService } from '../../src/services/EscrowReleaseReconciliationService.js';
import { writeToOutbox } from '../../src/lib/outbox-helpers.js';
import { recoverStuckStripeEvents } from '../../src/jobs/maintenance-worker.js';
import { processStripeEventDispatchJob } from '../../src/jobs/stripe-event-dispatcher.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';
import type { Job } from 'bullmq';

const mockDb = { query: mockQuery, transaction: vi.mocked(db.transaction) };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(eventType: string, stripeEventId = 'evt_pay_123'): Job {
  const outboxKey = `stripe.event_received:${stripeEventId}`;
  return {
    id: outboxTransportJobId(outboxKey),
    data: {
      payload: {
        stripeEventId,
        eventType,
        eventCreated: new Date().toISOString(),
        _outbox_key: outboxKey,
        _sig: 'test-sig',
      },
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

function setupTransferWitness(params: {
  transferId: string;
  escrowId: string;
  taskId: string;
  payoutRecipientUserId: string;
  destinationAccountId: string;
  amountCents: number;
  currency?: string;
  reversed?: boolean;
  amountReversedCents?: number;
}) {
  vi.mocked(StripeService.readTransferWitness).mockResolvedValue({
    success: true,
    data: {
      provider: 'STRIPE',
      transferId: params.transferId,
      amountCents: params.amountCents,
      currency: params.currency ?? 'usd',
      destinationAccountId: params.destinationAccountId,
      reversed: params.reversed ?? false,
      amountReversedCents: params.amountReversedCents ?? 0,
      escrowId: params.escrowId,
      taskId: params.taskId,
      payoutRecipientUserId: params.payoutRecipientUserId,
    },
  });
}

function traceTransactionStatements(): string[][] {
  const transactionStatements: string[][] = [];
  vi.mocked(db.transaction).mockImplementation(
    async (fn: (trx: typeof mockQuery) => Promise<unknown>) => {
      const statements: string[] = [];
      transactionStatements.push(statements);
      const tracedQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
        statements.push(String(sql));
        return mockQuery(sql, params);
      }) as typeof mockQuery;
      return fn(tracedQuery);
    },
  );
  return transactionStatements;
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
  const paymentIntent = { id: 'pi_abc', amount: 5000, amount_received: 5000 };

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
function setupAlreadyClaimed(
  stripeEventId = 'evt_pay_123',
  existingResult = 'processing',
  processedAt: Date | null = existingResult === 'success' ? new Date() : null,
) {
  // Claim UPDATE returns 0 rows
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
  // SELECT to check existing status
  mockQuery.mockResolvedValueOnce({
    rows: [{ result: existingResult, claimed_at: new Date(), processed_at: processedAt }],
    rowCount: 1,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  paymentLogWarn.mockReset();
  persistRefundWitness.mockReset().mockResolvedValue(undefined);
  persistReversalWitness.mockReset().mockResolvedValue(undefined);
  markStripeEventOutboxesProcessed.mockReset().mockImplementation(async ({ idempotencyKey }) => ({
    signed:{ idempotency_key:idempotencyKey,status:'processed',attempts:1 },
    acknowledgedKeys:[idempotencyKey],
  }));
  vi.mocked(verifyJobSignature).mockReset().mockReturnValue(true);
  vi.mocked(TaskService.advanceProgress).mockReset().mockResolvedValue({ success: true });
  vi.mocked(EscrowService.release).mockReset().mockResolvedValue({
    success: true,
    data: { id: 'escrow-release', state: 'RELEASED', version: 4 },
  });
  vi.mocked(RevenueService.logEvent).mockReset().mockResolvedValue({
    success: true,
    data: { id: 'rev-1' },
  });
  vi.mocked(StripeService.readTransferWitness).mockReset();
  vi.mocked(StripeService.createTransferReversal).mockReset().mockResolvedValue({
    success: true,
    data: {
      reversalId: 'trr_test', reversalAmountCents: 1,
      transferWitness: {
        provider: 'STRIPE', transferId: 'tr_default', amountCents: 1,
        currency: 'usd', destinationAccountId: 'acct_default', reversed: true,
        amountReversedCents: 1, escrowId: 'escrow-default', taskId: 'task-default',
        payoutRecipientUserId: 'worker-default',
      },
    },
  });
  vi.mocked(StripeService.getPaymentIntentProcessingFee).mockReset().mockResolvedValue({
    success: true,
    data: {
      paymentIntentId: 'pi_transfer_fee', chargeId: 'ch_transfer_fee',
      balanceTransactionId: 'txn_transfer_fee', feeCents: 320, currency: 'usd',
    },
  });
  vi.mocked(EscrowReleaseReconciliationService.reconcile).mockReset().mockResolvedValue({
    success: true,
    data: {
      escrowId: 'escrow-release', taskId: 'task-release', workerId: 'worker-release',
      grossAmountCents: 10_000, platformFeeCents: 2_500,
      insuranceContributionCents: 200, netPayoutCents: 7_300,
    },
  });
  enableControlledStripePaymentTestCohortV7();
  // Re-wire db.transaction mock after clearAllMocks resets it
  vi.mocked(db.transaction).mockImplementation(
    (fn: (trx: typeof mockQuery) => Promise<unknown>) => fn(mockQuery)
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('processPaymentJob', () => {
  describe('financial job authenticity', () => {
    it('rejects an unsigned payment job before touching the database', async () => {
      const job = makeJob('payment_intent.payment_failed');
      delete (job.data.payload as Record<string, unknown>)._sig;

      await expect(processPaymentJob(job as never)).rejects.toThrow('JOB_SIGNATURE_REQUIRED');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects an invalid signature before touching the database', async () => {
      vi.mocked(verifyJobSignature).mockReturnValueOnce(false);

      await expect(processPaymentJob(makeJob('transfer.failed') as never))
        .rejects.toThrow('JOB_SIGNATURE_INVALID');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects a forged BullMQ identity before touching the database', async () => {
      const job = makeJob('transfer.failed');
      job.id = 'forged-job';

      await expect(processPaymentJob(job as never)).rejects.toThrow('JOB_IDENTITY_INVALID');

      expect(mockQuery).not.toHaveBeenCalled();
      expect(markStripeEventOutboxesProcessed).not.toHaveBeenCalled();
    });

    it('accepts the canonical signed type field without rewriting the envelope', async () => {
      const job = makeJob('unused');
      const outboxKey = 'stripe.event_received:evt_canonical';
      job.id = outboxTransportJobId(outboxKey);
      job.data.payload = {
        stripeEventId: 'evt_canonical',
        type: 'transfer.failed',
        _outbox_key: outboxKey,
        _sig: 'test-sig',
      } as never;
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [{ result: 'success', claimed_at: new Date(), processed_at: new Date() }], rowCount: 1 } as never);

      await expect(processPaymentJob(job as never)).resolves.toBeUndefined();
      expect(verifyJobSignature).toHaveBeenCalledWith(
        { stripeEventId: 'evt_canonical', type: 'transfer.failed', _outbox_key: outboxKey },
        'test-sig',
      );
      expect(markStripeEventOutboxesProcessed).toHaveBeenCalledWith({
        idempotencyKey:outboxKey,
        stripeEventId:'evt_canonical',
      });
    });

    it('quarantines a signed routing alias that conflicts with the claimed Stripe event type', async () => {
      const job = makeJob('transfer.failed', 'evt_type_mismatch');
      const outboxKey = 'stripe.event_received:evt_type_mismatch';
      job.data.payload = {
        stripeEventId: 'evt_type_mismatch',
        eventType: 'transfer.failed',
        type: 'charge.refunded',
        _outbox_key: outboxKey,
        _sig: 'test-sig',
      } as never;
      setupClaim('charge.refunded', { id: 'ch_type_mismatch' }, 'evt_type_mismatch');
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(processPaymentJob(job as never))
        .rejects.toThrow('STRIPE_EVENT_TYPE_MISMATCH');

      expect(verifyJobSignature).toHaveBeenCalledWith(
        {
          stripeEventId: 'evt_type_mismatch',
          eventType: 'transfer.failed',
          type: 'charge.refunded',
          _outbox_key: outboxKey,
        },
        'test-sig',
      );
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const quarantineSql = String(mockQuery.mock.calls[1]?.[0]);
      expect(quarantineSql).toContain('processed_at = NOW()');
      expect(quarantineSql).not.toContain('claimed_at = NULL');
      expect(mockQuery.mock.calls[1]?.[1]).toEqual([
        'evt_type_mismatch',
        expect.stringMatching(/^STRIPE_EVENT_CLAIM:/),
        expect.stringContaining('STRIPE_EVENT_TYPE_MISMATCH'),
      ]);
      expect(StripeService.readTransferWitness).not.toHaveBeenCalled();
    });
  });

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
      expect(sql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
      expect(sql).toContain('processed_at IS NULL');
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
      // params: [stripeEventId, exact claim token, errorMessage]
      expect(params[0]).toBe('evt_xyz');
      expect(params[1]).toEqual(expect.stringMatching(/^STRIPE_EVENT_CLAIM:/));
      expect(params[2]).toBe('timeout error');
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
    it('retains succeeded provider evidence but suppresses escrow funding while frozen', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ENGINE_API_MODE', 'production');
      vi.stubEnv('STRIPE_MODE', 'live');
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_forbidden');
      vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
      setupClaim('payment_intent.succeeded', {
        id: 'pi_frozen', amount: 5000, amount_received: 5000,
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      expect(db.transaction).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(String(mockQuery.mock.calls[1]?.[0])).toContain("result = 'skipped'");
      expect(mockQuery.mock.calls[1]?.[1]).toContainEqual(
        expect.stringContaining('PAYMENT_CREATION_FROZEN'),
      );
    });
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
      expect(markStripeEventOutboxesProcessed).not.toHaveBeenCalled();
    });

    it('returns early without processing when event is already processed (success)', async () => {
      setupAlreadyClaimed('evt_pay_123', 'success');

      await processPaymentJob(makeJob('payment_intent.succeeded'));

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(markStripeEventOutboxesProcessed).toHaveBeenCalledWith({
        idempotencyKey: 'stripe.event_received:evt_pay_123',
        stripeEventId: 'evt_pay_123',
      });
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

  describe('terminal inbox and outbox acknowledgement crash boundary', () => {
    it('retries only the exact outbox ACK after the inbox terminal write survives a crash', async () => {
      setupSuccessfulPaymentIntentSucceeded('evt_ack_crash');
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      markStripeEventOutboxesProcessed
        .mockRejectedValueOnce(new Error('crash after inbox terminal'))
        .mockResolvedValueOnce({
          signed: {
            idempotency_key: 'stripe.event_received:evt_ack_crash',
            status: 'processed',
            attempts: 2,
          },
          acknowledgedKeys: ['stripe.event_received:evt_ack_crash'],
        });

      await expect(processPaymentJob(makeJob(
        'payment_intent.succeeded',
        'evt_ack_crash',
      ))).rejects.toThrow('crash after inbox terminal');

      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({
          rows: [{ result: 'success', claimed_at: new Date(), processed_at: new Date() }],
          rowCount: 1,
        } as never);
      await expect(processPaymentJob(makeJob(
        'payment_intent.succeeded',
        'evt_ack_crash',
      ))).resolves.toBeUndefined();

      expect(markStripeEventOutboxesProcessed).toHaveBeenNthCalledWith(1, {
        idempotencyKey: 'stripe.event_received:evt_ack_crash',
        stripeEventId: 'evt_ack_crash',
      });
      expect(markStripeEventOutboxesProcessed).toHaveBeenNthCalledWith(2, {
        idempotencyKey: 'stripe.event_received:evt_ack_crash',
        stripeEventId: 'evt_ack_crash',
      });
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
      expect(errorUpdateSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
      expect(errorUpdateSql).toContain('processed_at IS NULL');
    });

    it('when underpaid: releases claim, does NOT tombstone with processed_at', async () => {
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
      ).rejects.toThrow(/does not exactly match escrow/i);

      const calls = mockQuery.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
      expect(errorUpdateSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
      expect(errorUpdateSql).toContain('processed_at IS NULL');
    });

    it('when overpaid: releases claim and leaves the immutable escrow unfunded', async () => {
      setupClaim('payment_intent.succeeded', { id: 'pi_overpaid', amount: 5001, amount_received: 5001 });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'escrow-overpaid', state: 'PENDING', version: 1, amount: 5000 }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(processPaymentJob(makeJob('payment_intent.succeeded')))
        .rejects.toThrow(/does not exactly match escrow/i);

      const calls = mockQuery.mock.calls;
      const errorUpdateSql: string = calls[calls.length - 1][0] as string;
      expect(errorUpdateSql).toContain('claimed_at = NULL');
      expect(errorUpdateSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
      expect(errorUpdateSql).toContain('processed_at IS NULL');
      expect(calls.some(([sql]) => String(sql).includes("SET state = 'FUNDED'"))).toBe(false);
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
     *   3. EscrowService.release() performs the canonical transition
     *   4. Revenue idempotency guard finds an existing row
     *   5. UPDATE stripe_events SET processed_at=NOW(), result='success' (db.query)
     */
    function setupTransferCreatedFromLockedDispute(escrowId = 'escrow-dispute-111') {
      const workerId = 'worker-dispute-999';
      const taskId = 'task-999';
      const transfer = {
        id: 'tr_dispute_abc',
        amount: 4150,
        amount_reversed: 0,
        currency: 'usd',
        destination: 'acct_dispute_expected',
        reversed: false,
        metadata: { escrow_id: escrowId, task_id: taskId, worker_id: workerId },
      };

      // 1. Claim
      setupClaim('transfer.created', transfer, 'evt_transfer_dispute');
      setupTransferWitness({
        transferId: transfer.id,
        escrowId,
        taskId,
        payoutRecipientUserId: workerId,
        destinationAccountId: transfer.destination,
        amountCents: transfer.amount,
      });

      // 2. Escrow SELECT inside transaction — in LOCKED_DISPUTE state
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: escrowId,
          task_id: taskId,
          state: 'LOCKED_DISPUTE',
          version: 3,
          amount: 5000,
          platform_fee_cents: 750,
          stripe_transfer_id: null,
          stripe_payment_intent_id: 'pi_dispute',
        }],
        rowCount: 1,
      } as never);

      // 3-4. Canonical task recipient and current provider destination.
      mockQuery.mockResolvedValueOnce({
        rows: [{ worker_id: workerId, payout_recipient_user_id: null }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows: [{
          stripe_connect_id: 'acct_dispute_expected',
          payouts_enabled: true,
          account_status: 'ACTIVE',
          binding_current: true,
        }],
        rowCount: 1,
      } as never);

      // Fresh provider re-read is rebound to the exact RELEASED row immediately
      // before reconciliation.
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id:escrowId,task_id:taskId,state:'RELEASED',version:4,amount:5000,
          platform_fee_cents:750,stripe_transfer_id:transfer.id,
          provider_transfer_status:'paid',
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ worker_id:workerId,payout_recipient_user_id:null }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          stripe_connect_id:'acct_dispute_expected',payouts_enabled:true,
          account_status:'ACTIVE',binding_current:true,
        }],
        rowCount:1,
      } as never);

      // 5. Revenue guard → existing row, so attribution/ledger writes are skipped
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'rev-existing' }],
        rowCount: 1,
      } as never);

      // 6. Final success UPDATE for stripe_events (db.query)
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

    it('delegates LOCKED_DISPUTE release to the canonical EscrowService path', async () => {
      setupTransferCreatedFromLockedDispute('escrow-dispute-222');

      await processPaymentJob(makeJob('transfer.created', 'evt_transfer_dispute'));

      expect(vi.mocked(EscrowService.release)).toHaveBeenCalledWith({
        escrowId: 'escrow-dispute-222',
        stripeTransferId: 'tr_dispute_abc',
        stripeTransferWitness: expect.objectContaining({
          transferId: 'tr_dispute_abc',
          escrowId: 'escrow-dispute-222',
          taskId: 'task-999',
        }),
      });
      const sqls = mockQuery.mock.calls.map((call) => String(call[0]));
      expect(sqls.some((sql) => sql.includes("SET state = 'RELEASED'"))).toBe(false);
    });

    it.each([
      ['wrong destination', { destinationAccountId: 'acct_attacker' }],
      ['wrong recipient metadata', { payoutRecipientUserId: 'worker-attacker' }],
      ['wrong currency', { currency: 'eur' }],
      ['full reversal', { reversed: true, amountReversedCents: 4150 }],
      ['partial reversal', { reversed: false, amountReversedCents: 1000 }],
    ] as const)('rejects %s before canonical release', async (_label, override) => {
      const escrowId = 'escrow-binding-attack';
      const taskId = 'task-binding-attack';
      const workerId = 'worker-binding-expected';
      setupClaim('transfer.created', {
        id: 'tr_binding_attack',
        amount: 4150,
        amount_reversed: 0,
        currency: 'usd',
        destination: 'acct_binding_expected',
        reversed: false,
        metadata: { escrow_id: escrowId, task_id: taskId, worker_id: workerId },
      }, 'evt_tr_binding_attack');
      setupTransferWitness({
        transferId: 'tr_binding_attack',
        escrowId,
        taskId,
        payoutRecipientUserId: workerId,
        destinationAccountId: 'acct_binding_expected',
        amountCents: 4150,
        ...override,
      });
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: escrowId,
            task_id: taskId,
            state: 'FUNDED',
            version: 2,
            amount: 5000,
            platform_fee_cents: 750,
            stripe_transfer_id: null,
            stripe_payment_intent_id: 'pi_binding_attack',
          }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({
          rows: [{ worker_id: workerId, payout_recipient_user_id: null }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({
          rows: [{
            stripe_connect_id: 'acct_binding_expected',
            payouts_enabled: true,
            account_status: 'ACTIVE',
            binding_current: true,
          }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(processPaymentJob(makeJob('transfer.created', 'evt_tr_binding_attack')))
        .rejects.toThrow(/canonical payout destination and recipient/);

      expect(EscrowService.release).not.toHaveBeenCalled();
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
    });

    it('throws and releases claim for an unexpected state (e.g. PENDING)', async () => {
      setupClaim('transfer.created', {
        id: 'tr_wrong',
        metadata: { escrow_id: 'escrow-bad-state', task_id: 'task-x' },
      }, 'evt_tr_bad');
      setupTransferWitness({
        transferId: 'tr_wrong',
        escrowId: 'escrow-bad-state',
        taskId: 'task-x',
        payoutRecipientUserId: 'worker-x',
        destinationAccountId: 'acct-x',
        amountCents: 4150,
      });
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

    it.each([
      { label: 'underpayment', amount: 4149 },
      { label: 'overpayment', amount: 4151 },
    ])('rejects a one-cent $label before mutating escrow', async ({ amount }) => {
      setupClaim('transfer.created', {
        id: 'tr_amount_mismatch',
        amount,
        metadata: { escrow_id: 'escrow-amount-mismatch', task_id: 'task-amount-mismatch' },
      }, 'evt_tr_amount_mismatch');
      setupTransferWitness({
        transferId: 'tr_amount_mismatch',
        escrowId: 'escrow-amount-mismatch',
        taskId: 'task-amount-mismatch',
        payoutRecipientUserId: 'worker-amount-mismatch',
        destinationAccountId: 'acct-amount-mismatch',
        amountCents: amount,
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-amount-mismatch',
          task_id: 'task-amount-mismatch',
          state: 'FUNDED',
          version: 2,
          amount: 5000,
          platform_fee_cents: 750,
          stripe_transfer_id: null,
          stripe_payment_intent_id: 'pi_amount_mismatch',
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(
        processPaymentJob(makeJob('transfer.created', 'evt_tr_amount_mismatch')),
      ).rejects.toThrow(/does not match expected net payout \(4150\)/);

      const sqls = mockQuery.mock.calls.map((call) => String(call[0]));
      expect(sqls.some((sql) => sql.includes("SET state = 'RELEASED'"))).toBe(false);
      expect(vi.mocked(EscrowService.release)).not.toHaveBeenCalled();
      expect(sqls.at(-1)).toContain('claimed_at = NULL');
    });

    it('accepts an exact same-transfer replay when escrow is already RELEASED', async () => {
      setupClaim('transfer.created', {
        id: 'tr_skip',
        amount: 4150,
        amount_reversed: 0,
        currency: 'usd',
        destination: 'acct_released_expected',
        reversed: false,
        metadata: { escrow_id: 'escrow-released', task_id: 'task-y', worker_id: 'worker-released' },
      }, 'evt_tr_skip');
      setupTransferWitness({
        transferId: 'tr_skip',
        escrowId: 'escrow-released',
        taskId: 'task-y',
        payoutRecipientUserId: 'worker-released',
        destinationAccountId: 'acct_released_expected',
        amountCents: 4150,
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-released', task_id: 'task-y', state: 'RELEASED', version: 5,
          amount: 5000, platform_fee_cents: 750, stripe_transfer_id: 'tr_skip',
          stripe_payment_intent_id: 'pi_released',
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows: [{ from_state: 'FUNDED' }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows: [{ worker_id: 'worker-released', payout_recipient_user_id: null }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows: [{
          stripe_connect_id: 'acct_released_expected',
          payouts_enabled: true,
          account_status: 'ACTIVE',
          binding_current: true,
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          id:'escrow-released',task_id:'task-y',state:'RELEASED',version:5,
          amount:5000,platform_fee_cents:750,stripe_transfer_id:'tr_skip',
          provider_transfer_status:'paid',
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ worker_id:'worker-released',payout_recipient_user_id:null }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          stripe_connect_id:'acct_released_expected',payouts_enabled:true,
          account_status:'ACTIVE',binding_current:true,
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev-existing' }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('transfer.created', 'evt_tr_skip'));

      const allSqls = mockQuery.mock.calls.map(c => c[0] as string);
      expect(allSqls.at(-1)).toContain("result = 'success'");
      expect(vi.mocked(EscrowService.release)).not.toHaveBeenCalled();
      expect(EscrowReleaseReconciliationService.reconcile).toHaveBeenCalledWith({
        escrowId:'escrow-released',
        expectedStripeTransferId:'tr_skip',
        fromState:'FUNDED',
      });
    });

    it('rejects an already-RELEASED replay when the provider reverses before reconciliation', async () => {
      const escrowId='escrow-released-race';
      const taskId='task-released-race';
      const workerId='worker-released-race';
      const transferId='tr_released_race';
      setupClaim('transfer.created',{
        id:transferId,amount:4150,amount_reversed:0,currency:'usd',
        destination:'acct_released_race',reversed:false,
        metadata:{ escrow_id:escrowId,task_id:taskId,worker_id:workerId },
      },'evt_tr_released_race');
      const exactWitness={
        provider:'STRIPE' as const,transferId,amountCents:4150,currency:'usd',
        destinationAccountId:'acct_released_race',reversed:false,amountReversedCents:0,
        escrowId,taskId,payoutRecipientUserId:workerId,
      };
      vi.mocked(StripeService.readTransferWitness)
        .mockResolvedValueOnce({ success:true,data:exactWitness })
        .mockResolvedValueOnce({
          success:true,data:{ ...exactWitness,reversed:true,amountReversedCents:4150 },
        });
      mockQuery.mockResolvedValueOnce({
        rows:[{
          id:escrowId,task_id:taskId,state:'RELEASED',version:5,amount:5000,
          platform_fee_cents:750,stripe_transfer_id:transferId,
          stripe_payment_intent_id:'pi_released_race',
        }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ from_state:'FUNDED' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ worker_id:workerId,payout_recipient_user_id:null }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          stripe_connect_id:'acct_released_race',payouts_enabled:true,
          account_status:'ACTIVE',binding_current:true,
        }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);
      // Exact fenced claim release after the witness changes during reconciliation.
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await expect(processPaymentJob(makeJob('transfer.created','evt_tr_released_race')))
        .rejects.toThrow(/changed before exact release reconciliation/);

      expect(StripeService.readTransferWitness).toHaveBeenCalledTimes(2);
      expect(EscrowReleaseReconciliationService.reconcile).not.toHaveBeenCalled();
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
    });

    it('rejects a different transfer for an already RELEASED escrow', async () => {
      setupClaim('transfer.created', {
        id: 'tr_conflict', amount: 4150,
        metadata: { escrow_id: 'escrow-released', task_id: 'task-y' },
      }, 'evt_tr_conflict');
      setupTransferWitness({
        transferId: 'tr_conflict',
        escrowId: 'escrow-released',
        taskId: 'task-y',
        payoutRecipientUserId: 'worker-y',
        destinationAccountId: 'acct-y',
        amountCents: 4150,
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-released', task_id: 'task-y', state: 'RELEASED', version: 5,
          amount: 5000, platform_fee_cents: 750, stripe_transfer_id: 'tr_original',
          stripe_payment_intent_id: 'pi_released',
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(processPaymentJob(makeJob('transfer.created', 'evt_tr_conflict')))
        .rejects.toThrow(/Transfer conflict/);
      expect(vi.mocked(EscrowService.release)).not.toHaveBeenCalled();
    });

    it('requires a current provider transfer witness before reading or releasing canonical escrow', async () => {
      setupClaim('transfer.created', {
        id: 'tr_witness_unavailable',
        metadata: { escrow_id: 'escrow-witness', task_id: 'task-witness' },
      }, 'evt_tr_witness_unavailable');
      vi.mocked(StripeService.readTransferWitness).mockResolvedValueOnce({
        success: false,
        error: { code: 'STRIPE_TRANSFER_EVIDENCE_UNAVAILABLE', message: 'provider timeout' },
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(processPaymentJob(makeJob('transfer.created', 'evt_tr_witness_unavailable')))
        .rejects.toThrow(/current provider evidence is unavailable: provider timeout/);

      expect(StripeService.readTransferWitness).toHaveBeenCalledOnce();
      expect(StripeService.readTransferWitness).toHaveBeenCalledWith('tr_witness_unavailable');
      expect(db.transaction).not.toHaveBeenCalled();
      expect(EscrowService.release).not.toHaveBeenCalled();
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
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
    function exactFullRefundCharge(options: {
      id?: string;
      escrowId: string;
      amount: number;
      paymentIntentId?: string;
      refundId?: string;
    }) {
      const paymentIntentId = options.paymentIntentId ?? 'pi_abc';
      return {
        id: options.id ?? 'ch_abc',
        amount: options.amount,
        amount_refunded: options.amount,
        currency: 'usd',
        refunded: true,
        metadata: { escrow_id: options.escrowId },
        refunds: {
          data: [{
            id: options.refundId ?? 'ref_abc', created: 1, amount: options.amount,
            currency: 'usd', status: 'succeeded', charge: options.id ?? 'ch_abc',
            payment_intent: paymentIntentId,
          }],
          has_more: false,
        },
        payment_intent: paymentIntentId,
      };
    }

    type RefundEscrowRow = {
      id: string;
      task_id: string;
      state: string;
      version: number;
      amount: number;
      platform_fee_cents: number | null;
      stripe_refund_id: string | null;
      stripe_transfer_id: string | null;
      stripe_payment_intent_id: string | null;
      provider_transfer_status: string | null;
    };

    type RefundTaskRow = {
      id: string;
      state: string;
      progress_state: string;
      worker_id: string | null;
      payout_recipient_user_id: string | null;
      refund_state: string;
      refund_blocker: string | null;
    };

    function refundEscrowRow(overrides: Partial<RefundEscrowRow> = {}): RefundEscrowRow {
      return {
        id: 'escrow-refund-1',
        task_id: 'task-ref-1',
        state: 'FUNDED',
        version: 2,
        amount: 5000,
        platform_fee_cents: null,
        stripe_refund_id: null,
        stripe_transfer_id: null,
        stripe_payment_intent_id: 'pi_abc',
        provider_transfer_status: null,
        ...overrides,
      };
    }

    function refundTaskRow(overrides: Partial<RefundTaskRow> = {}): RefundTaskRow {
      return {
        id: 'task-ref-1',
        state: 'OPEN',
        progress_state: 'POSTED',
        worker_id: 'worker-ref-1',
        payout_recipient_user_id: null,
        refund_state: 'NOT_REQUIRED',
        refund_blocker: null,
        ...overrides,
      };
    }

    function expectRefundReconciliation(stripeEventId: string, reasonFragment = '') {
      const reconciliationCall = mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes("result = 'failed'"));
      expect(reconciliationCall?.[1]).toEqual([
        stripeEventId,
        expect.stringMatching(/^STRIPE_EVENT_CLAIM:/),
        expect.stringContaining(`REFUND_RECONCILIATION_REQUIRED: ${reasonFragment}`),
      ]);
    }

    function setupSuccessfulChargeRefundedFromReleased(
      escrowId = 'escrow-refund-1',
      escrowAmount = 5000,
      includeSuccessfulReversalWitnesses = true,
    ) {
      const charge = exactFullRefundCharge({ escrowId, amount: escrowAmount });
      const escrow = refundEscrowRow({
        id: escrowId,
        state: 'RELEASED',
        amount: escrowAmount,
        stripe_transfer_id: 'tr_existing',
        provider_transfer_status: 'paid',
      });
      const task = refundTaskRow({ state: 'COMPLETED', progress_state: 'COMPLETED' });
      const expectedTransferAmount = escrowAmount
        - Math.round(escrowAmount * 0.2)
        - Math.round(escrowAmount * 0.02);
      vi.mocked(StripeService.createTransferReversal).mockResolvedValueOnce({
        success: true,
        data: {
          reversalId: 'trr_test',
          reversalAmountCents: expectedTransferAmount,
          transferWitness: {
            provider: 'STRIPE', transferId: 'tr_existing', amountCents: expectedTransferAmount,
            currency: 'usd', destinationAccountId: 'acct_refund_exact', reversed: true,
            amountReversedCents: expectedTransferAmount, escrowId, taskId: task.id,
            payoutRecipientUserId: task.worker_id,
          },
        },
      });

      // 1. Claim
      setupClaim('charge.refunded', charge, 'evt_charge_refunded');

      // Phase 1 locks the complete escrow/task witness.
      mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);

      // Current canonical payout destination for exact reversal binding.
      mockQuery.mockResolvedValueOnce({
        rows: [{
          stripe_connect_id: 'acct_refund_exact', payouts_enabled: true,
          account_status: 'ACTIVE', binding_current: true,
        }],
        rowCount: 1,
      } as never);

      if (includeSuccessfulReversalWitnesses) {
        const platformFeeCents = Math.round(escrowAmount * 0.2);
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
        mockQuery.mockResolvedValueOnce({
          rows:[{
            amount_cents:-platformFeeCents,currency:'usd',task_id:task.id,
            gross_amount_cents:escrowAmount,platform_fee_cents:platformFeeCents,
            net_amount_cents:escrowAmount-platformFeeCents,fee_basis_points:2000,
            escrow_id:escrowId,stripe_event_id:'evt_charge_refunded',
            stripe_charge_id:'ch_abc',stripe_payment_intent_id:'pi_abc',
            metadata:{ refund_id:'ref_abc',reason:'charge_refunded_after_release' },
          }],
          rowCount:1,
        } as never);
        mockQuery.mockResolvedValueOnce({
          rows:[{
            awards:[{
              user_id:task.worker_id,task_id:task.id,escrow_id:escrowId,
              base_xp:50,effective_xp:50,reason:'task_completion',
            }],
            clawbacks:[{
              user_id:task.worker_id,task_id:task.id,escrow_id:escrowId,
              base_xp:-50,effective_xp:-50,reason:'task_refunded',
            }],
          }],
          rowCount:1,
        } as never);
        mockQuery.mockResolvedValueOnce({
          rows:[{
            task_id:task.id,hustler_id:task.worker_id,
            contribution_cents:Math.round(escrowAmount*0.02),contribution_percentage:2,
          }],rowCount:1,
        } as never);
        mockQuery.mockResolvedValueOnce({
          rows:[{
            user_id:task.worker_id,task_id:task.id,escrow_id:escrowId,
            net_payout_cents:expectedTransferAmount,
            cumulative_earnings_before_cents:0,
            cumulative_earnings_after_cents:expectedTransferAmount,
          }],rowCount:1,
        } as never);
        mockQuery.mockResolvedValueOnce({
          rows:[{
            user_id:task.worker_id,total_net_earnings_cents:expectedTransferAmount,
            earned_unlock_threshold_cents:4000,earned_unlock_achieved:true,
            completed_task_count:1,
          }],rowCount:1,
        } as never);
        mockQuery.mockResolvedValueOnce({ rows:[{ id:'economics-block' }],rowCount:1 } as never);
      }

      // Phase 3 re-locks the exact same escrow/task witness.
      mockQuery.mockResolvedValueOnce({ rows: [{ ...escrow }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ ...task }], rowCount: 1 } as never);

      // Transaction-local released-refund authority, set only after all exact
      // financial witnesses are durable.
      if (includeSuccessfulReversalWitnesses) {
        mockQuery.mockResolvedValueOnce({ rows:[{ set_config:escrowId }],rowCount:1 } as never);
      } else {
        // Reversal failure changes provider status on an otherwise unchanged
        // RELEASED row: exact immutable authority + transaction-local GUC must
        // precede that terminal same-state CAS.
        mockQuery.mockResolvedValueOnce({ rows:[{ id:'provider-status-authority' }],rowCount:1 } as never);
        mockQuery.mockResolvedValueOnce({ rows:[{ set_config:escrowId }],rowCount:1 } as never);
      }

      // Phase 3: UPDATE escrows → REFUNDED
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'REFUNDED', version: 3 }],
        rowCount: 1,
      } as never);

      // Phase 3: INSERT escrow_events (RELEASED→REFUNDED audit row)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      // TaskService.advanceProgress, RevenueService.logEvent, writeToOutbox — globally mocked

      // Final success UPDATE stripe_events
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      return { charge, escrow, task };
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
      const charge = exactFullRefundCharge({ escrowId, amount: escrowAmount });
      const escrow = refundEscrowRow({ id: escrowId, amount: escrowAmount });
      const task = refundTaskRow();

      // 1. Claim
      setupClaim('charge.refunded', charge, 'evt_charge_refunded');

      // Phase 1 locks the complete escrow/task witness.
      mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);

      // Phase 3 re-locks the exact same escrow/task witness.
      mockQuery.mockResolvedValueOnce({ rows: [{ ...escrow }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ ...task }], rowCount: 1 } as never);

      // Phase 3 atomically cancels the pre-completion task.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      // Phase 3: UPDATE escrows → REFUNDED
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'REFUNDED', version: 3 }],
        rowCount: 1,
      } as never);

      // Phase 3: INSERT escrow_events.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      // Post-Phase-3: TaskService.advanceProgress, writeToOutbox — globally mocked
      // RevenueService.logEvent — NOT called (state was not RELEASED)

      // Final success UPDATE stripe_events
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      return { charge, escrow, task };
    }

    it('calls RevenueService.logEvent after charge.refunded when escrow was RELEASED (fee collected)', async () => {
      setupSuccessfulChargeRefundedFromReleased();

      await expect(processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded')))
        .rejects.toThrow('RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED');

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

      await expect(processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded')))
        .rejects.toThrow('RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED');

      const logEventCall = vi.mocked(RevenueService.logEvent).mock.calls[0][0];
      expect(logEventCall.eventType).toBe('platform_fee_reversal');
      // Legacy fallback margin = 20% of 10000 = 2000, reversed = -2000
      expect(logEventCall.amountCents).toBe(-2000);
      expect(logEventCall.escrowId).toBe('escrow-refund-2');
    });

    it('revenue ledger entry includes stripeEventId and stripeChargeId for audit trail', async () => {
      setupSuccessfulChargeRefundedFromReleased('escrow-refund-3', 5000);

      await expect(processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded')))
        .rejects.toThrow('RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED');

      const logEventCall = vi.mocked(RevenueService.logEvent).mock.calls[0][0];
      expect(logEventCall.stripeEventId).toBe('evt_charge_refunded');
      expect(logEventCall.stripeChargeId).toBe('ch_abc');
    });

    it('does NOT call RevenueService.logEvent when escrow is already terminal (skipped path)', async () => {
      const charge = exactFullRefundCharge({
        id: 'ch_skip',
        escrowId: 'escrow-skip',
        amount: 3000,
        paymentIntentId: 'pi_skip',
        refundId: 'ref_skip',
      });

      // 1. Claim
      setupClaim('charge.refunded', charge, 'evt_charge_skip');

      // Phase 1: Escrow SELECT → already REFUNDED (terminal skip path)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-skip',
          task_id: 'task-skip',
          state: 'REFUNDED',
          version: 5,
          amount: 3000,
          platform_fee_cents: null,
          stripe_refund_id: 'ref_skip',
          stripe_transfer_id: null,
          stripe_payment_intent_id: 'pi_skip',
          provider_transfer_status: null,
        }],
        rowCount: 1,
      } as never);

      // Phase 1: task lifecycle witness for a pre-completion refund.
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'task-skip', state: 'OPEN', progress_state: 'POSTED' }],
        rowCount: 1,
      } as never);

      // Phase 1 returns skipped=true, escrow.state='REFUNDED' → retry-recovery block runs
      // (uses db.query, not db.transaction)
      // Missing worker/released-dispute authority is retained by one exact fenced terminal update.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // Final exact inbox success after terminal witness/outbox recovery.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_skip'));

      // RevenueService.logEvent must NOT be called on the reconciliation path.
      expect(vi.mocked(RevenueService.logEvent)).not.toHaveBeenCalled();
    });

    it('recovers a canonical platform-fee reversal exactly once after a terminal retry', async () => {
      const charge = exactFullRefundCharge({
        id: 'ch_retry_canonical',
        escrowId: 'escrow-retry-canonical',
        amount: 10_000,
        paymentIntentId: 'pi_retry_canonical',
        refundId: 'ref_retry_canonical',
      });
      setupClaim('charge.refunded', charge, 'evt_charge_retry_canonical');
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-retry-canonical',
          task_id: 'task-retry-canonical',
          state: 'REFUNDED',
          version: 5,
          amount: 10_000,
          platform_fee_cents: 2500,
          stripe_refund_id: 'ref_retry_canonical',
          stripe_transfer_id: 'tr_existing',
          stripe_payment_intent_id: 'pi_retry_canonical',
          provider_transfer_status: 'paid',
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'task-retry-canonical', state: 'COMPLETED', progress_state: 'COMPLETED' }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ from_state: 'RELEASED' }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          amount_cents:-2500,currency:'usd',task_id:'task-retry-canonical',
          gross_amount_cents:10_000,platform_fee_cents:2500,
          net_amount_cents:7500,fee_basis_points:2500,
          escrow_id:'escrow-retry-canonical',stripe_event_id:'evt_charge_retry_canonical',
          stripe_charge_id:'ch_retry_canonical',stripe_payment_intent_id:'pi_retry_canonical',
          metadata:{
            refund_id:'ref_retry_canonical',reason:'charge_refunded_after_release',
          },
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('charge.refunded', 'evt_charge_retry_canonical'));

      expect(vi.mocked(RevenueService.logEvent)).toHaveBeenCalledWith(expect.objectContaining({
        eventType:'platform_fee_reversal',amountCents:-2500,
        escrowId:'escrow-retry-canonical',
      }));
    });

    it('classifies a full provider refund against REFUND_PARTIAL as reconciliation required', async () => {
      const charge = exactFullRefundCharge({
        id: 'ch_partial_mismatch',
        escrowId: 'escrow-partial-mismatch',
        amount: 5000,
        paymentIntentId: 'pi_partial_mismatch',
        refundId: 'ref_partial_mismatch',
      });
      setupClaim('charge.refunded', charge, 'evt_partial_mismatch');
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-partial-mismatch',
          task_id: 'task-partial-mismatch',
          state: 'REFUND_PARTIAL',
          version: 4,
          amount: 5000,
          platform_fee_cents: 1000,
          stripe_refund_id: 'ref_prior_partial',
          stripe_transfer_id: 'tr_partial',
          stripe_payment_intent_id: 'pi_partial_mismatch',
          provider_transfer_status: 'paid',
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('charge.refunded', 'evt_partial_mismatch'));

      expect(vi.mocked(StripeService.createTransferReversal)).not.toHaveBeenCalled();
      const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).toContain("result = 'failed'");
      expectRefundReconciliation(
        'evt_partial_mismatch',
        'Provider reports a full refund while the canonical escrow is only partially refunded.',
      );
      expect(sql).not.toContain("SET state = 'REFUNDED'");
      expect(sql).not.toContain("result = 'success'");
    });

    it('rejects a full refund whose PaymentIntent does not match the canonical escrow', async () => {
      const charge = exactFullRefundCharge({
        id: 'ch_cross_payment',
        escrowId: 'escrow-cross-payment',
        amount: 5000,
        paymentIntentId: 'pi_provider_other',
        refundId: 'ref_cross_payment',
      });
      setupClaim('charge.refunded', charge, 'evt_cross_payment');
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'escrow-cross-payment',
          task_id: 'task-cross-payment',
          state: 'FUNDED',
          version: 2,
          amount: 5000,
          platform_fee_cents: null,
          stripe_refund_id: null,
          stripe_transfer_id: null,
          stripe_payment_intent_id: 'pi_canonical',
          provider_transfer_status: null,
        }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('charge.refunded', 'evt_cross_payment'));

      const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).toContain("result = 'failed'");
      expectRefundReconciliation(
        'evt_cross_payment',
        'Provider charge identity or gross amount does not match the canonical escrow.',
      );
      expect(sql).not.toContain("SET state = 'REFUNDED'");
      expect(sql).not.toContain("result = 'success'");
    });

    it('retains a partial provider refund for reconciliation without reading or mutating escrow', async () => {
      const charge = exactFullRefundCharge({
        id: 'ch_partial_provider',
        escrowId: 'escrow-partial-provider',
        amount: 5000,
        paymentIntentId: 'pi_partial_provider',
        refundId: 'ref_partial_provider',
      });
      charge.amount_refunded = 2500;
      setupClaim('charge.refunded', charge, 'evt_partial_provider');
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('charge.refunded', 'evt_partial_provider'));

      const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).toContain("result = 'failed'");
      expectRefundReconciliation(
        'evt_partial_provider',
        'Provider event is not an exact full USD refund with a bound PaymentIntent.',
      );
      expect(sql).not.toContain('FROM escrows');
      expect(sql).not.toContain("SET state = 'REFUNDED'");
      expect(vi.mocked(StripeService.createTransferReversal)).not.toHaveBeenCalled();
    });

    it.each([
      ['currency', { currency: 'eur' }],
      ['status', { status: 'pending' }],
      ['Charge', { charge: 'ch_other' }],
      ['PaymentIntent', { payment_intent: 'pi_other' }],
    ])(
      'retains a full refund with wrong %s binding for reconciliation before canonical reads',
      async (_label, refundPatch) => {
        const stripeEventId = `evt_refund_wrong_${String(_label).toLowerCase()}`;
        const charge = exactFullRefundCharge({
          id:'ch_refund_binding',escrowId:'escrow-refund-binding',amount:5000,
          paymentIntentId:'pi_refund_binding',refundId:'re_refund_binding',
        });
        charge.refunds.data[0] = { ...charge.refunds.data[0], ...refundPatch };
        setupClaim('charge.refunded',charge,stripeEventId);
        mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

        await processPaymentJob(makeJob('charge.refunded',stripeEventId));

        expectRefundReconciliation(
          stripeEventId,
          'Provider refund list does not prove one exact succeeded full USD refund bound to this Charge and PaymentIntent.',
        );
        const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
        expect(sql).not.toContain('FROM escrows');
        expect(sql).not.toContain("SET state='REFUNDED'");
        expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
      },
    );

    it('does not collapse two succeeded partial refunds into one canonical full-refund identity', async () => {
      const stripeEventId = 'evt_refund_aggregate_partials';
      const charge = exactFullRefundCharge({
        id:'ch_aggregate',escrowId:'escrow-aggregate',amount:5000,
        paymentIntentId:'pi_aggregate',refundId:'re_unused',
      });
      const base = charge.refunds.data[0];
      charge.refunds.data = [
        { ...base,id:'re_partial_3000',amount:3000,created:2 },
        { ...base,id:'re_partial_2000',amount:2000,created:1 },
      ];
      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await processPaymentJob(makeJob('charge.refunded',stripeEventId));

      expectRefundReconciliation(
        stripeEventId,
        'Provider refund list does not prove one exact succeeded full USD refund bound to this Charge and PaymentIntent.',
      );
      expect(mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n'))
        .not.toContain('FROM escrows');
      expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    });

    it('rejects ambiguous duplicate full-refund witnesses and incomplete pagination', async () => {
      for (const [suffix,mutate] of [
        ['duplicates',(charge:ReturnType<typeof exactFullRefundCharge>) => {
          const exact = charge.refunds.data[0];
          charge.refunds.data = [{ ...exact,id:'re_full_a' },{ ...exact,id:'re_full_b' }];
        }],
        ['pagination',(charge:ReturnType<typeof exactFullRefundCharge>) => {
          charge.refunds.has_more = true;
        }],
      ] as const) {
        mockQuery.mockReset();
        const stripeEventId = `evt_refund_${suffix}`;
        const charge = exactFullRefundCharge({
          id:`ch_${suffix}`,escrowId:`escrow-${suffix}`,amount:5000,
          paymentIntentId:`pi_${suffix}`,refundId:`re_${suffix}`,
        });
        mutate(charge);
        setupClaim('charge.refunded',charge,stripeEventId);
        mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

        await processPaymentJob(makeJob('charge.refunded',stripeEventId));

        expectRefundReconciliation(
          stripeEventId,
          'Provider refund list does not prove one exact succeeded full USD refund bound to this Charge and PaymentIntent.',
        );
        expect(mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n'))
          .not.toContain('FROM escrows');
        expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
      }
    });

    it('selects the exact full-refund witness instead of a newer canceled partial row', async () => {
      const { charge } = setupSuccessfulChargeRefundedFromFunded('escrow-refund-order',5000);
      const exact = charge.refunds.data[0];
      charge.refunds.data = [
        { ...exact,id:'re_newer_canceled_partial',created:2,amount:1000,status:'canceled' },
        { ...exact,id:'re_exact_older',created:1 },
      ];

      await processPaymentJob(makeJob('charge.refunded','evt_charge_refunded'));

      const updateCall = mockQuery.mock.calls.find(([statement]) =>
        /UPDATE\s+escrows[\s\S]*SET state='REFUNDED'/i.test(String(statement)));
      expect(updateCall?.[1]?.[0]).toBe('re_exact_older');
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("result = 'success'");
    });

    const phase3DriftCases: Array<{
      label: string;
      escrowPatch?: Partial<RefundEscrowRow>;
      taskPatch?: Partial<RefundTaskRow>;
    }> = [
      { label: 'amount', escrowPatch: { amount: 5001 } },
      { label: 'PaymentIntent', escrowPatch: { stripe_payment_intent_id: 'pi_phase3_drift' } },
      { label: 'transfer', escrowPatch: { stripe_transfer_id: 'tr_phase3_drift' } },
      { label: 'provider status', escrowPatch: { provider_transfer_status: 'manual_reconciliation' } },
      { label: 'task lifecycle', taskPatch: { state: 'MATCHING' } },
    ];

    it.each(phase3DriftCases)(
      'persists Phase-3 $label drift evidence and keeps the event retryable',
      async ({ label, escrowPatch = {}, taskPatch = {} }) => {
        const escrowId = `escrow-drift-${label.replace(/\s+/g, '-').toLowerCase()}`;
        const taskId = `task-drift-${label.replace(/\s+/g, '-').toLowerCase()}`;
        const stripeEventId = `evt-drift-${label.replace(/\s+/g, '-').toLowerCase()}`;
        const charge = exactFullRefundCharge({ escrowId, amount: 5000 });
        const phase1Escrow = refundEscrowRow({ id: escrowId, task_id: taskId });
        const phase1Task = refundTaskRow({ id: taskId });

        setupClaim('charge.refunded', charge, stripeEventId);
        mockQuery.mockResolvedValueOnce({ rows: [phase1Escrow], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({ rows: [phase1Task], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({
          rows: [{ ...phase1Escrow, ...escrowPatch }],
          rowCount: 1,
        } as never);
        mockQuery.mockResolvedValueOnce({
          rows: [{ ...phase1Task, ...taskPatch }],
          rowCount: 1,
        } as never);
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
        // Exact fenced release after durable drift evidence is committed.
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

        await expect(processPaymentJob(makeJob('charge.refunded', stripeEventId)))
          .rejects.toThrow('REFUND_PHASE3_RECONCILIATION_RETRY_REQUIRED');

        const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
        expect(sql).toMatch(/INSERT\s+INTO\s+escrow_events\b/i);
        expect(sql).not.toMatch(/UPDATE\s+(?:escrows|tasks)\b/i);
        const evidenceInsert = mockQuery.mock.calls.find(([statement]) =>
          /INSERT\s+INTO\s+escrow_events\b/i.test(String(statement)));
        expect(JSON.parse(String((evidenceInsert?.[1] as unknown[] | undefined)?.[2])))
          .toMatchObject({
            reason:'charge_refunded_phase3_drift',
            stripe_event_id:stripeEventId,
            canonical_refund_applied:false,
          });
        expect(sql).toContain("result = 'failed'");
        expect(sql).not.toContain("result = 'success'");
        expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
        const claimReleaseSql = String(mockQuery.mock.calls.at(-1)?.[0]);
        expect(claimReleaseSql).toContain('claimed_at = NULL');
        expect(claimReleaseSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
        expect(claimReleaseSql).toContain('processed_at IS NULL');
      },
    );

    it('fails closed when a Phase-3 drift idempotency key collides with different evidence', async () => {
      const escrowId = 'escrow-drift-conflicting-evidence';
      const taskId = 'task-drift-conflicting-evidence';
      const stripeEventId = 'evt-drift-conflicting-evidence';
      const charge = exactFullRefundCharge({ escrowId,amount:5000 });
      const phase1Escrow = refundEscrowRow({ id:escrowId,task_id:taskId });
      const phase1Task = refundTaskRow({ id:taskId });

      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[phase1Escrow],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[phase1Task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ ...phase1Escrow,amount:5001 }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[phase1Task],rowCount:1 } as never);
      // The INSERT lost an idempotency race and the existing row did not match
      // the complete immutable metadata predicate in the CTE readback.
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await expect(processPaymentJob(makeJob('charge.refunded',stripeEventId)))
        .rejects.toThrow(/missing or conflicts with exact immutable facts/);

      const cteSql = mockQuery.mock.calls.map(([statement]) => String(statement))
        .find((statement) => statement.includes('WITH attempted AS'));
      expect(cteSql).toContain('metadata::jsonb=$3::jsonb');
      expect(cteSql).toContain('idempotency_key=$4');
      const finalSql = String(mockQuery.mock.calls.at(-1)?.[0]);
      expect(finalSql).toContain('claimed_at = NULL');
      expect(finalSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
      expect(finalSql).toContain('processed_at IS NULL');
      expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    });

    it('persists the exact reversal before rejecting Phase-3 drift after processor money moved', async () => {
      const escrowId = 'escrow-drift-after-reversal';
      const taskId = 'task-drift-after-reversal';
      const stripeEventId = 'evt-drift-after-reversal';
      const transferId = 'tr-drift-after-reversal';
      const charge = exactFullRefundCharge({ escrowId,amount:5000 });
      const phase1Escrow = refundEscrowRow({
        id:escrowId,task_id:taskId,state:'RELEASED',version:7,
        stripe_transfer_id:transferId,provider_transfer_status:'paid',
      });
      const phase1Task = refundTaskRow({
        id:taskId,state:'COMPLETED',progress_state:'COMPLETED',
      });

      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[phase1Escrow],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[phase1Task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          stripe_connect_id:'acct_drift_exact',payouts_enabled:true,
          account_status:'ACTIVE',binding_current:true,
        }],
        rowCount:1,
      } as never);
      vi.mocked(StripeService.createTransferReversal).mockResolvedValueOnce({
        success:true,
        data:{
          reversalId:'trr_test',reversalAmountCents:3900,
          transferWitness:{
            provider:'STRIPE',transferId,amountCents:3900,currency:'usd',
            destinationAccountId:'acct_drift_exact',reversed:true,amountReversedCents:3900,
            escrowId,taskId,payoutRecipientUserId:phase1Task.worker_id,
          },
        },
      });
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          amount_cents:-1000,currency:'usd',task_id:taskId,
          gross_amount_cents:5000,platform_fee_cents:1000,net_amount_cents:4000,
          fee_basis_points:2000,escrow_id:escrowId,stripe_event_id:stripeEventId,
          stripe_charge_id:'ch_abc',stripe_payment_intent_id:'pi_abc',
          metadata:{ refund_id:'ref_abc',reason:'charge_refunded_after_release' },
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          awards:[{
            user_id:phase1Task.worker_id,task_id:taskId,escrow_id:escrowId,
            base_xp:50,effective_xp:50,reason:'task_completion',
          }],
          clawbacks:[{
            user_id:phase1Task.worker_id,task_id:taskId,escrow_id:escrowId,
            base_xp:-50,effective_xp:-50,reason:'task_refunded',
          }],
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ ...phase1Escrow,amount:5001 }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[phase1Task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ version:8 }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await expect(processPaymentJob(makeJob('charge.refunded',stripeEventId)))
        .rejects.toThrow('RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED');

      expect(StripeService.createTransferReversal).toHaveBeenCalledWith(
        transferId,escrowId,expect.any(String),
      );
      expect(persistReversalWitness).toHaveBeenCalledWith(
        expect.any(Function),expect.objectContaining({
          escrowId,transferId,canonicalState:'RELEASED',
        }),
      );
      const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).not.toContain("SET state='REFUNDED'");
      expect(sql).not.toContain("result = 'success'");
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
    });

    it('routes RELEASED escrow without a transfer identity to reconciliation', async () => {
      const escrowId = 'escrow-released-without-transfer';
      const taskId = 'task-released-without-transfer';
      const stripeEventId = 'evt-released-without-transfer';
      const charge = exactFullRefundCharge({ escrowId, amount: 5000 });
      const escrow = refundEscrowRow({
        id: escrowId,
        task_id: taskId,
        state: 'RELEASED',
        stripe_transfer_id: null,
      });
      const task = refundTaskRow({ id: taskId });

      setupClaim('charge.refunded', charge, stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await processPaymentJob(makeJob('charge.refunded', stripeEventId));

      const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expectRefundReconciliation(
        stripeEventId,
        'Released escrow has no worker-transfer identity and cannot be finalized as an ordinary refund.',
      );
      expect(sql).not.toMatch(/UPDATE\s+(?:escrows|tasks)\b/i);
      expect(sql).not.toMatch(/INSERT\s+INTO\s+escrow_events\b/i);
      expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    });

    it('classifies a preserved transfer as released economics from exact dispute history', async () => {
      const escrowId='escrow-preserved-release-refund';
      const taskId='task-preserved-release-refund';
      const workerId='worker-preserved-release-refund';
      const transferId='tr_preserved_release_refund';
      const stripeEventId='evt_preserved_release_refund';
      const charge=exactFullRefundCharge({ escrowId,amount:5000 });
      const escrow=refundEscrowRow({
        id:escrowId,task_id:taskId,state:'LOCKED_DISPUTE',version:8,
        stripe_transfer_id:transferId,provider_transfer_status:'reversed',
      });
      const task=refundTaskRow({
        id:taskId,state:'CANCELLED',progress_state:'CANCELLED',worker_id:workerId,
      });
      const reversalMetadata={
        event_type:'full_transfer_reversal_witness_v1',provider:'stripe',
        escrow_id:escrowId,canonical_state:'LOCKED_DISPUTE',task_id:taskId,
        worker_id:workerId,payout_recipient_user_id:workerId,
        destination_account_id:'acct_preserved_refund',stripe_payment_intent_id:'pi_abc',
        stripe_transfer_id:transferId,escrow_amount_cents:5000,
        platform_fee_cents:1000,insurance_contribution_cents:100,
        transfer_amount_cents:3900,currency:'usd',amount_reversed_cents:3900,
        reversed:true,
      };
      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[escrow],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ id:'dispute-refund',task_id:taskId,escrow_id:escrowId,
          state:'RESOLVED',outcome_escrow_action:'REFUND' }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ metadata:{
          event_type:'dispute_locked_after_release',task_id:taskId,
          initiated_by:'poster-preserved-release-refund',
          original_transfer_id:transferId,escrow_version:7,
        },idempotency_key:`released-dispute-origin-v1:${escrowId}:7` }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ metadata:reversalMetadata,idempotency_key:
          `full-transfer-reversal-witness-v1:${escrowId}:${transferId}` }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ stripe_connect_id:'acct_preserved_refund',payouts_enabled:true,
          account_status:'ACTIVE',binding_current:true }],rowCount:1,
      } as never);
      vi.mocked(StripeService.readTransferWitness).mockResolvedValueOnce({
        success:true,data:{
          provider:'STRIPE',transferId,amountCents:3900,currency:'usd',
          destinationAccountId:'acct_preserved_refund',reversed:true,
          amountReversedCents:3900,escrowId,taskId,payoutRecipientUserId:workerId,
        },
      });
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{
        amount_cents:-1000,currency:'usd',task_id:taskId,gross_amount_cents:5000,
        platform_fee_cents:1000,net_amount_cents:4000,fee_basis_points:2000,
        escrow_id:escrowId,stripe_event_id:stripeEventId,stripe_charge_id:'ch_abc',
        stripe_payment_intent_id:'pi_abc',metadata:{ refund_id:'ref_abc',
          reason:'charge_refunded_after_release' },
      }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{
        awards:[{ user_id:workerId,task_id:taskId,escrow_id:escrowId,
          base_xp:50,effective_xp:50,reason:'task_completion' }],
        clawbacks:[{ user_id:workerId,task_id:taskId,escrow_id:escrowId,
          base_xp:-50,effective_xp:-50,reason:'task_refunded' }],
      }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ task_id:taskId,hustler_id:workerId,
        contribution_cents:100,contribution_percentage:2 }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ user_id:workerId,task_id:taskId,
        escrow_id:escrowId,net_payout_cents:3900,cumulative_earnings_before_cents:0,
        cumulative_earnings_after_cents:3900 }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ user_id:workerId,
        total_net_earnings_cents:3900,earned_unlock_threshold_cents:4000,
        earned_unlock_achieved:false,completed_task_count:1 }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ id:'economics-block' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await expect(processPaymentJob(makeJob('charge.refunded',stripeEventId)))
        .rejects.toThrow('RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED');
      expect(StripeService.readTransferWitness).toHaveBeenCalledWith(transferId);
      expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
      expect(persistReversalWitness).not.toHaveBeenCalled();
      expect(mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n'))
        .not.toContain("SET state='REFUNDED'");
    });

    it('terminalizes an exact ordinary no-transfer LOCKED_DISPUTE refund and ACKs its durable outbox', async () => {
      const escrowId='escrow-ordinary-locked-refund';
      const taskId='task-ordinary-locked-refund';
      const stripeEventId='evt-ordinary-locked-refund';
      const refundId='ref_ordinary_locked_refund';
      const charge=exactFullRefundCharge({ escrowId,amount:5000,refundId });
      const escrow=refundEscrowRow({
        id:escrowId,task_id:taskId,state:'LOCKED_DISPUTE',version:8,
        stripe_refund_id:refundId,stripe_transfer_id:null,
      });
      const task=refundTaskRow({
        id:taskId,state:'EXPIRED',progress_state:'POSTED',refund_state:'PENDING',
      });

      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[escrow],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ ...escrow }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ ...task }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ id:taskId }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ id:escrowId,state:'REFUNDED',version:9 }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ id:'ordinary-refund-event' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await processPaymentJob(makeJob('charge.refunded',stripeEventId));

      const bindingCall=mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes('action_refund_provider_claim_v1'));
      expect(bindingCall?.[1]).toEqual([
        escrowId,taskId,7,5000,'pi_abc',refundId,'ch_abc',
        `action-refund-provider-claim-v1:${escrowId}:7:5000`,
        `exact-succeeded-refund-v1:${escrowId}:${refundId}`,
      ]);
      const refundCas=mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes("SET state='REFUNDED'"));
      expect(refundCas?.[1]).toEqual([
        refundId,null,escrowId,'LOCKED_DISPUTE',8,5000,null,refundId,null,'pi_abc',null,
      ]);
      const taskRefundCas=mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes("refund_state='REFUNDED'"));
      expect(taskRefundCas?.[1]).toEqual([taskId,'EXPIRED','POSTED',null]);
      expect(persistRefundWitness).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          escrowId,taskId,canonicalState:'LOCKED_DISPUTE',refundId,chargeId:'ch_abc',
        }),
      );
      expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
        eventType:'escrow.refunded',aggregateId:escrowId,eventVersion:9,
        idempotencyKey:`escrow.refunded:${escrowId}:9`,
      }));
      expect(markStripeEventOutboxesProcessed).toHaveBeenCalledWith({
        idempotencyKey:`stripe.event_received:${stripeEventId}`,stripeEventId,
      });
      expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    });

    it('never routes a transfer-bearing LOCKED_DISPUTE refund through the ordinary lane', async () => {
      const escrowId='escrow-hostile-transfer-refund';
      const taskId='task-hostile-transfer-refund';
      const stripeEventId='evt-hostile-transfer-refund';
      const refundId='ref_hostile_transfer_refund';
      const charge=exactFullRefundCharge({ escrowId,amount:5000,refundId });
      const escrow=refundEscrowRow({
        id:escrowId,task_id:taskId,state:'LOCKED_DISPUTE',version:8,
        stripe_refund_id:refundId,stripe_transfer_id:'tr_hostile_transfer',
        provider_transfer_status:'reversed',
      });
      const task=refundTaskRow({
        id:taskId,state:'CANCELLED',progress_state:'CANCELLED',
      });

      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[escrow],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await processPaymentJob(makeJob('charge.refunded',stripeEventId));

      const sql=mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).toContain("outcome_escrow_action='REFUND'");
      expect(sql).not.toContain('action_refund_provider_claim_v1');
      expect(sql).not.toContain("SET state='REFUNDED'");
      expect(writeToOutbox).not.toHaveBeenCalledWith(expect.objectContaining({
        eventType:'escrow.refunded',
      }));
      expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
      expectRefundReconciliation(
        stripeEventId,
        `Escrow ${escrowId} lacks one exact resolved REFUND dispute authority`,
      );
    });

    it('refuses ordinary terminalization when the exact action claim or provider witness is missing', async () => {
      const escrowId='escrow-missing-ordinary-refund-proof';
      const taskId='task-missing-ordinary-refund-proof';
      const stripeEventId='evt-missing-ordinary-refund-proof';
      const refundId='ref_missing_ordinary_refund_proof';
      const charge=exactFullRefundCharge({ escrowId,amount:5000,refundId });
      const escrow=refundEscrowRow({
        id:escrowId,task_id:taskId,state:'LOCKED_DISPUTE',version:8,
        stripe_refund_id:refundId,stripe_transfer_id:null,
      });
      const task=refundTaskRow({
        id:taskId,state:'CANCELLED',progress_state:'CANCELLED',
      });

      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[escrow],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ exact:false }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await processPaymentJob(makeJob('charge.refunded',stripeEventId));

      const sql=mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).toContain('action_refund_provider_claim_v1');
      expect(sql).toContain('exact_succeeded_refund_witness_v1');
      expect(sql).not.toContain("SET state='REFUNDED'");
      expect(writeToOutbox).not.toHaveBeenCalledWith(expect.objectContaining({
        eventType:'escrow.refunded',
      }));
      expectRefundReconciliation(
        stripeEventId,
        `Escrow ${escrowId} lacks one exact no-transfer action claim and provider witness`,
      );
    });

    it('recovers outbox and inbox ACKs after an ordinary refund commit crashes before publication', async () => {
      const escrowId='escrow-ordinary-refund-crash';
      const taskId='task-ordinary-refund-crash';
      const stripeEventId='evt-ordinary-refund-crash';
      const refundId='ref_ordinary_refund_crash';
      const charge=exactFullRefundCharge({ escrowId,amount:5000,refundId });
      const before=refundEscrowRow({
        id:escrowId,task_id:taskId,state:'LOCKED_DISPUTE',version:8,
        stripe_refund_id:refundId,stripe_transfer_id:null,
      });
      const task=refundTaskRow({
        id:taskId,state:'CANCELLED',progress_state:'CANCELLED',
      });

      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[before],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ ...before }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ ...task }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{ id:escrowId,state:'REFUNDED',version:9 }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ id:'ordinary-refund-event' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);
      vi.mocked(writeToOutbox).mockRejectedValueOnce(new Error('outbox unavailable'));

      await expect(processPaymentJob(makeJob('charge.refunded',stripeEventId)))
        .rejects.toThrow('outbox unavailable');
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
      expect(markStripeEventOutboxesProcessed).not.toHaveBeenCalled();

      mockQuery.mockReset();
      vi.mocked(writeToOutbox).mockReset().mockResolvedValue(undefined);
      markStripeEventOutboxesProcessed.mockClear();
      const terminal={ ...before,state:'REFUNDED',version:9 };
      setupClaim('charge.refunded',charge,stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows:[terminal],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[task],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ from_state:'LOCKED_DISPUTE' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

      await processPaymentJob(makeJob('charge.refunded',stripeEventId));

      expect(mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n'))
        .not.toContain("SET state='REFUNDED'");
      expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
        eventType:'escrow.refunded',aggregateId:escrowId,eventVersion:9,
        idempotencyKey:`escrow.refunded:${escrowId}:9`,
      }));
      expect(markStripeEventOutboxesProcessed).toHaveBeenCalledWith({
        idempotencyKey:`stripe.event_received:${stripeEventId}`,stripeEventId,
      });
    });

    it.each(['PENDING', 'FUNDED'] as const)(
      'atomically cancels an OPEN task while refunding a pre-completion %s escrow',
      async (escrowState) => {
        const transactionStatements = traceTransactionStatements();
        const escrowId = `escrow-pre-completion-${escrowState.toLowerCase()}`;
        const taskId = `task-pre-completion-${escrowState.toLowerCase()}`;
        const stripeEventId = `evt-pre-completion-${escrowState.toLowerCase()}`;
        const charge = exactFullRefundCharge({ escrowId, amount: 5000 });
        const escrow = refundEscrowRow({
          id: escrowId,
          task_id: taskId,
          state: escrowState,
        });
        const task = refundTaskRow({ id: taskId });

        setupClaim('charge.refunded', charge, stripeEventId);
        mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({ rows: [{ ...escrow }], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({ rows: [{ ...task }], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: escrowId, state: 'REFUNDED', version: 3 }],
          rowCount: 1,
        } as never);
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

        await processPaymentJob(makeJob('charge.refunded', stripeEventId));

        expect(transactionStatements).toHaveLength(2);
        expect(transactionStatements[1].some((sql) => /UPDATE\s+tasks\b/i.test(sql))).toBe(true);
        expect(transactionStatements[1].some((sql) => /UPDATE\s+escrows\b/i.test(sql))).toBe(true);
        const taskUpdate = mockQuery.mock.calls.find(([statement]) =>
          /UPDATE\s+tasks\b/i.test(String(statement)));
        expect(taskUpdate?.[1]).toEqual([taskId, 'OPEN', 'POSTED']);
        const eventInsert = mockQuery.mock.calls.find(([statement]) =>
          /INSERT\s+INTO\s+escrow_events\b/i.test(String(statement)));
        expect(JSON.parse(String((eventInsert?.[1] as unknown[] | undefined)?.[2]))).toMatchObject({
          task_cancelled: true,
          provider_transfer_status: null,
        });
        expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
        expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("result = 'success'");
      },
    );

    it('persists manual reconciliation and refuses ordinary success after transfer-reversal failure', async () => {
      setupSuccessfulChargeRefundedFromReleased('escrow-reversal-failed', 5000, false);
      vi.mocked(StripeService.createTransferReversal)
        .mockReset()
        .mockResolvedValueOnce({
          success: false,
          error: { code: 'TRANSFER_REVERSAL_FAILED', message: 'provider rejected reversal' },
        });

      await expect(processPaymentJob(makeJob('charge.refunded', 'evt_charge_refunded')))
        .rejects.toThrow('TRANSFER_REVERSAL_RETRY_REQUIRED');

      const updateCall = mockQuery.mock.calls.find(([statement]) =>
        /SET provider_transfer_status='manual_reconciliation'/i.test(String(statement)));
      expect(updateCall?.[1]).toEqual([
        'escrow-reversal-failed',
        'RELEASED',
        2,
        'tr_existing',
        'paid',
      ]);
      const eventInsert = mockQuery.mock.calls.find(([, params]) =>
        String((params as unknown[] | undefined)?.[3] ?? '')
          .startsWith('escrow.refund:escrow-reversal-failed:'));
      expect(JSON.parse(String((eventInsert?.[1] as unknown[] | undefined)?.[2]))).toMatchObject({
        provider_transfer_status: 'manual_reconciliation',
        transfer_id: 'tr_existing',
        transfer_reversal_id: null,
        transfer_reversal_error: expect.stringContaining('provider rejected reversal'),
      });
      expect(StripeService.createTransferReversal).toHaveBeenCalledWith(
        'tr_existing',
        'escrow-reversal-failed',
        'ref_abc',
      );
      const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
      expect(sql).not.toContain("SET state='REFUNDED'");
      expect(sql).toContain("result = 'failed'");
      expect(sql).not.toContain("result = 'success'");
      const claimReleaseSql = String(mockQuery.mock.calls.at(-1)?.[0]);
      expect(claimReleaseSql).toContain('claimed_at = NULL');
      expect(claimReleaseSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
      expect(claimReleaseSql).toContain('processed_at IS NULL');
    });

    it('retries the same transfer reversal from REFUNDED/manual and records provider confirmation', async () => {
      const escrowId = 'escrow-reversal-retry';
      const taskId = 'task-reversal-retry';
      const stripeEventId = 'evt-reversal-retry';
      const refundId = 'ref_reversal_retry';
      const transferId = 'tr_reversal_retry';
      const charge = exactFullRefundCharge({
        escrowId,
        amount: 5000,
        paymentIntentId: 'pi_reversal_retry',
        refundId,
      });
      const escrow = refundEscrowRow({
        id: escrowId,
        task_id: taskId,
        state: 'REFUNDED',
        version: 3,
        stripe_refund_id: refundId,
        stripe_transfer_id: transferId,
        stripe_payment_intent_id: 'pi_reversal_retry',
        provider_transfer_status: 'manual_reconciliation',
      });
      const task = refundTaskRow({
        id: taskId,
        state: 'COMPLETED',
        progress_state: 'COMPLETED',
      });

      setupClaim('charge.refunded', charge, stripeEventId);
      mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ from_state: 'RELEASED' }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          stripe_connect_id:'acct_reversal_retry',payouts_enabled:true,
          account_status:'ACTIVE',binding_current:true,
        }],
        rowCount:1,
      } as never);
      vi.mocked(StripeService.createTransferReversal).mockResolvedValueOnce({
        success: true,
        data: {
          reversalId:'trr_retry_confirmed',reversalAmountCents:3900,
          transferWitness:{
            provider:'STRIPE',transferId,amountCents:3900,currency:'usd',
            destinationAccountId:'acct_reversal_retry',reversed:true,amountReversedCents:3900,
            escrowId,taskId,payoutRecipientUserId:task.worker_id,
          },
        },
      });
      mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          amount_cents:-1000,currency:'usd',task_id:taskId,
          gross_amount_cents:5000,platform_fee_cents:1000,net_amount_cents:4000,
          fee_basis_points:2000,escrow_id:escrowId,stripe_event_id:stripeEventId,
          stripe_charge_id:'ch_abc',stripe_payment_intent_id:'pi_reversal_retry',
          metadata:{ refund_id:refundId,reason:'charge_refunded_after_release' },
        }],
        rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          awards:[{
            user_id:task.worker_id,task_id:taskId,escrow_id:escrowId,
            base_xp:50,effective_xp:50,reason:'task_completion',
          }],
          clawbacks:[{
            user_id:task.worker_id,task_id:taskId,escrow_id:escrowId,
            base_xp:-50,effective_xp:-50,reason:'task_refunded',
          }],
        }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ ...escrow }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [{ ...task }], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ id:'provider-status-authority' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ set_config:escrowId }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'REFUNDED', version: 4 }],
        rowCount: 1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          task_id:taskId,hustler_id:task.worker_id,
          contribution_cents:100,contribution_percentage:2,
        }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          user_id:task.worker_id,task_id:taskId,escrow_id:escrowId,
          net_payout_cents:3900,cumulative_earnings_before_cents:0,
          cumulative_earnings_after_cents:3900,
        }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({
        rows:[{
          user_id:task.worker_id,total_net_earnings_cents:3900,
          earned_unlock_threshold_cents:4000,earned_unlock_achieved:false,
          completed_task_count:1,
        }],rowCount:1,
      } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ id:'economics-block' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      await expect(processPaymentJob(makeJob('charge.refunded', stripeEventId)))
        .rejects.toThrow('RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED');

      expect(StripeService.createTransferReversal).toHaveBeenCalledOnce();
      expect(StripeService.createTransferReversal).toHaveBeenCalledWith(
        transferId,
        escrowId,
        refundId,
      );
      const retryUpdate = mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes("SET provider_transfer_status='reversed'"));
      expect(retryUpdate?.[1]).toEqual([
        escrowId,
        3,
        5000,
        null,
        refundId,
        transferId,
        'pi_reversal_retry',
      ]);
      const eventInsert = mockQuery.mock.calls.find(([, params]) =>
        String((params as unknown[] | undefined)?.[3] ?? '')
          .startsWith(`escrow.refund:${escrowId}:`));
      expect(JSON.parse(String((eventInsert?.[1] as unknown[] | undefined)?.[2]))).toMatchObject({
        provider_transfer_status: 'reversed',
        transfer_id: transferId,
        transfer_reversal_id: 'trr_retry_confirmed',
        transfer_reversal_error: null,
      });
      expect((eventInsert?.[1] as unknown[] | undefined)?.[3])
        .toBe(`escrow.refund:${escrowId}:${stripeEventId}:reversal-confirmed`);
      expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
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

describe('processPaymentJob — transfer.created exact release-witness convergence', () => {
  const STRIPE_EVENT_ID = 'evt_transfer_dup_fee';
  const ESCROW_ID = 'escrow-dup-fee';

  function setupReleaseForReconciliation(options: {
    amount?: number;
    platformFeeCents?: number | null;
  } = {}) {
    const amount = options.amount ?? 10_000;
    const platformFeeCents = options.platformFeeCents === undefined ? 2500 : options.platformFeeCents;
    const expectedTransferAmount = amount
      - (platformFeeCents ?? Math.round(amount * 0.15))
      - Math.round(amount * 0.02);
    setupClaim('transfer.created', {
      id: 'tr_dup',
      amount: expectedTransferAmount,
      amount_reversed: 0,
      currency: 'usd',
      destination: 'acct_dup_expected',
      reversed: false,
      metadata: { escrow_id: ESCROW_ID, task_id: 'task-dup', worker_id: 'worker-dup' },
    }, STRIPE_EVENT_ID);
    setupTransferWitness({
      transferId: 'tr_dup',
      escrowId: ESCROW_ID,
      taskId: 'task-dup',
      payoutRecipientUserId: 'worker-dup',
      destinationAccountId: 'acct_dup_expected',
      amountCents: expectedTransferAmount,
    });
    // 2. SELECT escrow FOR UPDATE → LOCKED_DISPUTE (releasable, not terminal)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: ESCROW_ID,
        task_id: 'task-dup',
        state: 'LOCKED_DISPUTE',
        version: 3,
        amount,
        platform_fee_cents: platformFeeCents,
        stripe_transfer_id: null,
        stripe_payment_intent_id: 'pi_transfer_fee',
      }],
      rowCount: 1,
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [{ worker_id: 'worker-dup', payout_recipient_user_id: null }],
      rowCount: 1,
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        stripe_connect_id: 'acct_dup_expected',
        payouts_enabled: true,
        account_status: 'ACTIVE',
        binding_current: true,
      }],
      rowCount: 1,
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows:[{
        id:ESCROW_ID,task_id:'task-dup',state:'RELEASED',version:4,amount,
        platform_fee_cents:platformFeeCents,stripe_transfer_id:'tr_dup',
        provider_transfer_status:'paid',
      }],
      rowCount:1,
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows:[{ worker_id:'worker-dup',payout_recipient_user_id:null }],rowCount:1,
    } as never);
    mockQuery.mockResolvedValueOnce({
      rows:[{
        stripe_connect_id:'acct_dup_expected',payouts_enabled:true,
        account_status:'ACTIVE',binding_current:true,
      }],
      rowCount:1,
    } as never);
  }

  it('delegates every accepted release to exact idempotent witness reconciliation before success', async () => {
    setupReleaseForReconciliation();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(processPaymentJob(makeJob('transfer.created', STRIPE_EVENT_ID))).resolves.toBeUndefined();

    expect(EscrowReleaseReconciliationService.reconcile).toHaveBeenCalledWith({
      escrowId: ESCROW_ID,
      expectedStripeTransferId: 'tr_dup',
      fromState: 'LOCKED_DISPUTE',
    });
    expect(RevenueService.logEvent).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n'))
      .not.toContain('FROM revenue_ledger');
    expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("result = 'success'");
  });

  it.each([
    ['wrong immutable platform-fee row','Platform-fee witness is not exact'],
    ['positive platform-fee row on zero-margin escrow','Zero-margin escrow has a platform-fee witness'],
    ['missing task closure witness','release witnesses do not match canonical lifecycle'],
  ])('retains the webhook claim when reconciliation rejects %s', async (_label,message) => {
    setupReleaseForReconciliation({
      platformFeeCents: _label.includes('zero-margin') ? 0 : 2500,
    });
    vi.mocked(EscrowReleaseReconciliationService.reconcile).mockResolvedValueOnce({
      success:false,
      error:{ code:'CONFLICT',message },
    });
    mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

    await expect(processPaymentJob(makeJob('transfer.created',STRIPE_EVENT_ID)))
      .rejects.toThrow(/Release-witness convergence failed/);

    const finalSql = String(mockQuery.mock.calls.at(-1)?.[0]);
    expect(finalSql).toContain('claimed_at = NULL');
    expect(finalSql).toContain("result = 'failed'");
    expect(finalSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
    expect(finalSql).toContain('processed_at IS NULL');
  });
});

describe('processPaymentJob — transfer.reversed durable exception path', () => {
  const stripeEventId = 'evt_transfer_reversed';
  const transferId = 'tr_reversed';
  const escrowId = 'escrow-reversed';
  const taskId = 'task-reversed';
  const amountCents = 7300;

  function setupReversedTransfer(options: {
    state?: string;
    providerTransferStatus?: string;
    amountReversedCents?: number;
    reversed?: boolean;
    witnessAmountCents?: number;
    witnessDestination?: string;
    eventRowCount?: number;
    canonicalTransferId?: string;
  } = {}) {
    const amountReversedCents = options.amountReversedCents ?? amountCents;
    setupClaim('transfer.reversed', {
      id:transferId,
      metadata:{ escrow_id:escrowId,task_id:taskId,worker_id:'worker-reversed' },
    },stripeEventId);
    setupTransferWitness({
      transferId,
      escrowId,
      taskId,
      payoutRecipientUserId:'worker-reversed',
      destinationAccountId:options.witnessDestination ?? 'acct_reversed',
      amountCents:options.witnessAmountCents ?? amountCents,
      reversed:options.reversed ?? amountReversedCents === amountCents,
      amountReversedCents,
    });
    mockQuery.mockResolvedValueOnce({
      rows:[{
        id:escrowId,task_id:taskId,state:options.state ?? 'RELEASED',version:4,amount:10_000,
        platform_fee_cents:2500,stripe_transfer_id:options.canonicalTransferId ?? transferId,
        provider_transfer_status:options.providerTransferStatus ?? 'paid',
        worker_id:'worker-reversed',payout_recipient_user_id:null,
      }],
      rowCount:1,
    } as never);
    const exactFullBinding = (options.canonicalTransferId ?? transferId) === transferId
      && (options.witnessDestination ?? 'acct_reversed') === 'acct_reversed'
      && (options.witnessAmountCents ?? amountCents) === amountCents
      && (options.reversed ?? amountReversedCents === amountCents)
      && amountReversedCents === amountCents;
    const canonicalExpected = exactFullBinding
      && (options.state ?? 'RELEASED') === 'REFUNDED'
      && (options.providerTransferStatus ?? 'paid') === 'reversed';
    mockQuery.mockResolvedValueOnce({
      rows:[{
        stripe_connect_id:'acct_reversed',payouts_enabled:true,
        account_status:'ACTIVE',binding_current:true,
      }],
      rowCount:1,
    } as never);
    if ((options.canonicalTransferId ?? transferId) === transferId && !canonicalExpected) {
      mockQuery.mockResolvedValueOnce({ rows:[{ id:'provider-status-authority' }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ set_config:escrowId }],rowCount:1 } as never);
      mockQuery.mockResolvedValueOnce({ rows:[{ version:5 }],rowCount:1 } as never);
    }
    mockQuery.mockResolvedValueOnce({
      rows:options.eventRowCount === 0 ? [] : [{ id:'event-reversal' }],
      rowCount:options.eventRowCount ?? 1,
    } as never);
    mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);
  }

  it('retains an unexpected partial reversal as a durable actor-independent exception', async () => {
    setupReversedTransfer({ amountReversedCents:1000,reversed:false });

    await processPaymentJob(makeJob('transfer.reversed',stripeEventId));

    const cteCall = mockQuery.mock.calls.find(([, params]) =>
      String((params as unknown[] | undefined)?.[3] ?? '').startsWith('escrow.transfer-reversed:'));
    const metadata = JSON.parse(String((cteCall?.[1] as unknown[] | undefined)?.[2]));
    expect(metadata).toMatchObject({
      reason:'transfer_reversed_provider_fact',
      reason_code:'UNEXPECTED_TRANSFER_REVERSAL',
      stripe_event_id:stripeEventId,
      transfer_id:transferId,
      amount_cents:amountCents,
      amount_reversed_cents:1000,
      exact_transfer_binding:true,
      canonical_refund_converged:false,
      canonical_transfer_id_matched:true,
      provider_transfer_status_before:'paid',
      provider_transfer_status_after:'manual_reconciliation',
    });
    expect((cteCall?.[1] as unknown[] | undefined)?.[3])
      .toBe(`escrow.transfer-reversed:${escrowId}:${transferId}:${stripeEventId}:1000`);
    const quarantine = mockQuery.mock.calls.find(([statement]) =>
      String(statement).includes("SET provider_transfer_status='manual_reconciliation'"));
    expect(quarantine?.[1]).toEqual([escrowId,4,transferId,'paid']);
    expect(mockQuery.mock.calls.indexOf(quarantine!))
      .toBeLessThan(mockQuery.mock.calls.indexOf(cteCall!));
    const finalSql = String(mockQuery.mock.calls.at(-1)?.[0]);
    expect(finalSql).toContain('processed_at = NOW()');
    expect(finalSql).toContain("result = 'failed'");
    expect(EscrowService.release).not.toHaveBeenCalled();
  });

  it.each([
    ['destination',{ witnessDestination:'acct_wrong' }],
    ['amount',{ witnessAmountCents:7299 }],
  ])('retains a reversed transfer with wrong %s binding for reconciliation', async (_label,patch) => {
    setupReversedTransfer(patch);

    await processPaymentJob(makeJob('transfer.reversed',stripeEventId));

    const cteCall = mockQuery.mock.calls.find(([, params]) =>
      String((params as unknown[] | undefined)?.[3] ?? '').startsWith('escrow.transfer-reversed:'));
    const metadata = JSON.parse(String((cteCall?.[1] as unknown[] | undefined)?.[2]));
    expect(metadata).toMatchObject({
      reason_code:'TRANSFER_REVERSAL_BINDING_MISMATCH',
      exact_transfer_binding:false,
      canonical_refund_converged:false,
    });
    expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("result = 'failed'");
  });

  it('does not poison a different canonical transfer when the reversal ID is not current', async () => {
    setupReversedTransfer({ canonicalTransferId:'tr_other_canonical' });

    await processPaymentJob(makeJob('transfer.reversed',stripeEventId));

    const sql = mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain("SET provider_transfer_status='manual_reconciliation'");
    const cteCall = mockQuery.mock.calls.find(([, params]) =>
      String((params as unknown[] | undefined)?.[3] ?? '').startsWith('escrow.transfer-reversed:'));
    const metadata = JSON.parse(String((cteCall?.[1] as unknown[] | undefined)?.[2]));
    expect(metadata).toMatchObject({
      reason_code:'TRANSFER_REVERSAL_BINDING_MISMATCH',
      canonical_transfer_id_matched:false,
      provider_transfer_status_before:'paid',
      provider_transfer_status_after:'paid',
    });
  });

  it('dispatches an exactly signed reversal and accepts only a full canonical REFUNDED witness', async () => {
    setupReversedTransfer({ state:'REFUNDED',providerTransferStatus:'reversed' });

    const actualQueues = await vi.importActual<typeof import('../../src/jobs/queues.js')>(
      '../../src/jobs/queues.js',
    );
    const outboxKey = `stripe.event_received:${stripeEventId}`;
    const unsigned = {
      stripeEventId,
      type: 'transfer.reversed',
      _outbox_key: outboxKey,
    };
    const signature = actualQueues.signJobPayload(unsigned);
    vi.mocked(verifyJobSignature).mockImplementation((candidate, candidateSignature) =>
      actualQueues.verifyJobSignature(candidate, candidateSignature));
    const job = {
      id: outboxTransportJobId(outboxKey),
      data: {
        aggregate_type: 'stripe_event',
        aggregate_id: stripeEventId,
        event_version: 1,
        payload: { ...unsigned, _sig: signature },
      },
    } as Job;

    await processStripeEventDispatchJob(job);

    expect(verifyJobSignature).toHaveBeenCalledWith(unsigned, signature);
    const cteCall = mockQuery.mock.calls.find(([, params]) =>
      String((params as unknown[] | undefined)?.[3] ?? '').startsWith('escrow.transfer-reversed:'));
    const metadata = JSON.parse(String((cteCall?.[1] as unknown[] | undefined)?.[2]));
    expect(metadata).toMatchObject({
      reason_code:'CANONICAL_REFUND_TRANSFER_REVERSAL_CONFIRMED',
      exact_transfer_binding:true,
      canonical_refund_converged:true,
      canonical_transfer_id_matched:true,
      provider_transfer_status_before:'reversed',
      provider_transfer_status_after:'reversed',
    });
    expect(mockQuery.mock.calls.map(([statement]) => String(statement)).join('\n'))
      .not.toContain("SET provider_transfer_status='manual_reconciliation'");
    expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("result = 'success'");
  });

  it('retries instead of accepting a conflicting durable reversal-event key', async () => {
    setupReversedTransfer({ amountReversedCents:1000,reversed:false,eventRowCount:0 });

    await expect(processPaymentJob(makeJob('transfer.reversed',stripeEventId)))
      .rejects.toThrow(/missing or conflicts with exact immutable facts/);

    const finalSql = String(mockQuery.mock.calls.at(-1)?.[0]);
    expect(finalSql).toContain('claimed_at = NULL');
    expect(finalSql).not.toMatch(/SET[\s\S]*processed_at\s*=/);
    expect(finalSql).toContain('processed_at IS NULL');
  });
});

describe('transfer.failed — exact provider and revenue reconciliation witnesses', () => {
  const stripeEventId = 'evt_transfer_failed_exact';
  const transferId = 'tr_failed_exact';
  const escrowId = 'escrow-transfer-failed-exact';
  const taskId = 'task-transfer-failed-exact';
  const workerId = 'worker-transfer-failed-exact';
  const destination = 'acct-transfer-failed-exact';

  const transfer = {
    id: transferId,
    amount: 8_300,
    amount_reversed: 0,
    currency: 'usd',
    destination,
    reversed: false,
    metadata: { escrow_id: escrowId, task_id: taskId, worker_id: workerId },
  };

  const exactLedger = {
    id: 'revenue-transfer-failed-exact',
    event_type: 'failed_transfer',
    user_id: workerId,
    task_id: taskId,
    amount_cents: -8_300,
    currency: 'usd',
    gross_amount_cents: 10_000,
    platform_fee_cents: 1_500,
    net_amount_cents: 8_300,
    fee_basis_points: 1_500,
    escrow_id: escrowId,
    stripe_event_id: stripeEventId,
    stripe_payment_intent_id: 'pi-transfer-failed-exact',
    stripe_transfer_id: transferId,
    metadata: {
      event: 'transfer_failed_provider_reconciliation',
      escrow_state_before: 'RELEASED',
      escrow_state_after: 'LOCKED_DISPUTE',
      payout_recipient_user_id: workerId,
      destination_account_id: destination,
      transfer_amount_cents: 8_300,
      requires_admin_intervention: true,
    },
  };

  function setupFailedTransfer(secondLedgerRows: unknown[]) {
    setupClaim('transfer.failed', transfer, stripeEventId);
    setupTransferWitness({
      transferId,
      escrowId,
      taskId,
      payoutRecipientUserId: workerId,
      destinationAccountId: destination,
      amountCents: 8_300,
    });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: escrowId,
          task_id: taskId,
          state: 'RELEASED',
          version: 4,
          amount: 10_000,
          platform_fee_cents: 1_500,
          stripe_payment_intent_id: 'pi-transfer-failed-exact',
          stripe_transfer_id: transferId,
          provider_transfer_status: 'paid',
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ worker_id: workerId, payout_recipient_user_id: null }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          stripe_connect_id: destination,
          payouts_enabled: true,
          account_status: 'ACTIVE',
          binding_current: true,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'provider-failure-event' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ set_config: escrowId }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: escrowId, state: 'LOCKED_DISPUTE', version: 5 }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: secondLedgerRows, rowCount: secondLedgerRows.length } as never);
  }

  it('releases the Stripe inbox claim when RevenueService returns success:false without an exact readback', async () => {
    setupFailedTransfer([]);
    vi.mocked(RevenueService.logEvent).mockResolvedValueOnce({
      success: false,
      error: { code: 'REVENUE_LOG_FAILED', message: 'ledger unavailable' },
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ stripe_event_id: stripeEventId }], rowCount: 1 } as never);

    await expect(processPaymentJob(makeJob('transfer.failed', stripeEventId)))
      .rejects.toThrow(/Failed-transfer revenue write failed: ledger unavailable/);

    expect(RevenueService.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'failed_transfer',
      taskId,
      amountCents: -8_300,
      grossAmountCents: 10_000,
      platformFeeCents: 1_500,
      netAmountCents: 8_300,
      stripeTransferId: transferId,
    }));
    const release = mockQuery.mock.calls.at(-1);
    expect(String(release?.[0])).toContain('claimed_at = NULL');
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('rejects an inexact failed-transfer ledger readback even after a nominal service success', async () => {
    setupFailedTransfer([{ ...exactLedger, amount_cents: -10_000 }]);
    mockQuery.mockResolvedValueOnce({ rows: [{ stripe_event_id: stripeEventId }], rowCount: 1 } as never);

    await expect(processPaymentJob(makeJob('transfer.failed', stripeEventId)))
      .rejects.toThrow(/revenue witness is missing or inexact/);

    expect(writeToOutbox).not.toHaveBeenCalled();
    expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain('claimed_at = NULL');
  });

  it('persists an immutable revenue witness and acknowledges success only after exact readback', async () => {
    setupFailedTransfer([exactLedger]);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'failed-transfer-revenue-event' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_event_id: stripeEventId }], rowCount: 1 } as never);

    await processPaymentJob(makeJob('transfer.failed', stripeEventId));

    const witnessCall = mockQuery.mock.calls.find(([, params]) =>
      String((params as unknown[] | undefined)?.[3] ?? '')
        .startsWith('transfer-failed-revenue-witness-v1:'));
    expect(witnessCall).toBeDefined();
    const metadata = JSON.parse(String((witnessCall?.[1] as unknown[])[2]));
    expect(metadata).toEqual({
      event_type: 'transfer_failed_revenue_witness_v1',
      stripe_event_id: stripeEventId,
      escrow_id: escrowId,
      task_id: taskId,
      transfer_id: transferId,
      revenue_ledger_id: exactLedger.id,
      failed_transfer_amount_cents: -8_300,
      currency: 'usd',
    });
    expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'escrow.transfer_failed',
      aggregateId: escrowId,
    }));
    expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("result = 'success'");
  });
});

describe('Stripe payment inbox hard-crash recovery path', () => {
  it('persists a recovery outbox row, preserves an exact HMAC, and rotates the stale payment claim', async () => {
    const stripeEventId = 'evt_payment_inbox_crash';
    const claimedAt = new Date('2026-08-25T12:00:00.000Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{
        stripe_event_id:stripeEventId,
        type:'payment_intent.payment_failed',
        claimed_at:claimedAt,
      }],
      rowCount:1,
    } as never);

    await recoverStuckStripeEvents({ data:{ timeoutMinutes:10,limit:1 } } as Job);

    const recoveryInput = vi.mocked(writeToOutbox).mock.calls.at(-1)?.[0];
    expect(recoveryInput).toEqual({
      eventType:'stripe.event_received',
      aggregateType:'stripe_event',
      aggregateId:stripeEventId,
      eventVersion:1,
      idempotencyKey:
        `stripe.event_received.recovery:${stripeEventId}:${claimedAt.getTime()}`,
      payload:{ stripeEventId,type:'payment_intent.payment_failed' },
      queueName:'critical_payments',
    });

    const actualQueues = await vi.importActual<typeof import('../../src/jobs/queues.js')>(
      '../../src/jobs/queues.js',
    );
    const recoveryKey = String(recoveryInput!.idempotencyKey);
    const unsigned = { ...recoveryInput!.payload, _outbox_key: recoveryKey };
    const signature = actualQueues.signJobPayload(unsigned);
    expect(actualQueues.verifyJobSignature(unsigned,signature)).toBe(true);
    vi.mocked(verifyJobSignature).mockImplementation((candidate,candidateSignature) =>
      actualQueues.verifyJobSignature(candidate,candidateSignature));

    mockQuery.mockResolvedValueOnce({
      rows:[{
        stripe_event_id:stripeEventId,
        type:'payment_intent.payment_failed',
        payload_json:{ data:{ object:{ id:'pi_crash_recovery' } } },
      }],
      rowCount:1,
    } as never);
    // The negative payment fact has no canonical escrow to mutate.
    mockQuery.mockResolvedValueOnce({ rows:[],rowCount:0 } as never);
    mockQuery.mockResolvedValueOnce({ rows:[],rowCount:1 } as never);

    const signedJob = {
      id:outboxTransportJobId(recoveryKey),
      data:{
        aggregate_type:'stripe_event',
        aggregate_id:stripeEventId,
        event_version:1,
        payload:{ ...unsigned,_sig:signature },
      },
    } as Job;
    await processStripeEventDispatchJob(signedJob);

    expect(verifyJobSignature).toHaveBeenCalledWith(unsigned,signature);
    const claimCall = mockQuery.mock.calls.find(([statement]) =>
      String(statement).includes("claimed_at < NOW() - INTERVAL '1 minute' * $3"));
    const claimToken = (claimCall?.[1] as unknown[] | undefined)?.[1];
    expect(claimToken).toEqual(expect.stringMatching(/^STRIPE_EVENT_CLAIM:/));
    const terminalCall = mockQuery.mock.calls.find(([statement]) =>
      String(statement).includes("SET result = 'success'"));
    expect((terminalCall?.[1] as unknown[] | undefined)?.[1]).toBe(claimToken);
    expect(String(terminalCall?.[0])).toContain('processed_at IS NULL');
    expect(markStripeEventOutboxesProcessed).toHaveBeenCalledWith({
      idempotencyKey: recoveryKey,
      stripeEventId,
    });
  });
});
