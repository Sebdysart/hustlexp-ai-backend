/**
 * escrow-action-worker.test.ts
 *
 * Unit tests for processEscrowActionJob.
 *
 * Key invariants verified:
 *  1. Platform fee is deducted before transferring to worker (P0 revenue bug fix).
 *  2. The FOR UPDATE SELECT runs inside db.transaction() (critical-section lock fix).
 *  3. Stripe calls happen OUTSIDE the transaction (cannot be rolled back).
 *  4. The version-checked UPDATE runs inside a second db.transaction() call.
 *  5. Idempotency paths (stripe_transfer_id / stripe_refund_id already set) skip Stripe.
 *  6. Invalid state (not LOCKED_DISPUTE) is rejected inside the transaction.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that trigger the module
// ---------------------------------------------------------------------------

// db mock: expose both `query` and `transaction` so we can assert on both.
// transaction() default impl just calls the callback with db.query, letting
// individual tests override it to simulate the real two-connection behaviour.
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  const transactionFn = vi.fn(async (fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn));
  return {
    db: {
      query: queryFn,
      transaction: transactionFn,
    },
  };
});

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: { createTransfer: vi.fn(), createRefund: vi.fn() },
}));

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

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: { updateStatus: vi.fn(), advanceProgress: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn(),
}));

// RevenueService is mocked so logEvent never issues a real db.query call.
// This prevents mockResolvedValueOnce queue leakage between tests (vi.clearAllMocks
// clears call counts but NOT queued once-values — mocking the module entirely
// isolates db.query from revenue ledger writes).
vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } }) },
}));

// F-12 FIX: handleReleaseRequest now calls SelfInsurancePoolService.recordContribution.
// Mock it to prevent db.transaction from being called a 3rd time (which would overwrite
// the T2 updateSql capture in transaction-structure tests).
vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: {
    recordContribution: vi.fn().mockResolvedValue(undefined),
    fileClaim: vi.fn(),
    getPoolStatus: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import { notifyAdmins } from '../../src/services/AdminNotificationHelper.js';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeJob(name: string, payload: object): Job<{ payload: object }> {
  return { name, data: { payload } } as unknown as Job<{ payload: object }>;
}

function makeSignedPayload(fields: Record<string, unknown>): Record<string, unknown> {
  const sig = signJobPayload(fields);
  return { ...fields, _sig: sig };
}

const ESCROW_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '10000000-0000-0000-0000-000000000001';
const WORKER_ID = 'worker-001';
const STRIPE_CONNECT_ID = 'acct_test_123';
const ESCROW_VERSION = 1;

/** Standard locked-dispute escrow row returned by the FOR UPDATE SELECT */
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

/**
 * Wire up db.transaction and db.query mocks for a release request.
 *
 * Call sequence expected by processEscrowActionJob + handleReleaseRequest:
 *   transaction #1 — critical-section lock (FOR UPDATE SELECT inside trx)
 *   query #1       — SELECT worker_id FROM tasks
 *   query #2       — SELECT stripe_connect_id FROM users
 *   [Stripe createTransfer call]
 *   transaction #2 — T2: SELECT FOR UPDATE NOWAIT (trxQuery call 1) + UPDATE (trxQuery call 2)
 *
 * Note: RevenueService.logEvent is module-mocked (vi.mock) so it does NOT
 * issue an additional db.query call — no query #3 needed here.
 */
