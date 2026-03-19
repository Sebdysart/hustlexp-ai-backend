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

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
import { signJobPayload } from '../../src/jobs/queues.js';
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
 *   query #3       — TT-03 fresh re-read: SELECT stripe_transfer_id FROM escrows
 *   transaction #2 — version-checked UPDATE escrows (store transfer_id)
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
    // Second transaction: version-checked UPDATE. Execute the UPDATE and return.
    const trxQuery = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] });
    return fn(trxQuery);
  });

  // After both transactions: auxiliary db.query calls (in execution order)
  dbQuery
    // SELECT worker_id FROM tasks
    .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
    // SELECT stripe_connect_id FROM users
    .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never)
    // TT-03: fresh re-read — no transfer yet on this attempt
    .mockResolvedValueOnce({ rows: [{ stripe_transfer_id: null }], rowCount: 1 } as never);
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
    const trxQuery = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] });
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
    expect(transferCall.amount).toBe(8_500); // 10000 - 15% fee = 8500
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

    // 15% of 3333 = 499.95 → round to 500; net = 3333 - 500 = 2833
    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    expect(transferCall.amount).toBe(2_833);
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
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      callOrder.push('transaction');
      const trxQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [makeEscrowRow()], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] });
      return fn(trxQuery);
    });
    vi.mocked(StripeService.createTransfer).mockImplementation(async (..._args) => {
      callOrder.push('stripe');
      return { success: true, data: { transferId: 'tr_txn_order' } } as never;
    });
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never)
      // TT-03: fresh re-read — no transfer yet
      .mockResolvedValueOnce({ rows: [{ stripe_transfer_id: null }], rowCount: 1 } as never);

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
      const trxQuery = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] });
      return fn(trxQuery);
    });

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never)
      // TT-03: fresh re-read — no transfer yet
      .mockResolvedValueOnce({ rows: [{ stripe_transfer_id: null }], rowCount: 1 } as never);

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
      // TT-03: fresh re-read (SELECT stripe_transfer_id FROM escrows) returns null so Stripe call proceeds
      if (sql.includes('stripe_transfer_id')) return { rows: [{ stripe_transfer_id: null }], rowCount: 1 } as never;
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
      // Second transaction: capture the UPDATE SQL
      const trxQuery = vi.fn().mockImplementation(async (sql: string) => {
        updateSql = sql;
        return { rowCount: 1, rows: [] };
      });
      return fn(trxQuery);
    });

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never)
      // TT-03: fresh re-read — no transfer yet
      .mockResolvedValueOnce({ rows: [{ stripe_transfer_id: null }], rowCount: 1 } as never);

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
      return fn(vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] }));
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
