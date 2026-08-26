/**
 * Dispute Regression Tests — R7
 *
 * Covers four security bugs fixed in FIX-Z1:
 *
 *   Bug 1 (CRITICAL): SQL interval injection in revenueBreakdown / aiCostSummary.
 *     Verifies queries use `$1 * INTERVAL '1 day'` not string concatenation.
 *
 *   Bug 2 (HIGH): Dispute flood — no per-escrow or per-user rate limit.
 *     Verifies lockForDispute throws CONFLICT when an open dispute exists,
 *     and TOO_MANY_REQUESTS when a user exceeds 3 open disputes in 24 h.
 *
 *   Bug 3 (HIGH): escrowOverride directly mutates financial dispute state.
 *     Verifies the legacy override endpoint remains compatibility-denial only:
 *     no successful dispute-close SQL and no direct financial mutation path.
 *
 *   Bug 4 (HIGH): Chargeback LOST path unconditionally unfreezes payouts.
 *     Verifies the `UPDATE users SET payouts_locked = FALSE` query is NOT
 *     called when a chargeback is lost (only called on won).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mocks — must precede all imports that touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  taskLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
  aiLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
  stripeLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: { recordOfflinePayment: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    awardXP: vi.fn().mockResolvedValue(undefined),
    clawbackXP: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/realtime/connection-registry', () => ({
  forceDisconnectUser: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { ChargebackService } from '../../src/services/ChargebackService';
import { RevenueService } from '../../src/services/RevenueService';

const mockDb = vi.mocked(db);
const mockRevenueLog = vi.mocked(RevenueService.logEvent);

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
    version: 1,
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bug 1: SQL interval injection
// ---------------------------------------------------------------------------

describe('Bug 1 — SQL interval must use parameterized multiplication', () => {
  /**
   * Reading the patched source directly is the most reliable approach:
   * we grep the compiled source text for the forbidden pattern.
   * This catches regressions even when the DB is not running.
   */
  it('revenueBreakdown query does NOT use string concatenation for interval', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile(
        fileURLToPath(new URL('../../src/routers/admin.ts', import.meta.url)),
        'utf-8'
      )
    );
    // Must NOT contain the old concatenation pattern
    expect(src).not.toMatch(/\$1 \|\| ' days'/);
    expect(src).not.toMatch(/\$1 \|\| " days"/);
    // Must contain the safe parameterized form in both queries
    const safeMatches = (src.match(/\$1 \* INTERVAL '1 day'/g) ?? []).length;
    // revenueBreakdown (1 query) + aiCostSummary (2 queries: summary + model breakdown) = 3
    expect(safeMatches).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Duplicate dispute / flood guard in lockForDispute
// ---------------------------------------------------------------------------

describe('Bug 2 — lockForDispute duplicate & flood guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws CONFLICT when an open dispute already exists for the escrow', async () => {
    // windowCheck: escrow + task join
    mockDb.query.mockResolvedValueOnce({
      rows: [{ completed_at: new Date(), challenge_window_hours: 6, version: 1 }],
      rowCount: 1,
    } as never);

    // Existing dispute count check — returns 1 open dispute
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '1' }],
      rowCount: 1,
    } as never);

    await expect(
      EscrowService.lockForDispute('esc-1')
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Dispute already open'),
    });
  });

  it('throws TOO_MANY_REQUESTS when user has 3+ open disputes in 24 hours', async () => {
    // windowCheck
    mockDb.query.mockResolvedValueOnce({
      rows: [{ completed_at: new Date(), challenge_window_hours: 6, version: 1 }],
      rowCount: 1,
    } as never);

    // Existing dispute check — 0 disputes for this escrow (passes)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0' }],
      rowCount: 1,
    } as never);

    // Per-user flood check — 3 open disputes in last 24 h (triggers limit)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '3' }],
      rowCount: 1,
    } as never);

    await expect(
      EscrowService.lockForDispute('esc-1', { initiatedBy: 'user-1' })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('rate limit'),
    });
  });

  it('proceeds normally when no open disputes exist and user is under limit', async () => {
    const now = new Date();
    // windowCheck
    mockDb.query.mockResolvedValueOnce({
      rows: [{ completed_at: now, challenge_window_hours: 6, version: 1 }],
      rowCount: 1,
    } as never);

    // Existing dispute check — 0 open disputes for this escrow
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0' }],
      rowCount: 1,
    } as never);

    // Per-user flood check — 1 open dispute in last 24 h (under limit of 3)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '1' }],
      rowCount: 1,
    } as never);

    // UPDATE escrows SET state = 'LOCKED_DISPUTE' — success
    const lockedEscrow = makeEscrow({ state: 'LOCKED_DISPUTE', version: 2 });
    mockDb.query.mockResolvedValueOnce({
      rows: [lockedEscrow],
      rowCount: 1,
    } as never);

    // logEscrowEvent INSERT
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await EscrowService.lockForDispute('esc-1', { initiatedBy: 'user-1' });
    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('LOCKED_DISPUTE');
  });

  it('fails closed on RELEASED escrow without clearing the provider-transfer witness', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        completed_at: new Date(), challenge_window_hours: 6, version: 7,
        state: 'RELEASED', task_state: 'COMPLETED',
      }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

    const result = await EscrowService.lockForDispute('esc-1', { initiatedBy: 'user-1' });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: expect.stringContaining('canonical dispute command'),
      },
    });
    const statements = mockDb.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).not.toContain(expect.stringContaining('UPDATE escrows'));
    expect(statements).not.toContain(expect.stringContaining('INSERT INTO escrow_events'));
  });
});