function setupReleaseMocks(escrowAmountCents = 10_000, escrowOverrides = {}) {
  const dbQuery = vi.mocked(db.query);
  const dbTransaction = vi.mocked(db.transaction);

  let txCallIndex = 0;

  dbTransaction.mockImplementation(async (fn) => {
    const callIndex = txCallIndex++;
    if (callIndex === 0) {
      // First transaction: critical-section FOR UPDATE. Return the locked escrow row.
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ amount: escrowAmountCents, ...escrowOverrides })],
        rowCount: 1,
      });
      return fn(trxQuery);
    }
    // Second transaction (T2): SELECT FOR UPDATE NOWAIT then version-checked UPDATE.
    // trxQuery is called TWICE inside T2: once for the lock re-read, once for the UPDATE.
    const trxQuery = vi.fn()
      // T2 call 1: SELECT FOR UPDATE NOWAIT — returns locked row with no transfer yet
      .mockResolvedValueOnce({
        rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, stripe_transfer_id: null }],
        rowCount: 1,
      })
      // T2 call 2: UPDATE escrows SET stripe_transfer_id ... RETURNING id
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] });
    return fn(trxQuery);
  });

  // After both transactions: auxiliary db.query calls (in execution order)
  dbQuery
    // SELECT worker_id FROM tasks
    .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
    // SELECT stripe_connect_id FROM users
    .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);
}

/**
 * Wire up db.transaction and db.query mocks for a refund request.
 *
 * Call sequence:
 *   transaction #1 — critical-section lock (FOR UPDATE SELECT)
 *   transaction #2 — version-checked UPDATE escrows (store refund_id)
 */
function setupRefundMocks(overrides = {}) {
  const dbTransaction = vi.mocked(db.transaction);
  let txCallIndex = 0;

  dbTransaction.mockImplementation(async (fn) => {
    const callIndex = txCallIndex++;
    if (callIndex === 0) {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow(overrides)],
        rowCount: 1,
      });
      return fn(trxQuery);
    }
    // Second transaction (T2): BUG 2 FIX added SELECT FOR UPDATE NOWAIT before the UPDATE.
    // The trxQuery is called twice:
    //   1st call: SELECT FOR UPDATE NOWAIT → returns the locked escrow row (for version re-read)
    //   2nd call: UPDATE ... RETURNING id → returns the updated row
    const trxQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: 1, stripe_refund_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] });
    return fn(trxQuery);
  });
}

// ---------------------------------------------------------------------------
// Tests: platform fee deduction
// ---------------------------------------------------------------------------

describe('escrow-action-worker — platform fee deduction (P0 revenue bug)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockResolvedValue({
      success: true,
      data: { transferId: 'tr_test_abc' },
    } as never);
  });

  it('deducts 15% platform fee before transferring to worker on a $100 escrow', async () => {
    const escrowAmountCents = 10_000; // $100.00
    setupReleaseMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'dispute resolved in worker favour' }),
    );

    await processEscrowActionJob(job as never);

    // Worker should receive 85% = 8500 cents, NOT the full 10000 cents
    expect(StripeService.createTransfer).toHaveBeenCalledOnce();
    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    // AUDIT FIX H3: insurance basis unified on GROSS (F54-2, matches
    // EscrowService.release): 10000 − 1500 fee − round(10000×2%)=200 → 8300.
    // (Old NET basis gave 8330 — the two release paths paid different amounts.)
    expect(transferCall.amount).toBe(8_300);
  });

  it('does NOT transfer the full escrow amount (confirms the bug is fixed)', async () => {
    const escrowAmountCents = 10_000;
    setupReleaseMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'dispute resolved' }),
    );

    await processEscrowActionJob(job as never);

    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    // Must NOT be the full amount (that was the bug)
    expect(transferCall.amount).not.toBe(10_000);
  });

  it('rounds platform fee correctly for non-round amounts ($33.33 escrow)', async () => {
    const escrowAmountCents = 3_333; // $33.33
    setupReleaseMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'dispute resolved' }),
    );

    await processEscrowActionJob(job as never);

    // AUDIT FIX H3 (gross-basis insurance): 15% of 3333 = 499.95 → round 500;
    // insurance = round(3333×2%) = round(66.66) = 67; transfer = 3333−500−67 = 2766.
    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    expect(transferCall.amount).toBe(2_766);
  });

  it('skips transfer when idempotent replay (stripe_transfer_id already set)', async () => {
    const dbTransaction = vi.mocked(db.transaction);

    // Only one transaction needed: the critical-section lock returns an escrow
    // that already has a transfer_id — the handler short-circuits immediately.
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ stripe_transfer_id: 'tr_already_exists' })],
        rowCount: 1,
      });
      return fn(trxQuery);
    });

    const job = makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'replay' }),
    );

    await processEscrowActionJob(job as never);

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: transaction wrapping (critical-section lock fix)
// ---------------------------------------------------------------------------

