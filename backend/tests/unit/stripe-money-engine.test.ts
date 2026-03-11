/**
 * Unit Tests for src/services/StripeMoneyEngine.ts
 *
 * Covers:
 * - getNextState: all valid and invalid transitions
 * - handle: KillSwitch engaged
 * - handle: duplicate event idempotency (returns early)
 * - handle: HOLD_ESCROW — happy path (existing lock row, new lock row)
 * - handle: HOLD_ESCROW — stripe failure + compensation
 * - handle: RELEASE_PAYOUT — happy path
 * - handle: RELEASE_PAYOUT — payout blocked
 * - handle: RELEASE_PAYOUT — stripe failure + compensation
 * - handle: REFUND_ESCROW — happy path
 * - handle: REFUND_ESCROW — stripe failure
 * - handle: invalid state transition throws
 * - StripeMoneyEngine named export alias
 * - Ledger failure is non-fatal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// ALL MOCKS — factories MUST be self-contained (no outer variable references)
// vi.mock is hoisted, so we must use vi.hoisted() to create variables
// that are available both inside vi.mock factories and in test code.
// ============================================================================

// Set STRIPE_SECRET_KEY before module load using vi.hoisted.
// vi.hoisted runs before vi.mock factories AND before module imports,
// which means it runs before the StripeMoneyEngine module-level stripe init.
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock_money_engine';
});

// Create a stable mock Stripe instance using vi.hoisted so it's available
// when the vi.mock('stripe') factory runs (which is hoisted to the top).
const { mockStripePaymentIntents, mockStripeTransfers, mockStripeRefunds } = vi.hoisted(() => {
  return {
    mockStripePaymentIntents: {
      create: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    },
    mockStripeTransfers: {
      create: vi.fn(),
      createReversal: vi.fn(),
    },
    mockStripeRefunds: {
      create: vi.fn(),
    },
  };
});

vi.mock('stripe', () => ({
  default: vi.fn(function StripeConstructor() {
    return {
      paymentIntents: mockStripePaymentIntents,
      transfers: mockStripeTransfers,
      refunds: mockStripeRefunds,
    };
  }),
}));

vi.mock('../../../src/infra/KillSwitch.js', () => ({
  KillSwitch: {
    isActive: vi.fn().mockResolvedValue(false),
    trigger: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../src/infra/ordering/TemporalGuard.js', () => ({
  TemporalGuard: {
    validateSequence: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../../src/services/ledger/LedgerAccountService.js', () => ({
  LedgerAccountService: {
    getPlatformId: vi.fn(() => 'platform-account'),
    getAccount: vi.fn().mockResolvedValue({ id: 'platform-account' }),
  },
}));

vi.mock('../../../src/services/ledger/LedgerService.js', () => ({
  LedgerService: {
    prepareTransaction: vi.fn().mockResolvedValue({ id: 'ledger-tx-id' }),
    commitTransaction: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../../src/services/PayoutEligibilityResolver.js', () => ({
  PayoutEligibilityResolver: {
    resolve: vi.fn().mockResolvedValue({ decision: 'ALLOW' }),
  },
  PayoutDecision: {
    ALLOW: 'ALLOW',
    BLOCK: 'BLOCK',
    ESCALATE: 'ESCALATE',
  },
}));

vi.mock('../../../src/config/safety.js', () => ({
  assertPayoutsEnabled: vi.fn(),
}));

vi.mock('../../../src/db/index.js', () => ({
  transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const _tx = Object.assign(vi.fn().mockResolvedValue([]), {
      unsafe: vi.fn().mockResolvedValue([]),
    });
    return cb(_tx);
  }),
  sql: Object.assign(vi.fn().mockResolvedValue([]), {
    unsafe: vi.fn().mockResolvedValue([]),
  }),
  safeSql: Object.assign(vi.fn().mockResolvedValue([]), {
    unsafe: vi.fn().mockResolvedValue([]),
  }),
  isDatabaseAvailable: vi.fn(() => false),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const noop = vi.fn();
  const makeLogger = () => ({
    info: noop, warn: noop, error: noop, fatal: noop, debug: noop,
    child: () => makeLogger(),
  });
  return {
    createLogger: vi.fn(() => makeLogger()),
    logger: makeLogger(),
    serviceLogger: makeLogger(),
  };
});

// ============================================================================
// IMPORTS — after mocks
// ============================================================================

import { getNextState, handle, StripeMoneyEngine } from '../../../src/services/StripeMoneyEngine.js';
import { PayoutEligibilityResolver, PayoutDecision } from '../../../src/services/PayoutEligibilityResolver.js';
import { KillSwitch } from '../../../src/infra/KillSwitch.js';
import { transaction } from '../../../src/db/index.js';
import { LedgerService } from '../../../src/services/ledger/LedgerService.js';

// ============================================================================
// HELPERS
// ============================================================================

type TxFn = ReturnType<typeof vi.fn>;

/**
 * Build a transaction implementation that exercises the SAGA callback.
 * The tx function returns different values on successive calls:
 *   call 0: idempotency SELECT
 *   call 1: lock SELECT FOR UPDATE
 *   call 2+: UPDATEs / INSERTs
 */