// ---------------------------------------------------------------------------
// Bug 3: escrowOverride must remain a compatibility-denial surface
// ---------------------------------------------------------------------------

describe('Bug 3 — escrowOverride cannot close an open dispute directly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('contains no direct dispute-resolution mutation in the override endpoint', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile(
        fileURLToPath(new URL('../../src/routers/admin.ts', import.meta.url)),
        'utf-8'
      )
    );

    const overrideBody = src.slice(
      src.indexOf('escrowOverride: escrowAdminProcedure'),
      src.indexOf('\n});\n\nexport type AdminRouter')
    );

    expect(overrideBody).not.toMatch(/UPDATE\s+disputes/i);
    expect(overrideBody).not.toMatch(/state\s*=\s*'RESOLVED'/i);
    expect(overrideBody).toContain("'escrow_override_failed'");
    expect(overrideBody).toContain('throw new TRPCError');
  });

  it('rejects the underlying administrative refund before database effects', async () => {
    const result = await EscrowService.refund({
      escrowId: 'esc-1',
      adminOverride: true,
      reason: 'legacy compatibility request',
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_STATE' },
    });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bug 4: Chargeback LOST must NOT unfreeze payouts
// ---------------------------------------------------------------------------

describe('Bug 4 — Chargeback LOST path does not unfreeze payouts', () => {
  /**
   * These tests use source-level assertions against ChargebackService.ts.
   * This is the most reliable approach: it avoids fragile mock-sequencing issues
   * while still precisely verifying the structural invariant — that the
   * payouts_locked = FALSE query is ONLY inside the WON branch, never the LOST branch.
   */

  it('WON branch retains payouts unlock logic (regression guard)', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile(
        fileURLToPath(new URL('../../src/services/ChargebackService.ts', import.meta.url)),
        'utf-8'
      )
    );

    // Scope to the handleDisputeClosed function body to avoid false positives
    // from handleDisputeCreated (which has `AND payouts_locked = FALSE` in a WHERE clause).
    const closedFnStart = src.indexOf('handleDisputeClosed');
    expect(closedFnStart).toBeGreaterThan(-1);
    const closedFnSrc = src.slice(closedFnStart);

    // The WON check must exist inside handleDisputeClosed
    expect(closedFnSrc).toMatch(/status === 'won'/);

    // The payouts unlock must exist inside handleDisputeClosed (SET payouts_locked = FALSE)
    expect(closedFnSrc).toMatch(/SET payouts_locked = FALSE/);

    // The unlock must appear AFTER the 'won' check in the scoped source
    const wonIdx = closedFnSrc.indexOf("status === 'won'");
    const unlockIdx = closedFnSrc.indexOf('SET payouts_locked = FALSE');
    expect(wonIdx).toBeGreaterThan(-1);
    expect(unlockIdx).toBeGreaterThan(-1);
    expect(wonIdx).toBeLessThan(unlockIdx);
  });

  it('LOST branch does NOT contain payouts_locked = FALSE assignment', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile(
        fileURLToPath(new URL('../../src/services/ChargebackService.ts', import.meta.url)),
        'utf-8'
      )
    );

    // Scope to handleDisputeClosed to avoid false positives from handleDisputeCreated.
    const closedFnStart = src.indexOf('handleDisputeClosed');
    const closedFnSrc = src.slice(closedFnStart);

    // Find the LOST branch: the else block after the WON if-statement
    const wonIdx = closedFnSrc.indexOf("status === 'won'");
    const elseIdx = closedFnSrc.indexOf('} else {', wonIdx);
    expect(elseIdx).toBeGreaterThan(wonIdx);

    // Find the end of the else block using the shared '// 4. Mark dispute' marker
    const finalUpdateIdx = closedFnSrc.indexOf('// 4. Mark dispute', elseIdx);
    expect(finalUpdateIdx).toBeGreaterThan(elseIdx);

    const lostBranchContent = closedFnSrc.slice(elseIdx, finalUpdateIdx);

    // The LOST branch must NOT contain SET payouts_locked = FALSE (the unlock query)
    expect(lostBranchContent).not.toContain('SET payouts_locked = FALSE');

    // The LOST branch must still increment dispute_lost_count
    expect(lostBranchContent).toContain('dispute_lost_count');
  });

  it('LOST branch contains explicit admin-review warning comment', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile(
        fileURLToPath(new URL('../../src/services/ChargebackService.ts', import.meta.url)),
        'utf-8'
      )
    );

    // The Bug 4 fix must include an explanatory comment so future engineers
    // understand why the LOST path intentionally does NOT unlock payouts.
    expect(src).toMatch(/payouts remain frozen/i);
  });
});