describe('escrow-action-worker — FOR UPDATE runs inside db.transaction()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockResolvedValue({
      success: true,
      data: { transferId: 'tr_test_txn' },
    } as never);
  });

  it('calls db.transaction() at least once before any Stripe call on release_requested', async () => {
    setupReleaseMocks();

    const callOrder: string[] = [];
    let innerTxCallIndex = 0;
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      callOrder.push('transaction');
      const callIndex = innerTxCallIndex++;
      if (callIndex === 0) {
        // T1: critical-section lock
        const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [makeEscrowRow()], rowCount: 1 });
        return fn(trxQuery);
      }
      // T2: SELECT FOR UPDATE NOWAIT + UPDATE
      const trxQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, stripe_transfer_id: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] });
      return fn(trxQuery);
    });
    vi.mocked(StripeService.createTransfer).mockImplementation(async (..._args) => {
      callOrder.push('stripe');
      return { success: true, data: { transferId: 'tr_txn_order' } } as never;
    });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);

    await processEscrowActionJob(makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'test order' }),
    ) as never);

    // The first db.transaction() must appear before the Stripe call
    expect(callOrder[0]).toBe('transaction');
    const stripeIdx = callOrder.indexOf('stripe');
    const firstTxnIdx = callOrder.indexOf('transaction');
    expect(firstTxnIdx).toBeLessThan(stripeIdx);
  });

  it('passes the FOR UPDATE SELECT through the trx callback (not bare db.query)', async () => {
    // Capture what trxQuery is called with inside the first transaction
    let forUpdateSql = '';
    const dbTransaction = vi.mocked(db.transaction);

    let txCallIndex = 0;
    dbTransaction.mockImplementation(async (fn) => {
      const callIndex = txCallIndex++;
      if (callIndex === 0) {
        const trxQuery = vi.fn().mockImplementation(async (sql: string) => {
          forUpdateSql = sql;
          return { rows: [makeEscrowRow()], rowCount: 1 };
        });
        return fn(trxQuery);
      }
      // T2: SELECT FOR UPDATE NOWAIT + UPDATE
      const trxQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, stripe_transfer_id: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] });
      return fn(trxQuery);
    });

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);

    await processEscrowActionJob(makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'trx check' }),
    ) as never);

    expect(forUpdateSql).toMatch(/FOR UPDATE/i);
  });

  it('does NOT call bare db.query for the FOR UPDATE SELECT (lock must use trx)', async () => {
    setupReleaseMocks();

    // Track which SQL statements go through db.query vs db.transaction
    const bareQuerySqls: string[] = [];
    vi.mocked(db.query).mockImplementation(async (sql: string, ...args: unknown[]) => {
      bareQuerySqls.push(sql);
      // Provide data for the auxiliary reads that legitimately use db.query
      if (sql.includes('worker_id')) return { rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never;
      if (sql.includes('stripe_connect_id')) return { rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never;
      return { rows: [], rowCount: 0 } as never;
    });

    await processEscrowActionJob(makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'bare query check' }),
    ) as never);

    // None of the bare db.query calls should contain FOR UPDATE
    for (const sql of bareQuerySqls) {
      expect(sql).not.toMatch(/FOR UPDATE/i);
    }
  });

  it('version-checked UPDATE runs inside a second db.transaction() call', async () => {
    let updateSql = '';
    let transactionCount = 0;
    const dbTransaction = vi.mocked(db.transaction);

    dbTransaction.mockImplementation(async (fn) => {
      const callIndex = transactionCount++;
      if (callIndex === 0) {
        const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [makeEscrowRow()], rowCount: 1 });
        return fn(trxQuery);
      }
      // Second transaction (T2): trx is called twice — SELECT FOR UPDATE NOWAIT then UPDATE.
      // Capture the UPDATE SQL (second call inside T2).
      let t2CallIndex = 0;
      const trxQuery = vi.fn().mockImplementation(async (sql: string) => {
        const t2Call = t2CallIndex++;
        if (t2Call === 0) {
          // T2 call 1: SELECT FOR UPDATE NOWAIT
          return { rows: [{ id: ESCROW_ID, version: ESCROW_VERSION, stripe_transfer_id: null }], rowCount: 1 };
        }
        // T2 call 2: UPDATE — capture the SQL
        updateSql = sql;
        return { rowCount: 1, rows: [{ id: ESCROW_ID }] };
      });
      return fn(trxQuery);
    });

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);

    await processEscrowActionJob(makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'update txn check' }),
    ) as never);

    // There must have been two transaction calls
    expect(transactionCount).toBeGreaterThanOrEqual(2);
    // The second transaction must have run an UPDATE on escrows
    expect(updateSql).toMatch(/UPDATE escrows/i);
    expect(updateSql).toMatch(/stripe_transfer_id/i);
  });

  it('rejects non-LOCKED_DISPUTE escrow state inside the transaction (no Stripe call)', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ state: 'FUNDED' })],
        rowCount: 1,
      });
      return fn(trxQuery);
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested',
        makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'bad state' }),
      ) as never)
    ).rejects.toThrow('LOCKED_DISPUTE');

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects missing escrow inside the transaction (no Stripe call)', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
      return fn(trxQuery);
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested',
        makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'not found' }),
      ) as never)
    ).rejects.toThrow('not found');

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: refund_requested handler
// ---------------------------------------------------------------------------