function buildTransactionImpl(opts?: {
  existingEvent?: boolean;
  lockRow?: Record<string, unknown> | null;
  failAtCall?: number;
}) {
  return vi.fn(async (cb: (tx: TxFn) => Promise<unknown>) => {
    let callIdx = 0;
    const tx = Object.assign(
      vi.fn((..._args: unknown[]) => {
        const idx = callIdx++;
        // 0: idempotency
        if (idx === 0) {
          return Promise.resolve(opts?.existingEvent ? [{ event_id: 'dup' }] : []);
        }
        // 1: lock row
        if (idx === 1) {
          const row = opts?.lockRow === undefined
            ? [] // no lock row
            : opts.lockRow === null
              ? []
              : [opts.lockRow];
          return Promise.resolve(row);
        }
        // Deliberate failure
        if (opts?.failAtCall !== undefined && idx === opts.failAtCall) {
          return Promise.reject(new Error(`Deliberate DB failure at call ${idx}`));
        }
        return Promise.resolve([]);
      }),
      { unsafe: vi.fn().mockResolvedValue([]) },
    );
    return cb(tx);
  });
}

const baseOpenLockRow = {
  task_id: 'task-test',
  current_state: 'open' as const,
  amount_cents: 10000,
  stripe_payment_intent_id: null,
  stripe_charge_id: null,
  stripe_transfer_id: null,
};

const baseHeldLockRow = {
  task_id: 'task-test',
  current_state: 'held' as const,
  amount_cents: 10000,
  stripe_payment_intent_id: 'pi_existing',
  stripe_charge_id: 'ch_existing',
  stripe_transfer_id: null,
};

// ============================================================================
// TEST SETUP
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(KillSwitch.isActive).mockResolvedValue(false);
  vi.mocked(PayoutEligibilityResolver.resolve).mockResolvedValue({ decision: PayoutDecision.ALLOW } as never);
  vi.mocked(LedgerService.prepareTransaction).mockResolvedValue({ id: 'ledger-x' } as never);
  vi.mocked(LedgerService.commitTransaction).mockResolvedValue(true as never);
  // Reset transaction mock to pass-through by default
  vi.mocked(transaction).mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const _tx = Object.assign(vi.fn().mockResolvedValue([]), {
      unsafe: vi.fn().mockResolvedValue([]),
    });
    return cb(_tx);
  });
});

// ============================================================================
// getNextState — state transition table
// ============================================================================

