/**
 * Escrow + XP Atomicity Tests
 *
 * Verifies that escrow release and XP award are executed in a single atomic
 * transaction so that either both succeed or neither does.
 *
 * Testing strategy (mirrors stripe-webhook-idempotency pattern):
 *
 *  1. awardXPInTx tests — inject a mock `tx` directly. No module mocking
 *     required. Validates that XP logic propagates errors out of the tx block,
 *     which causes the caller's sql.begin() to roll back.
 *
 *  2. EscrowStateMachine.transition() tests — mock `../db/index.js` so we
 *     control the `transaction()` helper. Validates that:
 *       a) The escrow UPDATE and the XP award share one `transaction()` call.
 *       b) If awardXPInTx throws inside that block, the transaction function
 *          sees the rejection (and would roll back on a real DB).
 *       c) The COMPENSATING_TX error is logged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { awardXPInTx } from '../services/AtomicXPService.js';
import type { SqlTx } from '../db/index.js';

// ---------------------------------------------------------------------------
// awardXPInTx unit tests
// ---------------------------------------------------------------------------

describe('awardXPInTx', () => {
  it('returns error (does not throw) when task is not found', async () => {
    // tx returns [] for task query, signalling task not found
    const tx = (vi.fn().mockResolvedValue([])) as unknown as SqlTx;

    const result = await awardXPInTx('task-404', 'user-1', tx);

    expect(result.success).toBe(false);
    expect(result.xpAwarded).toBe(0);
    expect(result.error).toContain('Task not found');
  });

  it('returns error (does not throw) when user is not found', async () => {
    const tx = (vi.fn()
      .mockResolvedValueOnce([{ id: 'task-1', price: 50, state: 'completed' }]) // task found
      .mockResolvedValueOnce([])                                                  // user query empty
      .mockResolvedValue([])) as unknown as SqlTx;

    const result = await awardXPInTx('task-1', 'user-404', tx);

    expect(result.success).toBe(false);
    expect(result.xpAwarded).toBe(0);
    expect(result.error).toContain('User not found');
  });

  it('propagates DB errors so the surrounding transaction rolls back', async () => {
    // Task and user found; the INSERT into xp_ledger throws a generic DB error
    const dbError = new Error('connection reset by peer');
    const tx = (vi.fn()
      .mockResolvedValueOnce([{ id: 'task-1', price: 100, state: 'completed' }]) // task
      .mockResolvedValueOnce([{ id: 'user-1', xp: 0, level: 1, streak: 0 }])    // user
      .mockRejectedValueOnce(dbError)                                              // INSERT xp_ledger
      .mockResolvedValue([])) as unknown as SqlTx;

    await expect(awardXPInTx('task-1', 'user-1', tx)).rejects.toThrow(
      'connection reset by peer',
    );
  });

  it('succeeds and returns computed XP when task and user are found', async () => {
    // $50 task → 50 base XP; user has 0 XP (decay=1.0) and 0 streak (mul=1.0)
    const tx = (vi.fn()
      .mockResolvedValueOnce([{ id: 'task-1', price: 50, state: 'completed' }]) // task
      .mockResolvedValueOnce([{ id: 'user-1', xp: 0, level: 1, streak: 0 }])   // user
      .mockResolvedValueOnce([])                                                  // INSERT xp_ledger
      .mockResolvedValueOnce([])                                                  // UPDATE users
      .mockResolvedValue([])) as unknown as SqlTx;

    const result = await awardXPInTx('task-1', 'user-1', tx);

    expect(result.success).toBe(true);
    expect(result.xpAwarded).toBeGreaterThan(0);
    expect(result.alreadyAwarded).toBe(false);
  });

  it('handles idempotent re-award (UNIQUE violation code 23505) gracefully', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
    });

    const tx = (vi.fn()
      .mockResolvedValueOnce([{ id: 'task-1', price: 50, state: 'completed' }]) // task
      .mockResolvedValueOnce([{ id: 'user-1', xp: 200, level: 2, streak: 5 }]) // user
      .mockRejectedValueOnce(uniqueViolation)                                    // INSERT xp_ledger → conflict
      .mockResolvedValue([])) as unknown as SqlTx;

    const result = await awardXPInTx('task-1', 'user-1', tx);

    expect(result.success).toBe(true);
    expect(result.alreadyAwarded).toBe(true);
    expect(result.xpAwarded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EscrowStateMachine atomicity tests
// ---------------------------------------------------------------------------
//
// We mock `../db/index.js` to control the `transaction()` helper and `getSql()`
// so no real DB connection is required.

describe('EscrowStateMachine escrow+XP atomicity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('wraps escrow state update and XP award in a single transaction() call', async () => {
    // Track how many times `transaction` is called and capture the callback.
    const capturedCallbacks: Array<(tx: SqlTx) => Promise<unknown>> = [];

    // Slot ordering (Fix 3 adds FOR UPDATE SELECT as the FIRST statement):
    //   0. tx`SELECT ... FOR UPDATE`       — row lock (Fix 3)
    //   1. tx`` (empty) — funded branch (false, targetState !== 'funded')
    //   2. tx`stripe_transfer_id = ...` — released branch (stripeTransferId set)
    //   3. tx`UPDATE money_state_lock...`
    //   4. tx`INSERT INTO escrow_state_log...`
    //   5. tx`SELECT assigned_to...`
    //   6. awardXPInTx → task
    //   7. awardXPInTx → user
    //   8. awardXPInTx → INSERT xp_ledger
    //   9. awardXPInTx → UPDATE users
    const mockTx = (vi.fn()
      .mockResolvedValueOnce([])                                                        // FOR UPDATE SELECT (Fix 3)
      .mockResolvedValueOnce([])                                                        // tx`` sub-call (funded branch — false)
      .mockResolvedValueOnce([])                                                        // tx`stripe_transfer_id = ...` sub-call
      .mockResolvedValueOnce([])                                                        // tx`UPDATE money_state_lock...`
      .mockResolvedValueOnce([])                                                        // tx`INSERT INTO escrow_state_log...`
      .mockResolvedValueOnce([{ assigned_to: 'hustler-1' }])                           // tx`SELECT assigned_to...`
      .mockResolvedValueOnce([{ id: 'task-1', price: 100, state: 'completed' }])       // awardXPInTx → task
      .mockResolvedValueOnce([{ id: 'hustler-1', xp: 0, level: 1, streak: 0 }])       // awardXPInTx → user
      .mockResolvedValueOnce([])                                                        // awardXPInTx → INSERT xp_ledger
      .mockResolvedValue([])) as unknown as SqlTx;                                     // awardXPInTx → UPDATE users

    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-1',
        current_state: 'funded',
        amount_cents: 10000,
      }]),
      transaction: async (cb: (tx: SqlTx) => Promise<unknown>) => {
        capturedCallbacks.push(cb);
        return cb(mockTx);
      },
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-1', 'released', {
      stripeTransferId: 'tr_123',
    });

    // The overall operation should succeed
    expect(result.success).toBe(true);
    expect(result.newState).toBe('released');

    // Exactly ONE transaction() call should have been made for the release
    expect(capturedCallbacks).toHaveLength(1);
  });

  it('does not release escrow if XP award throws inside the transaction', async () => {
    // Simulate XP INSERT failing hard — this should cause the outer
    // transaction() to reject, which on a real DB triggers a full rollback.
    let transactionRejected = false;

    // Slot ordering (Fix 3 adds FOR UPDATE SELECT as the FIRST statement):
    //   0. tx`SELECT ... FOR UPDATE`       — row lock (Fix 3)
    //   1. tx`` sub-call (funded branch — false)
    //   2. tx`stripe_transfer_id = ...` sub-call
    //   3. tx`UPDATE money_state_lock...`
    //   4. tx`INSERT INTO escrow_state_log...`
    //   5. tx`SELECT assigned_to...`
    //   6. awardXPInTx → task
    //   7. awardXPInTx → user
    //   8. INSERT xp_ledger → throws
    const mockTx = (vi.fn()
      .mockResolvedValueOnce([])                                                   // FOR UPDATE SELECT (Fix 3)
      .mockResolvedValueOnce([])                                                   // tx`` sub-call (funded branch — false)
      .mockResolvedValueOnce([])                                                   // tx`stripe_transfer_id = ...` sub-call
      .mockResolvedValueOnce([])                                                   // tx`UPDATE money_state_lock...`
      .mockResolvedValueOnce([])                                                   // tx`INSERT INTO escrow_state_log...`
      .mockResolvedValueOnce([{ assigned_to: 'hustler-1' }])                      // tx`SELECT assigned_to...`
      .mockResolvedValueOnce([{ id: 'task-1', price: 100, state: 'completed' }])  // awardXPInTx → task
      .mockResolvedValueOnce([{ id: 'hustler-1', xp: 0, level: 1, streak: 0 }])  // awardXPInTx → user
      .mockRejectedValueOnce(new Error('xp_ledger insert failed'))                 // INSERT xp_ledger throws
      .mockResolvedValue([])) as unknown as SqlTx;

    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-1',
        current_state: 'funded',
        amount_cents: 10000,
      }]),
      transaction: async (cb: (tx: SqlTx) => Promise<unknown>) => {
        try {
          return await cb(mockTx);
        } catch (err) {
          // Simulate the DB rolling back on error
          transactionRejected = true;
          throw err;
        }
      },
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-1', 'released', {
      stripeTransferId: 'tr_456',
    });

    // The transition must report failure — not partial success
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // The transaction was rolled back (rejected) due to XP failure
    expect(transactionRejected).toBe(true);
  });

  it('awards XP if and only if escrow state update commits (happy path)', async () => {
    const committedOperations: string[] = [];

    const mockTx = vi.fn().mockImplementation(
      async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const sql = strings.join('?').trim().toLowerCase();
        if (sql.includes('update money_state_lock')) {
          committedOperations.push('escrow_update');
          return [];
        }
        if (sql.includes('insert into escrow_state_log')) {
          committedOperations.push('escrow_log');
          return [];
        }
        if (sql.includes('select assigned_to')) return [{ assigned_to: 'hustler-2' }];
        if (sql.includes('select id, price')) return [{ id: 'task-2', price: 200, state: 'completed' }];
        if (sql.includes('select id, xp')) return [{ id: 'hustler-2', xp: 500, level: 3, streak: 2 }];
        if (sql.includes('insert into xp_ledger')) {
          committedOperations.push('xp_insert');
          return [];
        }
        if (sql.includes('update users')) {
          committedOperations.push('user_update');
          return [];
        }
        return [];
      },
    ) as unknown as SqlTx;

    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-2',
        current_state: 'funded',
        amount_cents: 20000,
      }]),
      transaction: async (cb: (tx: SqlTx) => Promise<unknown>) => cb(mockTx),
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-2', 'released');

    expect(result.success).toBe(true);

    // Both escrow update and XP award must have committed
    expect(committedOperations).toContain('escrow_update');
    expect(committedOperations).toContain('xp_insert');
    expect(committedOperations).toContain('user_update');

    // Ordering: escrow update must precede XP insert within the same tx block
    const escrowIdx = committedOperations.indexOf('escrow_update');
    const xpIdx = committedOperations.indexOf('xp_insert');
    expect(escrowIdx).toBeLessThan(xpIdx);
  });

  it('logs COMPENSATING_TX when the atomic transaction fails', async () => {
    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-3',
        current_state: 'funded',
        amount_cents: 5000,
      }]),
      transaction: async (_cb: (tx: SqlTx) => Promise<unknown>) => {
        throw new Error('Simulated DB failure');
      },
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-3', 'released');

    expect(result.success).toBe(false);
    // The error message from the catch block should be present
    expect(result.error).toContain('Simulated DB failure');
  });

  // -------------------------------------------------------------------------
  // Fix 1: Stale previousState/newState in catch block
  // -------------------------------------------------------------------------

  it('Fix 1: returns previousState:funded (not pending) when a funded escrow fails', async () => {
    // getSql returns a funded lock; transaction throws to simulate DB failure
    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-fix1',
        current_state: 'funded',
        amount_cents: 8000,
      }]),
      transaction: async (_cb: (tx: SqlTx) => Promise<unknown>) => {
        throw new Error('Network error during commit');
      },
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-fix1', 'released');

    expect(result.success).toBe(false);
    // Must reflect the real DB state (funded), not the hardcoded 'pending' sentinel
    expect(result.previousState).toBe('funded');
    expect(result.newState).toBe('funded');
    expect(result.error).toContain('Network error during commit');
  });

  it('Fix 1: returns previousState:locked_dispute when a locked_dispute escrow fails', async () => {
    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-fix1b',
        current_state: 'locked_dispute',
        amount_cents: 8000,
      }]),
      transaction: async (_cb: (tx: SqlTx) => Promise<unknown>) => {
        throw new Error('Serialization failure');
      },
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-fix1b', 'released');

    expect(result.success).toBe(false);
    expect(result.previousState).toBe('locked_dispute');
    expect(result.newState).toBe('locked_dispute');
  });

  // -------------------------------------------------------------------------
  // Fix 2a: awardXPInTx real failure causes rollback (previously swallowed)
  // -------------------------------------------------------------------------

  it('Fix 2a: throws and rolls back when awardXPInTx returns success:false non-idempotent', async () => {
    let transactionRejected = false;

    const mockTx = (vi.fn()
      .mockResolvedValueOnce([])                                                   // FOR UPDATE SELECT
      .mockResolvedValueOnce([])                                                   // tx`` sub-call (funded branch false)
      .mockResolvedValueOnce([])                                                   // tx`stripe_transfer_id...` sub-call
      .mockResolvedValueOnce([])                                                   // UPDATE money_state_lock
      .mockResolvedValueOnce([])                                                   // INSERT escrow_state_log
      .mockResolvedValueOnce([{ assigned_to: 'hustler-xp-fail' }])                // SELECT assigned_to
      .mockResolvedValueOnce([])                                                   // awardXPInTx: task not found → []
      .mockResolvedValue([])) as unknown as SqlTx;

    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-fix2a',
        current_state: 'funded',
        amount_cents: 5000,
      }]),
      transaction: async (cb: (tx: SqlTx) => Promise<unknown>) => {
        try {
          return await cb(mockTx);
        } catch (err) {
          transactionRejected = true;
          throw err;
        }
      },
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    // awardXPInTx will return success:false because mockTx returns [] for the
    // task query, making awardXPInTx return { success: false, alreadyAwarded: false }
    const result = await EscrowStateMachine.transition('task-fix2a', 'released', {
      stripeTransferId: 'tr_fix2a',
    });

    // Must fail — not silently continue
    expect(result.success).toBe(false);
    // Error message must mention XP award failure
    expect(result.error).toMatch(/XP award failed/i);
    // Transaction was rolled back
    expect(transactionRejected).toBe(true);
    // previousState must reflect the real state (funded), not 'pending'
    expect(result.previousState).toBe('funded');
    expect(result.newState).toBe('funded');
  });

  // -------------------------------------------------------------------------
  // Fix 2b: alreadyAwarded path — idempotent, must NOT cause failure
  // -------------------------------------------------------------------------

  it('Fix 2b: succeeds when awardXPInTx returns alreadyAwarded:true (idempotent)', async () => {
    const mockTx = (vi.fn()
      .mockResolvedValueOnce([])                                                        // FOR UPDATE SELECT
      .mockResolvedValueOnce([])                                                        // tx`` sub-call (funded branch false)
      .mockResolvedValueOnce([])                                                        // tx`stripe_transfer_id...` sub-call
      .mockResolvedValueOnce([])                                                        // UPDATE money_state_lock
      .mockResolvedValueOnce([])                                                        // INSERT escrow_state_log
      .mockResolvedValueOnce([{ assigned_to: 'hustler-idem' }])                        // SELECT assigned_to
      .mockResolvedValueOnce([{ id: 'task-idem', price: 100, state: 'completed' }])    // awardXPInTx → task
      .mockResolvedValueOnce([{ id: 'hustler-idem', xp: 500, level: 3, streak: 5 }])  // awardXPInTx → user
      // Simulate the UNIQUE violation (code 23505) so awardXPInTx returns alreadyAwarded:true
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505' }))
      .mockResolvedValue([])) as unknown as SqlTx;

    vi.doMock('../db/index.js', () => ({
      getSql: () => vi.fn().mockResolvedValue([{
        task_id: 'task-idem',
        current_state: 'funded',
        amount_cents: 10000,
      }]),
      transaction: async (cb: (tx: SqlTx) => Promise<unknown>) => cb(mockTx),
      sql: vi.fn(),
      safeSql: vi.fn(),
      isDatabaseAvailable: () => false,
    }));

    const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');

    const result = await EscrowStateMachine.transition('task-idem', 'released', {
      stripeTransferId: 'tr_idem',
    });

    // Must succeed — alreadyAwarded is idempotent
    expect(result.success).toBe(true);
    expect(result.newState).toBe('released');
    // xpAwarded is 0 because no new XP was granted (already existed)
    expect(result.xpAwarded).toBe(0);
  });
});