describe('escrow-action-worker — refund_requested handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createRefund).mockResolvedValue({
      success: true,
      data: { refundId: 'refund_test_abc' },
    } as never);
  });

  it('creates a full refund via Stripe and stores refund_id via second transaction', async () => {
    setupRefundMocks();

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'full refund' }),
    ) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    const refundCall = vi.mocked(StripeService.createRefund).mock.calls[0][0];
    expect(refundCall.amount).toBe(10_000);
    expect(refundCall.paymentIntentId).toBe('pi_test');
  });

  it('skips Stripe call on idempotent replay (stripe_refund_id already set)', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ stripe_refund_id: 'refund_already_exists' })],
        rowCount: 1,
      });
      return fn(trxQuery);
    });

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'replay' }),
    ) as never);

    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });

  it('throws when escrow has no stripe_payment_intent_id', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const row = makeEscrowRow();
      row.stripe_payment_intent_id = null;
      const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      return fn(trxQuery);
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.refund_requested',
        makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'no pi' }),
      ) as never)
    ).rejects.toThrow('stripe_payment_intent_id');
  });

  it('uses refund_amount from job payload when provided (partial refund, BUG H4)', async () => {
    setupRefundMocks();

    // Provide a refund_amount smaller than the full escrow amount (10_000)
    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'partial refund', refund_amount: 4_000 }),
    ) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    const refundCall = vi.mocked(StripeService.createRefund).mock.calls[0][0];
    // Must use the job payload amount, NOT the full escrow amount
    expect(refundCall.amount).toBe(4_000);
    expect(refundCall.amount).not.toBe(10_000);
  });

  it('falls back to full escrow amount when refund_amount is absent (BUG H4 — no regression)', async () => {
    setupRefundMocks();

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'full refund no amount field' }),
    ) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    const refundCall = vi.mocked(StripeService.createRefund).mock.calls[0][0];
    expect(refundCall.amount).toBe(10_000); // full escrow amount
  });

  it('FOR UPDATE runs inside db.transaction() for refund path (not bare db.query)', async () => {
    let forUpdateSql = '';
    const dbTransaction = vi.mocked(db.transaction);
    let txIdx = 0;

    dbTransaction.mockImplementation(async (fn) => {
      const callIdx = txIdx++;
      if (callIdx === 0) {
        const trxQuery = vi.fn().mockImplementation(async (sql: string) => {
          forUpdateSql = sql;
          return { rows: [makeEscrowRow()], rowCount: 1 };
        });
        return fn(trxQuery);
      }
      // T2 now has two calls: SELECT FOR UPDATE NOWAIT + UPDATE RETURNING id (BUG 2 FIX)
      return fn(vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, version: 1, stripe_refund_id: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] }));
    });

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'trx check refund' }),
    ) as never);

    expect(forUpdateSql).toMatch(/FOR UPDATE/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: schema & signature validation
// ---------------------------------------------------------------------------

describe('escrow-action-worker — input validation', () => {
  it('rejects malformed payload (missing escrow_id)', async () => {
    const job = makeJob('escrow.release_requested', { task_id: TASK_ID, reason: 'no escrow_id', _sig: 'a'.repeat(64) });
    await expect(processEscrowActionJob(job as never)).rejects.toThrow('JOB_SCHEMA_INVALID');
  });

  it('rejects tampered signature', async () => {
    const payload = makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'sig test' });
    payload['_sig'] = 'b'.repeat(64); // wrong sig
    const job = makeJob('escrow.release_requested', payload);
    await expect(processEscrowActionJob(job as never)).rejects.toThrow('JOB_SIGNATURE_INVALID');
  });

  it('rejects unknown event type after successful lock', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [makeEscrowRow()], rowCount: 1 });
      return fn(trxQuery);
    });

    const job = makeJob('escrow.unknown_action',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'unknown event' }),
    );
    await expect(processEscrowActionJob(job as never)).rejects.toThrow('Unknown escrow action event type');
  });
});

