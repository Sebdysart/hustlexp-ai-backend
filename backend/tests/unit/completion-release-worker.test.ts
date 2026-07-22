/**
 * completion-release-worker.test.ts
 *
 * TDD (red-first) for the happy-path payout orchestration:
 * task COMPLETED → create Stripe transfer → EscrowService.release (which owns
 * fee/insurance/XP side effects).
 *
 * Invariants under test:
 *  - INV-3/INV-7: release triggered at most once (transfer-id idempotency,
 *    version-checked T2, no Stripe call on replay).
 *  - INV-5: transfer amount = computeFeeBreakdown(...).netPayoutCents (unified module).
 *  - Disputed/non-FUNDED escrows are NEVER auto-released by this path.
 *  - Offline-payment tasks NEVER produce a Stripe transfer.
 *  - HMAC + schema validation identical in strength to dispute jobs.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  const transactionFn = vi.fn(async (fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn));
  return { db: { query: queryFn, transaction: transactionFn } };
});

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: { createTransfer: vi.fn() },
}));

vi.mock('../../src/services/EscrowService.js', () => ({
  EscrowService: { release: vi.fn() },
}));

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base, escrowLogger: base, taskLogger: base, aiLogger: base,
    stripeLogger: base, authLogger: base, workerLogger: base, dbLogger: base,
  };
});

vi.mock('../../src/config.js', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn(),
}));

vi.mock('../../src/lib/task-lifecycle-notifications.js', () => ({
  notifyPaymentReleased: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import { notifyAdmins } from '../../src/services/AdminNotificationHelper.js';
import { notifyPaymentReleased } from '../../src/lib/task-lifecycle-notifications.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import { computeFeeBreakdown } from '../../src/lib/money.js';
import { processCompletionReleaseJob } from '../../src/jobs/completion-release-worker.js';
import { ErrorCodes } from '../../src/types.js';

const dbQuery = db.query as unknown as ReturnType<typeof vi.fn>;
const dbTransaction = db.transaction as unknown as ReturnType<typeof vi.fn>;
const createTransfer = StripeService.createTransfer as unknown as ReturnType<typeof vi.fn>;
const escrowRelease = EscrowService.release as unknown as ReturnType<typeof vi.fn>;

const ESCROW_ID = '00000000-0000-0000-0000-0000000000aa';
const TASK_ID = '10000000-0000-0000-0000-0000000000aa';
const WORKER_ID = '20000000-0000-0000-0000-0000000000aa';
const POSTER_ID = '30000000-0000-0000-0000-0000000000aa';
const CONNECT_ID = 'acct_completion_test';
const AMOUNT = 10000; // $100.00 in cents
const VERSION = 3;

function makeJob(payload: object): Job<{ payload: object }> {
  return { name: 'escrow.completion_release_requested', data: { payload } } as unknown as Job<{ payload: object }>;
}
function signed(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, _sig: signJobPayload(fields) };
}
function basePayload(): Record<string, unknown> {
  return { escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'task_completed' };
}
function escrowRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ESCROW_ID, task_id: TASK_ID, state: 'FUNDED', version: VERSION,
    amount: AMOUNT, platform_fee_cents: null, stripe_transfer_id: null, ...over,
  };
}
function taskRow(over: Partial<Record<string, unknown>> = {}) {
  return { state: 'COMPLETED', worker_id: WORKER_ID, payment_method: 'escrow', poster_id: POSTER_ID, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbTransaction.mockImplementation(async (fn: (q: typeof dbQuery) => Promise<unknown>) => fn(dbQuery));
  escrowRelease.mockResolvedValue({ success: true, data: { id: ESCROW_ID, state: 'RELEASED' } });
});

describe('processCompletionReleaseJob — happy path', () => {
  it('creates transfer for unified net amount and calls EscrowService.release with the transfer id', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })          // TX1: escrow FOR UPDATE
      .mockResolvedValueOnce({ rows: [taskRow()] })            // TX1: task
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] }) // worker connect
      .mockResolvedValueOnce({ rows: [escrowRow()] })          // TX2: FOR UPDATE NOWAIT re-read
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });  // TX2: UPDATE
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_happy_1' } });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    const expected = computeFeeBreakdown(AMOUNT, 15);
    expect(createTransfer).toHaveBeenCalledTimes(1);
    const arg = createTransfer.mock.calls[0][0];
    expect(arg.escrowId).toBe(ESCROW_ID);
    expect(arg.workerStripeAccountId).toBe(CONNECT_ID);
    expect(arg.amount).toBe(expected.netPayoutCents);
    expect(arg.amount).toBe(8300); // 10000 - 1500 fee - 200 insurance (gross basis)
    expect(arg.idempotencyKeySuffix).toBe('completion_release');

    expect(escrowRelease).toHaveBeenCalledTimes(1);
    expect(escrowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_ID, stripeTransferId: 'tr_happy_1' })
    );

    // Worker is told they got paid — with the SAME net amount that was transferred
    expect(notifyPaymentReleased).toHaveBeenCalledWith(WORKER_ID, TASK_ID, expected.netPayoutCents);
  });

  it('replay with stripe_transfer_id already set: NO Stripe call, release still invoked with existing id (crash-resume)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
      .mockResolvedValueOnce({ rows: [taskRow()] });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_ID, stripeTransferId: 'tr_prior' })
    );
  });

  it('uses the canonical Price Book margin for a website quote', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ platform_fee_cents: 2500 })] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ platform_fee_cents: 2500 })] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_quote_economics' } });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 7300 }));
    expect(notifyPaymentReleased).toHaveBeenCalledWith(WORKER_ID, TASK_ID, 7300);
  });
});

describe('processCompletionReleaseJob — state guards (never release what is not FUNDED)', () => {
  it('missing escrow fails with the canonical corruption error before any money movement', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(`Escrow ${ESCROW_ID} not found for completion release`);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it.each(['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'] as const)(
    'escrow already %s → idempotent no-op (no Stripe, no release)',
    async (state) => {
    dbQuery.mockResolvedValueOnce({ rows: [escrowRow({ state, stripe_transfer_id: 'tr_done' })] });
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('escrow LOCKED_DISPUTE → no-op; dispute machinery owns the money', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [escrowRow({ state: 'LOCKED_DISPUTE' })] });
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('escrow PENDING (never funded) → no-op + admin alert, no throw (not retryable)', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [escrowRow({ state: 'PENDING' })] });
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalled();
  });

  it('task not COMPLETED → throws (data corruption — retry/DLQ), no Stripe call', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow({ state: 'DISPUTED' })] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).rejects.toThrow(/COMPLETED/);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('missing task fails with the canonical corruption error before any Stripe call', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(`Task ${TASK_ID} not found for completion release`);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });
});

describe('processCompletionReleaseJob — payment method + payout-account guards', () => {
  it('offline payment task → never creates a Stripe transfer, never releases', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow({ payment_method: 'offline_cash' })] });
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('worker without stripe_connect_id → no-op + notifyAdmins (ops releases manually), no retry-throw', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: null }] });
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalled();
  });
});

describe('processCompletionReleaseJob — concurrency + failure semantics', () => {
  it('TX2 version conflict → throws for BullMQ retry (replay resumes idempotently)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ version: VERSION + 1 })] }); // TX2 re-read: version moved
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_race' } });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).rejects.toThrow(/[Vv]ersion/);
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('TX2 re-read shows concurrent transfer_id → skips UPDATE, releases with the EXISTING id (no double-spend)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_winner' })] }); // TX2: another worker won
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_winner' } }); // Stripe idempotency returns same
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(escrowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ stripeTransferId: 'tr_winner' })
    );
  });

  it('EscrowService.release failure → throws (BullMQ retry); replay will skip Stripe via transfer-id idempotency', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_rel_fail' } });
    escrowRelease.mockResolvedValue({ success: false, error: { code: 'DB_ERROR', message: 'transient' } });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).rejects.toThrow(/release/i);
  });

  it('release reports terminal RELEASED state on replay → treated as idempotent success (no throw)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
      .mockResolvedValueOnce({ rows: [taskRow()] });
    escrowRelease.mockResolvedValue({ success: false, error: { code: ErrorCodes.ESCROW_TERMINAL, message: 'already RELEASED' } });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).resolves.toBeUndefined();
  });
});

describe('processCompletionReleaseJob — payload defenses (same strength as dispute jobs)', () => {
  it('rejects tampered signature without touching the database', async () => {
    const payload = { ...signed(basePayload()), _sig: 'deadbeef' };
    await expect(processCompletionReleaseJob(makeJob(payload))).rejects.toThrow(/SIGNATURE/);
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('rejects malformed payload (non-uuid escrow_id) before any work', async () => {
    await expect(
      processCompletionReleaseJob(makeJob(signed({ escrow_id: 'not-a-uuid', task_id: TASK_ID, reason: 'x' })))
    ).rejects.toThrow(/SCHEMA/);
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});