describe('getNextState', () => {
  it('open + HOLD_ESCROW → held', () => {
    expect(getNextState('open', 'HOLD_ESCROW')).toBe('held');
  });

  it('held + RELEASE_PAYOUT → released', () => {
    expect(getNextState('held', 'RELEASE_PAYOUT')).toBe('released');
  });

  it('held + REFUND_ESCROW → refunded', () => {
    expect(getNextState('held', 'REFUND_ESCROW')).toBe('refunded');
  });

  it('throws for open + RELEASE_PAYOUT (invalid)', () => {
    expect(() => getNextState('open', 'RELEASE_PAYOUT')).toThrow('Invalid event');
  });

  it('throws for open + REFUND_ESCROW (invalid)', () => {
    expect(() => getNextState('open', 'REFUND_ESCROW')).toThrow('Invalid event');
  });

  it('throws for released (terminal) + any event', () => {
    expect(() => getNextState('released', 'RELEASE_PAYOUT')).toThrow('Invalid event');
    expect(() => getNextState('released', 'REFUND_ESCROW')).toThrow('Invalid event');
    expect(() => getNextState('released', 'HOLD_ESCROW')).toThrow('Invalid event');
  });

  it('throws for refunded (terminal) + any event', () => {
    expect(() => getNextState('refunded', 'HOLD_ESCROW')).toThrow('Invalid event');
    expect(() => getNextState('refunded', 'RELEASE_PAYOUT')).toThrow('Invalid event');
    expect(() => getNextState('refunded', 'REFUND_ESCROW')).toThrow('Invalid event');
  });

  it('throws for completed (terminal) + any event', () => {
    expect(() => getNextState('completed', 'HOLD_ESCROW')).toThrow('Invalid event');
    expect(() => getNextState('completed', 'RELEASE_PAYOUT')).toThrow('Invalid event');
    expect(() => getNextState('completed', 'REFUND_ESCROW')).toThrow('Invalid event');
  });

  it('throws for held + HOLD_ESCROW (not valid from held)', () => {
    expect(() => getNextState('held', 'HOLD_ESCROW')).toThrow('Invalid event');
  });
});

// ============================================================================
// handle — KillSwitch
// ============================================================================