// ---------------------------------------------------------------------------
// INV-11 safety net: a failed Stripe transfer on the dispute-release path must
// NEVER advance the escrow. EscrowService.release() does not call Stripe inline;
// the worker→Stripe transfer happens HERE, and the escrow only gains a
// stripe_transfer_id (T2) AFTER a successful transfer. These tests prove that a
// Stripe failure leaves the escrow in LOCKED_DISPUTE with no transfer_id stored.
// ---------------------------------------------------------------------------
describe('escrow-action-worker — release path: failed Stripe transfer must not advance escrow (INV-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Wire mocks up to (but not past) the Stripe createTransfer call:
  //   transaction #1 — critical-section FOR UPDATE lock → returns LOCKED_DISPUTE escrow
  //   query #1       — SELECT worker_id, poster_id FROM tasks
  //   query #2       — SELECT stripe_connect_id FROM users
  // Any transaction AFTER #1 (e.g. lockEscrowForStripeRestriction T, or T2) records
  // its (sql, params) into the returned array so we can assert what did/didn't run.
  function setupReleaseUpToStripe(escrowOverrides = {}) {
    const dbQuery = vi.mocked(db.query);
    const dbTransaction = vi.mocked(db.transaction);
    const txCalls: Array<{ sql: string; params: unknown[] }> = [];
    let txCallIndex = 0;

    dbTransaction.mockImplementation(async (fn) => {
      const idx = txCallIndex++;
      if (idx === 0) {
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [makeEscrowRow(escrowOverrides)],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      // Subsequent transactions (T2 store-transfer, or restriction-lock): record SQL.
      const trxQuery = vi.fn((sql: string, params: unknown[]) => {
        txCalls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      return fn(trxQuery as never);
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID, poster_id: 'poster-001' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never);

    return txCalls;
  }

  const releaseJob = () =>
    makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'worker wins dispute' }),
    );

  it('(a) a non-restriction Stripe transfer failure rethrows (BullMQ retry) and never stores a transfer_id', async () => {
    const txCalls = setupReleaseUpToStripe();
    vi.mocked(StripeService.createTransfer).mockRejectedValueOnce(
      Object.assign(new Error('Stripe 500 internal error'), { code: 'api_error' }),
    );

    await expect(processEscrowActionJob(releaseJob() as never)).rejects.toThrow(/Stripe 500 internal error/);

    expect(StripeService.createTransfer).toHaveBeenCalledTimes(1);
    // Only the critical-section lock transaction ran — T2 (store transfer_id) was never reached,
    // so the escrow keeps state=LOCKED_DISPUTE and stripe_transfer_id=null (not advanced/released).
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1);
    expect(txCalls.some((c) => /stripe_transfer_id\s*=/.test(c.sql))).toBe(false);
  });

  it('(c) a transient network timeout during transfer rethrows for retry and does not store a transfer_id', async () => {
    setupReleaseUpToStripe();
    vi.mocked(StripeService.createTransfer).mockRejectedValueOnce(
      Object.assign(new Error('ETIMEDOUT: connection timed out'), { code: 'ETIMEDOUT' }),
    );

    await expect(processEscrowActionJob(releaseJob() as never)).rejects.toThrow(/ETIMEDOUT/);

    // Transient error is surfaced (rethrown) so BullMQ retries — it is NOT swallowed,
    // and the escrow is not advanced (no T2 transaction).
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1);
  });

  it('(b) a Stripe account restriction (account_closed) locks the escrow for admin review, does NOT rethrow, and stores no transfer_id', async () => {
    const txCalls = setupReleaseUpToStripe();
    vi.mocked(StripeService.createTransfer).mockRejectedValueOnce(
      Object.assign(new Error('The account is closed'), { code: 'account_closed' }),
    );

    // Must NOT rethrow — a non-retryable restriction means BullMQ should not retry forever.
    await expect(processEscrowActionJob(releaseJob() as never)).resolves.toBeUndefined();

    expect(StripeService.createTransfer).toHaveBeenCalledTimes(1);
    // Two transactions: #1 critical-section lock, #2 lockEscrowForStripeRestriction.
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(2);

    // The restriction-lock transaction moved the escrow to LOCKED_DISPUTE (recoverable, NOT released)
    // and recorded the reason for admin reconciliation.
    const lockSql = txCalls.find((c) => /LOCKED_DISPUTE/.test(c.sql));
    expect(lockSql).toBeDefined();
    expect(JSON.stringify(lockSql!.params)).toContain('stripe_account_restricted');

    // Crucially: no transfer_id was ever written, so the escrow was not advanced/released.
    expect(txCalls.some((c) => /stripe_transfer_id\s*=/.test(c.sql))).toBe(false);

    // Admins are paged at CRITICAL priority for manual resolution.
    expect(vi.mocked(notifyAdmins)).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'CRITICAL' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Money conservation + non-negative payout on the release path.
// Proves gross = platformFee + insurance + workerTransfer (no cents lost) and
// that the worker transfer amount is never negative, across round and non-round
// amounts. The transfer amount is captured from the StripeService.createTransfer call.
// ---------------------------------------------------------------------------
describe('escrow-action-worker — release payout math: conservation & non-negativity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockResolvedValue({
      success: true,
      data: { transferId: 'tr_conservation' },
    } as never);
  });

  it.each([10_000, 3_333, 99, 1])(
    'gross=%i cents: platformFee + insurance + workerTransfer === gross, all non-negative',
    async (gross) => {
      setupReleaseMocks(gross);

      await processEscrowActionJob(
        makeJob('escrow.release_requested',
          makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'payout math' }),
        ) as never,
      );

      // Capture the amount actually sent to the worker via Stripe.
      const transferArg = vi.mocked(StripeService.createTransfer).mock.calls[0][0] as { amount: number };
      const workerTransfer = transferArg.amount;

      // Re-derive the source decomposition via the unified convention
      // (AUDIT FIX H3: 15% fee on gross, 2% insurance on GROSS — F54-2 basis,
      // identical to EscrowService.release; transfer is the exact complement).
      const platformFee = Math.round(gross * 0.15);
      const insurance = Math.round(gross * 0.02);
      const expectedTransfer = gross - platformFee - insurance;

      expect(workerTransfer).toBe(expectedTransfer);          // payout amount pinned
      expect(platformFee + insurance + workerTransfer).toBe(gross); // money conserved, no cents lost
      expect(workerTransfer).toBeGreaterThanOrEqual(0);       // never negative
      expect(platformFee).toBeGreaterThanOrEqual(0);
      expect(insurance).toBeGreaterThanOrEqual(0);
    },
  );
});
