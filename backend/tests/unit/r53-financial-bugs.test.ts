/**
 * R53 Financial Bug Tests
 *
 * F53-6: Tip platform cut must be 0% — verified via RevenueService.logEvent call args
 * F53-7: Self-insurance pool funding path in handlePartialRefundRequest must be reachable
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for F53-6 (TippingService.confirmTip platform cut)
// ---------------------------------------------------------------------------

const { mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
}));

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn(async (fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base,
    escrowLogger: base,
    taskLogger: base,
    aiLogger: base,
    stripeLogger: base,
    authLogger: base,
    workerLogger: base,
    dbLogger: base,
  };
});

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_fake123', platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      paymentIntents = {
        create: vi.fn(),
        retrieve: mockPaymentIntentsRetrieve,
        cancel: vi.fn(),
      };
    },
  };
});

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } }) },
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: { createTransfer: vi.fn(), createRefund: vi.fn() },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: {
    recordContribution: vi.fn().mockResolvedValue({ success: true }),
    fileClaim: vi.fn(),
    getPoolStatus: vi.fn(),
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn(),
}));

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: { updateStatus: vi.fn(), advanceProgress: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { TippingService } from '../../src/services/TippingService';
import { RevenueService } from '../../src/services/RevenueService.js';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';
import { StripeService } from '../../src/services/StripeService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);
const mockRevenueService = vi.mocked(RevenueService);
const mockSelfInsurancePool = vi.mocked(SelfInsurancePoolService);
const mockStripeService = vi.mocked(StripeService);

beforeEach(() => {
  vi.resetAllMocks();
  // Re-bind default implementations after resetAllMocks
  mockDb.transaction.mockImplementation(async (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query));
  mockRevenueService.logEvent.mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } } as any);
  mockSelfInsurancePool.recordContribution.mockResolvedValue({ success: true } as any);
});

// ---------------------------------------------------------------------------
// F53-6: Tip platform cut must be 0%
// ---------------------------------------------------------------------------

describe('F53-6: TippingService.confirmTip — platform cut must be 0%', () => {
  it('logs tip_received with platformFeeCents=0 (platform takes no cut on tips)', async () => {
    // confirmTip path:
    // 1. stripe.paymentIntents.retrieve → succeeded
    // 2. db.query: SELECT amount_cents, task_id FROM tips
    // 3. db.query: UPDATE tips SET status='completed'
    // 4. RevenueService.logEvent (mocked — no db.query)
    // 5. db.query: INSERT notification

    mockPaymentIntentsRetrieve.mockResolvedValueOnce({
      status: 'succeeded',
      amount: 500,
      metadata: { type: 'tip', task_id: 'task-tip-1', worker_id: 'worker-1', poster_id: 'poster-1' },
    });

    const tipRow = {
      id: 'tip-1',
      task_id: 'task-tip-1',
      poster_id: 'poster-1',
      worker_id: 'worker-1',
      amount_cents: 500,
      stripe_payment_intent_id: 'pi_tip_123',
      status: 'completed',
      completed_at: new Date(),
      created_at: new Date(),
    };

    mockDb.query
      // SELECT amount_cents, task_id (TT-02 + Fix 4 cross-check)
      .mockResolvedValueOnce({ rows: [{ amount_cents: 500, task_id: 'task-tip-1' }], rowCount: 1 } as never)
      // UPDATE tips
      .mockResolvedValueOnce({ rows: [tipRow], rowCount: 1 } as never)
      // INSERT notification (best-effort, may or may not run)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await TippingService.confirmTip('tip-1', 'pi_tip_123');

    expect(result.success).toBe(true);

    // Verify RevenueService.logEvent was called with platformFeeCents=0
    expect(mockRevenueService.logEvent).toHaveBeenCalledOnce();
    const logEventCall = mockRevenueService.logEvent.mock.calls[0][0];
    expect(logEventCall.eventType).toBe('tip_received');
    expect(logEventCall.platformFeeCents).toBe(0);
    expect(logEventCall.amountCents).toBe(0); // No platform revenue — 100% to worker
    expect(logEventCall.grossAmountCents).toBe(500);
    expect(logEventCall.netAmountCents).toBe(500);
  });

  it('platform cut percentage is 0% — grossAmountCents equals netAmountCents for tips (F53-6)', async () => {
    const tipAmountCents = 1500; // $15 tip

    mockPaymentIntentsRetrieve.mockResolvedValueOnce({
      status: 'succeeded',
      amount: tipAmountCents,
      metadata: { type: 'tip', task_id: 'task-2', worker_id: 'worker-2', poster_id: 'poster-2' },
    });

    const tipRow = {
      id: 'tip-2',
      task_id: 'task-2',
      poster_id: 'poster-2',
      worker_id: 'worker-2',
      amount_cents: tipAmountCents,
      stripe_payment_intent_id: 'pi_tip_456',
      status: 'completed',
      completed_at: new Date(),
      created_at: new Date(),
    };

    mockDb.query
      .mockResolvedValueOnce({ rows: [{ amount_cents: tipAmountCents, task_id: 'task-2' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [tipRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await TippingService.confirmTip('tip-2', 'pi_tip_456');

    const logEventCall = mockRevenueService.logEvent.mock.calls[0][0];
    // Platform cut = 0%: gross === net, platform fee = 0
    expect(logEventCall.grossAmountCents).toBe(tipAmountCents);
    expect(logEventCall.netAmountCents).toBe(tipAmountCents);
    expect(logEventCall.platformFeeCents).toBe(0);
    // Platform revenue from tips = 0 (not a revenue source for the platform)
    expect(logEventCall.amountCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F53-7: Self-insurance pool funding path in handlePartialRefundRequest
// ---------------------------------------------------------------------------

function makeJob(name: string, payload: object): Job<{ payload: object }> {
  return { name, data: { payload } } as unknown as Job<{ payload: object }>;
}

function makeSignedPayload(fields: Record<string, unknown>): Record<string, unknown> {
  const sig = signJobPayload(fields);
  return { ...fields, _sig: sig };
}

const ESCROW_ID = '00000000-0000-0000-0000-000000000099';
const TASK_ID = '10000000-0000-0000-0000-000000000099';
const WORKER_ID = 'worker-f53-7';
const STRIPE_CONNECT_ID = 'acct_f53_7';
const ESCROW_VERSION = 1;

function makeEscrowRow(overrides: Partial<{
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  amount: number;
  state: string;
}> = {}) {
  return {
    id: ESCROW_ID,
    state: overrides.state ?? 'LOCKED_DISPUTE',
    version: ESCROW_VERSION,
    amount: overrides.amount ?? 10_000,
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: overrides.stripe_transfer_id ?? null,
    stripe_refund_id: overrides.stripe_refund_id ?? null,
  };
}

describe('F53-7: handlePartialRefundRequest — self-insurance pool funding path reachable', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRevenueService.logEvent.mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } } as any);
    mockSelfInsurancePool.recordContribution.mockResolvedValue({ success: true } as any);
    mockStripeService.createRefund.mockResolvedValue({ success: true, data: { refundId: 'ref_test' } } as any);
    mockStripeService.createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_test' } } as any);
    mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb.query));
  });

  it('calls SelfInsurancePoolService.recordContribution when releaseAmount > 0 (F53-7)', async () => {
    // This exercises the pool funding path in handlePartialRefundRequest.
    // escrow.amount=10000, refundAmount=4000, releaseAmount=6000
    // Platform fee 15% on 6000 = 900, net = 5100, insurance 2% = 102
    // splitInsuranceContributionCents = round(5100 * 0.02) = 102

    mockStripeService.createRefund.mockResolvedValue({ success: true, data: { refundId: 'ref_f53_7' } } as any);
    mockStripeService.createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_f53_7' } } as any);

    const dbTransaction = vi.mocked(db.transaction);
    let txCallIndex = 0;

    dbTransaction.mockImplementation(async (fn: any) => {
      const callIndex = txCallIndex++;
      if (callIndex === 0) {
        // Critical-section lock: return LOCKED_DISPUTE escrow
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [makeEscrowRow({ amount: 10_000 })],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      if (callIndex === 1) {
        // FOR UPDATE NOWAIT on escrows (inside partial refund, releaseAmount path)
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [{ stripe_transfer_id: null }],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      // T-final: terminalization transaction (SELECT FOR UPDATE NOWAIT + UPDATE)
      const trxQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, state: 'LOCKED_DISPUTE' }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID, state: 'REFUND_PARTIAL' }] });
      return fn(trxQuery);
    });

    mockDb.query
      // SELECT worker_id, poster_id FROM tasks
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID, poster_id: 'poster-f53' }], rowCount: 1 } as never)
      // Idempotency check: SELECT metadata FROM escrow_events (partial_refund_pending)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // INSERT escrow_events checkpoint (after refund)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // SELECT stripe_connect_id FROM users (for transfer)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);

    const job = makeJob('escrow.partial_refund_requested',
      makeSignedPayload({
        escrow_id: ESCROW_ID,
        task_id: TASK_ID,
        reason: 'dispute: split 40/60',
        refund_amount: 4_000,
        release_amount: 6_000,
      }),
    );

    await processEscrowActionJob(job as never);

    // The pool funding path MUST have been called
    expect(mockSelfInsurancePool.recordContribution).toHaveBeenCalledOnce();

    // Verify the contribution amount: net = round(6000 * 0.85) = 5100, insurance = round(5100 * 0.02) = 102
    const contributionCall = mockSelfInsurancePool.recordContribution.mock.calls[0];
    expect(contributionCall[0]).toBe(TASK_ID);   // taskId
    expect(contributionCall[1]).toBe(WORKER_ID); // hustlerId
    expect(contributionCall[2]).toBe(102);        // splitInsuranceContributionCents
  });

  it('does NOT call recordContribution when releaseAmount is 0 (refund-only SPLIT, F53-7)', async () => {
    // When releaseAmount=0, there is no worker transfer and no pool contribution
    mockStripeService.createRefund.mockResolvedValue({ success: true, data: { refundId: 'ref_only' } } as any);

    const dbTransaction = vi.mocked(db.transaction);
    let txCallIndex = 0;

    dbTransaction.mockImplementation(async (fn: any) => {
      const callIndex = txCallIndex++;
      if (callIndex === 0) {
        // Critical-section lock
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [makeEscrowRow({ amount: 10_000 })],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      // Terminalization transaction
      const trxQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, state: 'LOCKED_DISPUTE' }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID, state: 'REFUND_PARTIAL' }] });
      return fn(trxQuery);
    });

    mockDb.query
      // SELECT worker_id, poster_id FROM tasks
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID, poster_id: 'poster-f53' }], rowCount: 1 } as never)
      // Idempotency check: escrow_events
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // INSERT escrow_events checkpoint
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const job = makeJob('escrow.partial_refund_requested',
      makeSignedPayload({
        escrow_id: ESCROW_ID,
        task_id: TASK_ID,
        reason: 'full refund to poster',
        refund_amount: 10_000,
        release_amount: 0,
      }),
    );

    await processEscrowActionJob(job as never);

    // No worker transfer → no pool contribution
    expect(mockSelfInsurancePool.recordContribution).not.toHaveBeenCalled();
  });

  it('pool funding path does not block payout when recordContribution throws (F53-7)', async () => {
    // recordContribution failure is non-fatal — the partial refund should still complete
    mockSelfInsurancePool.recordContribution.mockRejectedValueOnce(new Error('pool DB error'));

    mockStripeService.createRefund.mockResolvedValue({ success: true, data: { refundId: 'ref_nonfatal' } } as any);
    mockStripeService.createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_nonfatal' } } as any);

    const dbTransaction = vi.mocked(db.transaction);
    let txCallIndex = 0;

    dbTransaction.mockImplementation(async (fn: any) => {
      const callIndex = txCallIndex++;
      if (callIndex === 0) {
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [makeEscrowRow({ amount: 10_000 })],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      if (callIndex === 1) {
        // FOR UPDATE NOWAIT on escrows
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [{ stripe_transfer_id: null }],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      // Terminalization
      const trxQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, state: 'LOCKED_DISPUTE' }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID, state: 'REFUND_PARTIAL' }] });
      return fn(trxQuery);
    });

    mockDb.query
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID, poster_id: 'poster-f53' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);

    const job = makeJob('escrow.partial_refund_requested',
      makeSignedPayload({
        escrow_id: ESCROW_ID,
        task_id: TASK_ID,
        reason: 'split with pool failure',
        refund_amount: 4_000,
        release_amount: 6_000,
      }),
    );

    // Should NOT throw — pool failure is non-fatal (try-catch in service)
    await expect(processEscrowActionJob(job as never)).resolves.toBeUndefined();

    // recordContribution was attempted (the path is reachable)
    expect(mockSelfInsurancePool.recordContribution).toHaveBeenCalledOnce();
  });
});