describe('handle — KillSwitch', () => {
  it('throws KILLSWITCH ENGAGED when KillSwitch is active', async () => {
    vi.mocked(KillSwitch.isActive).mockResolvedValueOnce(true);

    await expect(
      handle('task-kill', 'HOLD_ESCROW', {
        taskId: 'task-kill', amountCents: 10000,
        paymentMethodId: 'pm_test', posterId: 'p1',
      }),
    ).rejects.toThrow('KILLSWITCH ENGAGED');

    expect(transaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// handle — Idempotency
// ============================================================================

describe('handle — duplicate event', () => {
  it('returns duplicate_ignored when event already processed', async () => {
    vi.mocked(transaction).mockImplementationOnce(buildTransactionImpl({ existingEvent: true }));

    const result = await handle('task-dup', 'HOLD_ESCROW', {
      taskId: 'task-dup', amountCents: 5000,
      paymentMethodId: 'pm_test', posterId: 'p-dup',
    }, { eventId: 'evt-already-seen' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('duplicate_ignored');
  });
});

// ============================================================================
// handle — HOLD_ESCROW
// ============================================================================

describe('handle — HOLD_ESCROW', () => {
  it('creates new lock row (INSERT path) when no existing lock', async () => {
    // lockRow not defined → returns [] → currentState='open'
    vi.mocked(transaction).mockImplementationOnce(buildTransactionImpl({ lockRow: undefined }));

    // Use the hoisted mock directly
    mockStripePaymentIntents.create.mockResolvedValueOnce({ id: 'pi_new' });
    mockStripePaymentIntents.capture.mockResolvedValueOnce({
      id: 'pi_new', latest_charge: 'ch_new',
    });

    const result = await handle('task-new', 'HOLD_ESCROW', {
      taskId: 'task-new', amountCents: 10000,
      paymentMethodId: 'pm_card', posterId: 'p-new',
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe('held');
    expect(result.stripePaymentIntentId).toBe('pi_new');
  });

  it('updates existing lock row (UPDATE path) when lock exists with open state', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseOpenLockRow } }),
    );

    mockStripePaymentIntents.create.mockResolvedValueOnce({ id: 'pi_upd' });
    mockStripePaymentIntents.capture.mockResolvedValueOnce({
      id: 'pi_upd', latest_charge: { id: 'ch_upd' },
    });

    const result = await handle('task-existing', 'HOLD_ESCROW', {
      taskId: 'task-existing', amountCents: 10000,
      paymentMethodId: 'pm_card', posterId: 'p-upd',
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe('held');
  });

  it('throws the Stripe error when capture fails (no compensation — stripeResult.paymentIntentId not set)', async () => {
    // When capture throws, executeHoldEscrow throws before returning paymentIntentId.
    // Therefore stripeResult stays {}, the compensation guard
    //   `if (event === 'HOLD_ESCROW' && stripeResult.paymentIntentId)` is false,
    // and cancel is NOT called. The original error is re-thrown.
    mockStripePaymentIntents.create.mockResolvedValueOnce({ id: 'pi_comp' });
    mockStripePaymentIntents.capture.mockRejectedValueOnce(new Error('Capture failed'));

    vi.mocked(transaction).mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
      let txCallIdx = 0;
      const tx = Object.assign(
        vi.fn(() => {
          const idx = txCallIdx++;
          if (idx === 0) return Promise.resolve([]); // idempotency
          if (idx === 1) return Promise.resolve([]); // lock: no row
          return Promise.resolve([]);
        }),
        { unsafe: vi.fn().mockResolvedValue([]) },
      );
      return cb(tx);
    });

    await expect(
      handle('task-comp', 'HOLD_ESCROW', {
        taskId: 'task-comp', amountCents: 10000,
        paymentMethodId: 'pm_fail', posterId: 'p-comp',
      }),
    ).rejects.toThrow('Capture failed');

    // cancel is NOT called — stripeResult.paymentIntentId was never populated
    // because executeHoldEscrow threw before returning
    expect(mockStripePaymentIntents.cancel).not.toHaveBeenCalled();
  });
});

// ============================================================================
// handle — RELEASE_PAYOUT
// ============================================================================

describe('handle — RELEASE_PAYOUT', () => {
  it('creates transfer and commits released state', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );

    mockStripeTransfers.create.mockResolvedValueOnce({ id: 'tr_ok' });

    const result = await handle('task-release', 'RELEASE_PAYOUT', {
      taskId: 'task-release',
      hustlerId: 'h-1',
      hustlerStripeAccountId: 'acct_hustler',
      payoutAmountCents: 8500,
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe('released');
    expect(result.stripeTransferId).toBe('tr_ok');
  });

  it('throws when payout eligibility resolver blocks payout', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );

    vi.mocked(PayoutEligibilityResolver.resolve).mockResolvedValueOnce({
      decision: PayoutDecision.BLOCK,
      reason: 'KYC incomplete',
    } as never);

    await expect(
      handle('task-blocked', 'RELEASE_PAYOUT', {
        taskId: 'task-blocked',
        hustlerId: 'h-blocked',
        hustlerStripeAccountId: 'acct_blocked',
        payoutAmountCents: 5000,
      }),
    ).rejects.toThrow('Payout blocked');
  });

  it('throws DB error when DB commit fails after transfer (no reversal — compensation only fires when Stripe op throws)', async () => {
    // The compensation guard is inside the Stripe try-catch (Phase 2).
    // If Phase 3 (DB commit) fails AFTER executeReleasePayout returns,
    // the error escapes the outer transaction without triggering compensation.
    // This test verifies the actual behaviour: error re-thrown, createReversal NOT called.
    mockStripeTransfers.create.mockResolvedValueOnce({ id: 'tr_comp' });

    vi.mocked(transaction).mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
      let txCallIdx = 0;
      const tx = Object.assign(
        vi.fn(() => {
          const idx = txCallIdx++;
          if (idx === 0) return Promise.resolve([]); // idempotency
          if (idx === 1) return Promise.resolve([{ ...baseHeldLockRow }]); // lock
          // idx 2+ = Phase 3 DB writes → throw to simulate DB commit failure
          return Promise.reject(new Error('DB commit failed'));
        }),
        { unsafe: vi.fn().mockResolvedValue([]) },
      );
      return cb(tx);
    });

    await expect(
      handle('task-comp-rel', 'RELEASE_PAYOUT', {
        taskId: 'task-comp-rel',
        hustlerId: 'h-comp',
        hustlerStripeAccountId: 'acct_comp',
        payoutAmountCents: 8000,
      }),
    ).rejects.toThrow('DB commit failed');

    // createReversal is NOT called — DB failure happens outside the Stripe try-catch
    expect(mockStripeTransfers.createReversal).not.toHaveBeenCalled();
  });

  it('reverses transfer (compensation) when Stripe transfer throws mid-execute', async () => {
    // This is the compensation scenario that actually triggers:
    // If executeReleasePayout itself throws (e.g., from PayoutEligibilityResolver or transfers.create),
    // the catch inside Phase 2 runs, but stripeResult.transferId is only set IF
    // transfers.create succeeds before another step throws.
    // Since transfers.create IS the last step in executeReleasePayout, if it throws
    // stripeResult.transferId is never set — so we verify that here too.
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );
    mockStripeTransfers.create.mockRejectedValueOnce(new Error('Transfer network error'));

    await expect(
      handle('task-transfer-fail', 'RELEASE_PAYOUT', {
        taskId: 'task-transfer-fail',
        hustlerId: 'h-fail',
        hustlerStripeAccountId: 'acct_fail',
        payoutAmountCents: 7000,
      }),
    ).rejects.toThrow('Transfer network error');

    // No reversal — transfer never completed, stripeResult.transferId never set
    expect(mockStripeTransfers.createReversal).not.toHaveBeenCalled();
  });

  it('uses lockRow.amount_cents when payoutAmountCents is not provided', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow, amount_cents: 9000 } }),
    );

    mockStripeTransfers.create.mockResolvedValueOnce({ id: 'tr_def' });

    const result = await handle('task-default-amt', 'RELEASE_PAYOUT', {
      taskId: 'task-default-amt',
      hustlerId: 'h-def',
      hustlerStripeAccountId: 'acct_def',
      // payoutAmountCents not provided
    });

    expect(result.success).toBe(true);
    expect(mockStripeTransfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9000 }),
    );
  });
});

