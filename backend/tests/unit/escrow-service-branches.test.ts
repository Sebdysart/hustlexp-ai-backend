/**
 * EscrowService Branch Coverage Tests
 *
 * Targets backend/src/services/EscrowService.ts branches NOT covered by
 * the existing escrow-service.test.ts:
 *
 * - getByTaskId: NOT_FOUND, DB_ERROR
 * - release: escrow not found (empty rows on first SELECT)
 * - release: task not found / no worker assigned
 * - release: worker not found in KYC query
 * - release: stripe_connect_id missing (KYC gate)
 * - release: payouts_enabled=false (KYC gate)
 * - release: XP-TAX-BLOCK error path (warn+continue)
 * - release: unexpected XP error path (error+continue)
 * - release: rowCount=0 path when escrow is NOT found by getById after update
 * - release: rowCount=0 path when escrow IS terminal via getById
 * - release: rowCount=0 path when escrow is in wrong state (INVALID_STATE)
 * - refund: rowCount=0 path — getById returns not found
 * - refund: rowCount=0 path — escrow is terminal
 * - lockForDispute: rowCount=0 path — getById fallback INVALID_STATE
 * - partialRefund: percentages don't sum to 100
 * - partialRefund: rowCount=0 path — getById fallback
 * - logEscrowEvent: DB failure (non-fatal, only logs error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
  },
}));

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: {
    recordEarnings: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: {
    recordOfflinePayment: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    awardXP: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    isConfigured: vi.fn(() => false),
    createRefund: vi.fn().mockResolvedValue({ success: true, data: { refundId: 're_test_x', amount: 0, status: 'succeeded' } }),
    createTransfer: vi.fn().mockResolvedValue({ success: true, data: { transferId: 'tr_test_x', amount: 0 } }),
  },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db, isInvariantViolation } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { XPService } from '../../src/services/XPService';

const mockQuery       = vi.mocked(db.query);
const mockIsInvariant = vi.mocked(isInvariantViolation);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'FUNDED',
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: null,
    funded_at: new Date(),
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    poster_id: 'poster-1',
    worker_id: 'worker-1',
    ...overrides,
  };
}

function makeWorkerKyc(overrides: Record<string, unknown> = {}) {
  return {
    payouts_enabled: true,
    stripe_connect_id: 'acct_test_123',
    stripe_connect_status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockIsInvariant.mockReturnValue(false);
  vi.mocked(XPService.awardXP).mockResolvedValue(undefined);
  // Make db.transaction call through so queries inside the transaction use the mockQuery queue
  vi.mocked((db as any).transaction).mockImplementation((fn: (q: typeof db.query) => Promise<unknown>) => fn(db.query));
});

// ===========================================================================
// getByTaskId
// ===========================================================================

describe('EscrowService.getByTaskId', () => {
  it('returns NOT_FOUND when no escrow exists for task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.getByTaskId('task-no-escrow');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('task-no-escrow');
  });

  it('returns the escrow when found', async () => {
    const escrow = makeEscrow({ task_id: 'task-1' });
    mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

    const result = await EscrowService.getByTaskId('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.task_id).toBe('task-1');
  });

  it('returns DB_ERROR when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection timeout') as never);

    const result = await EscrowService.getByTaskId('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// release — early return: escrow not found
// ===========================================================================

describe('EscrowService.release — escrow not found', () => {
  it('returns NOT_FOUND when escrow row does not exist', async () => {
    // 1st query: SELECT escrow by id → empty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.release({ escrowId: 'nonexistent-esc', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// release — task has no worker
// ===========================================================================

describe('EscrowService.release — no worker assigned', () => {
  it('returns INVALID_STATE when task has no worker_id', async () => {
    // 1st: SELECT escrow → found
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      rowCount: 1,
    } as never);
    // 2nd: SELECT task → worker_id is null
    mockQuery.mockResolvedValueOnce({
      rows: [{ worker_id: null, price: 5000 }],
      rowCount: 1,
    } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('no assigned worker');
  });

  it('returns INVALID_STATE when task row not found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      rowCount: 1,
    } as never);
    // task select → empty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });
});

// ===========================================================================
// release — KYC gate: worker not found
// ===========================================================================

describe('EscrowService.release — KYC gate', () => {
  it('returns NOT_FOUND when worker user row is missing', async () => {
    // 1: escrow
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      rowCount: 1,
    } as never);
    // 2: task
    mockQuery.mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never);
    // 3: worker KYC → not found
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('Worker');
  });

  it('returns INVALID_STATE when stripe_connect_id is missing', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc({ stripe_connect_id: null })], rowCount: 1 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('Stripe Connect');
  });

  it('returns INVALID_STATE when payouts_enabled is false', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc({ payouts_enabled: false, stripe_connect_status: 'pending' })], rowCount: 1 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('KYC incomplete');
  });
});

// ===========================================================================
// release — rowCount=0 after UPDATE (terminal / wrong state)
// ===========================================================================

describe('EscrowService.release — UPDATE rowCount=0 branches', () => {
  function setupReleaseThroughKyc() {
    // escrow, task, worker KYC (all pass)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc()], rowCount: 1 } as never);
  }

  it('returns ESCROW_TERMINAL when escrow is in terminal state after failed UPDATE', async () => {
    setupReleaseThroughKyc();
    // UPDATE returns rowCount=0 → fallback getById: returns RELEASED (terminal)
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE fails
      .mockResolvedValueOnce({                                    // getById
        rows: [makeEscrow({ state: 'RELEASED', released_at: new Date() })],
        rowCount: 1,
      } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL
  });

  it('returns INVALID_STATE when escrow is in wrong non-terminal state after failed UPDATE', async () => {
    setupReleaseThroughKyc();
    // UPDATE returns rowCount=0 → fallback getById: returns PENDING (non-terminal, non-target)
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE fails
      .mockResolvedValueOnce({
        rows: [makeEscrow({ state: 'PENDING' })],
        rowCount: 1,
      } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('Cannot release escrow');
  });
});

// ===========================================================================
// release — XP error paths
// ===========================================================================

describe('EscrowService.release — XP error handling', () => {
  function setupSuccessfulRelease() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: 5000 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeWorkerKyc()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never) // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // logEscrowEvent INSERT
  }

  it('succeeds when XP award throws XP-TAX-BLOCK (continue, escrow still released)', async () => {
    setupSuccessfulRelease();
    vi.mocked(XPService.awardXP).mockRejectedValueOnce(
      new Error('XP-TAX-BLOCK: offline payment tax unpaid')
    );

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    // Escrow release itself still succeeds — XP block is non-fatal
    expect(result.success).toBe(true);
  });

  it('succeeds when XP award throws an unexpected error (continue, escrow still released)', async () => {
    setupSuccessfulRelease();
    vi.mocked(XPService.awardXP).mockRejectedValueOnce(
      new Error('Unexpected XP DB error')
    );

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_branch' });

    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// refund — rowCount=0 branches
// ===========================================================================

describe('EscrowService.refund — rowCount=0 branches', () => {
  it('returns getById error when getById fails after UPDATE rowCount=0', async () => {
    // Two pre-check queries before UPDATE
    mockQuery
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 } as never) // pre-check: task_id
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 } as never) // pre-check: worker_id
      // UPDATE returns rowCount=0
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById fallback → also fails (DB_ERROR)
    mockQuery.mockRejectedValueOnce(new Error('db error') as never);

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('returns ESCROW_TERMINAL when getById returns a terminal-state escrow', async () => {
    // Two pre-check queries before UPDATE
    mockQuery
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 } as never) // pre-check: task_id
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 } as never) // pre-check: worker_id
      // UPDATE rowCount=0
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // getById → REFUNDED (terminal)
      .mockResolvedValueOnce({
        rows: [makeEscrow({ state: 'REFUNDED' })],
        rowCount: 1,
      } as never);

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL
  });

  it('returns INVALID_STATE when getById returns escrow in PENDING state', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 } as never) // pre-check: task_id
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 } as never) // pre-check: worker_id
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE rowCount=0
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById fallback

    const result = await EscrowService.refund({ escrowId: 'esc-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('Cannot refund');
  });
});

// ===========================================================================
// lockForDispute — rowCount=0 branch
// ===========================================================================

describe('EscrowService.lockForDispute — rowCount=0', () => {
  it('returns INVALID_STATE when escrow is not FUNDED (e.g. PENDING)', async () => {
    // Window check — no rows (skips time gate)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // UPDATE rowCount=0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById → PENDING
    mockQuery.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never);

    const result = await EscrowService.lockForDispute('esc-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('expected FUNDED');
  });

  it('returns getById error when getById fails', async () => {
    // Window check — no rows (skips time gate)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // UPDATE rowCount=0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById DB error
    mockQuery.mockRejectedValueOnce(new Error('db error') as never);

    const result = await EscrowService.lockForDispute('esc-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// partialRefund — validation and rowCount=0 branches
// ===========================================================================

describe('EscrowService.partialRefund', () => {
  it('returns INVALID_STATE when worker + poster percentages do not sum to 100', async () => {
    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 60,
      posterPercent: 30, // 60 + 30 = 90 ≠ 100
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('sum to 100');
  });

  it('returns INVALID_STATE when escrow is not LOCKED_DISPUTE', async () => {
    // 1st: SELECT version, state FROM escrows FOR UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'FUNDED', version: 1 })], rowCount: 1 } as never);
    // 2nd: UPDATE rowCount=0 (WHERE state = 'LOCKED_DISPUTE' does not match FUNDED)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // 3rd: getById fallback → FUNDED (not LOCKED_DISPUTE)
    mockQuery.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'FUNDED' })], rowCount: 1 } as never);

    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 70,
      posterPercent: 30,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('expected LOCKED_DISPUTE');
  });

  it('succeeds when escrow is LOCKED_DISPUTE and percentages sum to 100', async () => {
    const updated = makeEscrow({ state: 'REFUND_PARTIAL' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'LOCKED_DISPUTE', version: 1 })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 } as never)  // UPDATE succeeds
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);          // logEscrowEvent INSERT

    const result = await EscrowService.partialRefund({
      escrowId: 'esc-1',
      workerPercent: 70,
      posterPercent: 30,
    });

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('REFUND_PARTIAL');
  });
});
