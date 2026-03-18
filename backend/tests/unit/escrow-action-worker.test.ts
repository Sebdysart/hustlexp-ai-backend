/**
 * escrow-action-worker.test.ts
 *
 * TDD tests for processEscrowActionJob — focuses on the P0 revenue bug:
 * platform fee must be deducted before transferring to worker.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));
vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: { createTransfer: vi.fn(), createRefund: vi.fn() },
}));
vi.mock('../../src/logger', () => ({
  workerLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn().mockReturnThis() },
}));
vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: { updateStatus: vi.fn(), advanceProgress: vi.fn() },
}));

// Provide a config mock so the worker can read platformFeePercent
vi.mock('../../src/config.js', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Helpers
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

/** Wire up the standard db.query call sequence for a release request */
function setupReleaseDbMocks(escrowAmountCents: number) {
  const dbQuery = vi.mocked(db.query);
  dbQuery
    // 1. Lock escrow FOR UPDATE
    .mockResolvedValueOnce({
      rows: [{
        id: ESCROW_ID,
        state: 'LOCKED_DISPUTE',
        version: ESCROW_VERSION,
        amount: escrowAmountCents,
        stripe_payment_intent_id: 'pi_test',
        stripe_transfer_id: null,   // no existing transfer — must process
        stripe_refund_id: null,
      }],
    } as never)
    // 2. SELECT worker_id FROM tasks
    .mockResolvedValueOnce({ rows: [{ worker_id: WORKER_ID }] } as never)
    // 3. SELECT stripe_connect_id FROM users
    .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }] } as never)
    // 4. SELECT amount FROM escrows
    .mockResolvedValueOnce({ rows: [{ amount: escrowAmountCents }] } as never)
    // 5. UPDATE escrows (store transfer_id)
    .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
}

// ---------------------------------------------------------------------------
// Tests
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
    setupReleaseDbMocks(escrowAmountCents);

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
    setupReleaseDbMocks(escrowAmountCents);

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
    setupReleaseDbMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'dispute resolved' }),
    );

    await processEscrowActionJob(job as never);

    // 15% of 3333 = 499.95 → round to 500; net = 3333 - 500 = 2833
    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    expect(transferCall.amount).toBe(2_833);
  });

  it('skips transfer when idempotent replay (stripe_transfer_id already set)', async () => {
    const dbQuery = vi.mocked(db.query);
    // Escrow already has a transfer_id — should be a no-op
    dbQuery.mockResolvedValueOnce({
      rows: [{
        id: ESCROW_ID,
        state: 'LOCKED_DISPUTE',
        version: ESCROW_VERSION,
        amount: 10_000,
        stripe_payment_intent_id: 'pi_test',
        stripe_transfer_id: 'tr_already_exists',
        stripe_refund_id: null,
      }],
    } as never);

    const job = makeJob('escrow.release_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'replay' }),
    );

    await processEscrowActionJob(job as never);

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });
});