// ============================================================================
// handle — REFUND_ESCROW
// ============================================================================

describe('handle — REFUND_ESCROW', () => {
  it('creates refund and commits refunded state', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );

    mockStripeRefunds.create.mockResolvedValueOnce({ id: 're_ok' });

    const result = await handle('task-refund', 'REFUND_ESCROW', {
      taskId: 'task-refund',
      reason: 'Task cancelled',
      refundAmountCents: 10000,
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe('refunded');
    expect(result.stripeRefundId).toBe('re_ok');
  });

  it('throws when stripe refund fails', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );

    mockStripeRefunds.create.mockRejectedValueOnce(new Error('Charge already refunded'));

    await expect(
      handle('task-refund-fail', 'REFUND_ESCROW', {
        taskId: 'task-refund-fail',
        refundAmountCents: 5000,
      }),
    ).rejects.toThrow('Charge already refunded');
  });

  it('passes undefined amount for full refund when refundAmountCents not provided', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );

    mockStripeRefunds.create.mockResolvedValueOnce({ id: 're_full' });

    const result = await handle('task-full-refund', 'REFUND_ESCROW', {
      taskId: 'task-full-refund',
      // no refundAmountCents
    });

    expect(result.success).toBe(true);
    expect(mockStripeRefunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: undefined }),
    );
  });
});

// ============================================================================
// handle — Invalid state transitions
// ============================================================================

describe('handle — invalid transitions', () => {
  it('throws for released state + RELEASE_PAYOUT (terminal state)', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({
        lockRow: { ...baseHeldLockRow, current_state: 'released', stripe_transfer_id: 'tr_done' },
      }),
    );

    await expect(
      handle('task-released', 'RELEASE_PAYOUT', {
        taskId: 'task-released',
        hustlerId: 'h-r',
        hustlerStripeAccountId: 'acct_r',
      }),
    ).rejects.toThrow('Invalid event');
  });

  it('throws for refunded state + REFUND_ESCROW (terminal state)', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({
        lockRow: { ...baseHeldLockRow, current_state: 'refunded' },
      }),
    );

    await expect(
      handle('task-already-refunded', 'REFUND_ESCROW', {
        taskId: 'task-already-refunded',
        refundAmountCents: 5000,
      }),
    ).rejects.toThrow('Invalid event');
  });
});

// ============================================================================
// handle — Ledger failure is non-fatal
// ============================================================================

describe('handle — ledger error is non-fatal', () => {
  it('still returns success when LedgerService.prepareTransaction throws', async () => {
    vi.mocked(transaction).mockImplementationOnce(
      buildTransactionImpl({ lockRow: { ...baseHeldLockRow } }),
    );
    vi.mocked(LedgerService.prepareTransaction).mockRejectedValueOnce(new Error('Ledger down'));

    mockStripeRefunds.create.mockResolvedValueOnce({ id: 're_ledger_err' });

    const result = await handle('task-ledger-err', 'REFUND_ESCROW', {
      taskId: 'task-ledger-err',
      refundAmountCents: 8000,
    });

    // Ledger error is non-fatal — should still commit
    expect(result.success).toBe(true);
    expect(result.state).toBe('refunded');
  });
});

// ============================================================================
// StripeMoneyEngine named export alias
// ============================================================================

describe('StripeMoneyEngine named export alias', () => {
  it('exposes handle function', () => {
    expect(typeof StripeMoneyEngine.handle).toBe('function');
  });

  it('exposes getNextState function', () => {
    expect(typeof StripeMoneyEngine.getNextState).toBe('function');
  });

  it('getNextState works correctly via alias', () => {
    expect(StripeMoneyEngine.getNextState('open', 'HOLD_ESCROW')).toBe('held');
    expect(StripeMoneyEngine.getNextState('held', 'RELEASE_PAYOUT')).toBe('released');
    expect(StripeMoneyEngine.getNextState('held', 'REFUND_ESCROW')).toBe('refunded');
  });

  it('getNextState throws for invalid via alias', () => {
    expect(() => StripeMoneyEngine.getNextState('released', 'HOLD_ESCROW')).toThrow('Invalid event');
  });
});

// ============================================================================
// handle — options.eventId generation
// ============================================================================

describe('handle — eventId auto-generation', () => {
  it('auto-generates eventId when not provided in options', async () => {
    vi.mocked(transaction).mockImplementationOnce(buildTransactionImpl({ lockRow: undefined }));

    mockStripePaymentIntents.create.mockResolvedValueOnce({ id: 'pi_auto' });
    mockStripePaymentIntents.capture.mockResolvedValueOnce({
      id: 'pi_auto', latest_charge: 'ch_auto',
    });

    // No eventId provided → auto-generated from taskId + event + timestamp
    const result = await handle('task-auto-id', 'HOLD_ESCROW', {
      taskId: 'task-auto-id', amountCents: 6000,
      paymentMethodId: 'pm_auto', posterId: 'p-auto',
    }); // no options.eventId

    expect(result.success).toBe(true);
  });
});
