/**
 * XPTaxService Unit Tests
 *
 * Covers adminForgiveTax (F47-1) and payTax (F47-2) bug fixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    isConfigured: vi.fn(() => true),
    verifyPaymentIntent: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { XPTaxService } from '../../src/services/XPTaxService';
import { StripeService } from '../../src/services/StripeService';

const mockDb = vi.mocked(db);
const mockStripe = vi.mocked(StripeService);

beforeEach(() => {
  vi.resetAllMocks();
  // Re-bind serializableTransaction after resetAllMocks wipes the implementation
  mockDb.serializableTransaction.mockImplementation(
    async (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query)
  );
});

// ---------------------------------------------------------------------------
// adminForgiveTax (F47-1)
// ---------------------------------------------------------------------------

describe('XPTaxService.adminForgiveTax', () => {
  it('resets total_xp_held_back = 0 as well as total_unpaid_tax_cents (F47-1)', async () => {
    // F58-2 FIX: adminForgiveTax now first SELECTs the XP sum, then credits users.xp_total,
    // then marks the ledger rows paid, then resets the summary. Updated mock sequence:
    // 1. SELECT SUM(gross_payout_cents / 10) → total XP to credit
    // 2. UPDATE users SET xp_total = xp_total + N (only if N > 0)
    // 3. UPDATE xp_tax_ledger SET tax_paid = TRUE ...
    // 4. UPDATE user_xp_tax_status SET total_unpaid_tax_cents = 0 ...
    // 5. INSERT admin_actions (fire-and-forget)
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ total_xp: 500 }], rowCount: 1 } as never) // SELECT SUM (F58-2)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE users SET xp_total (F58-2)
      .mockResolvedValueOnce({ rows: [], rowCount: 2 } as never) // UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE user_xp_tax_status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT admin_actions (fire-and-forget catch)

    const result = await XPTaxService.adminForgiveTax('user-1', 'admin-1', 'audit override');

    expect(result.success).toBe(true);

    const allSqls = mockDb.query.mock.calls.map(c => (c[0] as string));

    // Verify the xp_tax_ledger UPDATE includes xp_held_back = FALSE
    const ledgerUpdateSql = allSqls.find(sql => sql.includes('xp_tax_ledger') && sql.includes('tax_paid = TRUE'));
    expect(ledgerUpdateSql).toBeDefined();
    expect(ledgerUpdateSql).toContain('xp_held_back = FALSE');

    // Verify the user_xp_tax_status UPDATE includes total_xp_held_back = 0
    const summaryUpdateSql = allSqls.find(sql => sql.includes('user_xp_tax_status'));
    expect(summaryUpdateSql).toBeDefined();
    expect(summaryUpdateSql).toContain('total_xp_held_back = 0');
    expect(summaryUpdateSql).toContain('total_unpaid_tax_cents = 0');
  });

  it('returns error on DB failure in adminForgiveTax', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection lost'));

    const result = await XPTaxService.adminForgiveTax('user-1', 'admin-1', 'test');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('ADMIN_FORGIVE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// payTax (F47-2)
// ---------------------------------------------------------------------------

describe('XPTaxService.payTax', () => {
  it('wraps FIFO loop in serializableTransaction (F47-2)', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      // 1. Idempotency check — no existing rows with this PI
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction (all delegated to mockDb.query via the mock):
      // 2. SELECT unpaid taxes
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
        ],
        rowCount: 1,
      } as never)
      // 3. UPDATE xp_tax_ledger (mark paid)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE users (award XP)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE user_xp_tax_status (summary)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_test_123');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(500); // 5000/10

    // The FIFO loop must have run inside serializableTransaction
    expect(mockDb.serializableTransaction).toHaveBeenCalledOnce();
  });

  it('falls through idempotency guard when some rows still unpaid (partial-failure resume, F47-2)', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      // 1. Idempotency check — one row already paid (partial loop from previous attempt)
      .mockResolvedValueOnce({ rows: [{ id: 'tax-0' }], rowCount: 1 } as never)
      // 2. Remaining unpaid check — still has unpaid rows
      .mockResolvedValueOnce({ rows: [{ id: 'tax-1' }], rowCount: 1 } as never)
      // Inside serializableTransaction:
      // 3. SELECT unpaid taxes
      .mockResolvedValueOnce({
        rows: [{ id: 'tax-1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() }],
        rowCount: 1,
      } as never)
      // 4. UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. UPDATE user_xp_tax_status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_test_123');

    // Should have fallen through to process the remaining row, not returned early
    expect(result.success).toBe(true);
    expect(mockDb.serializableTransaction).toHaveBeenCalledOnce();
  });

  it('returns early (idempotent) when PI already processed AND no unpaid rows remain (F47-2)', async () => {
    mockStripe.isConfigured.mockReturnValue(true);

    mockDb.query
      // 1. Idempotency check — rows found for this PI
      .mockResolvedValueOnce({ rows: [{ id: 'tax-0' }], rowCount: 1 } as never)
      // 2. Remaining unpaid check — zero unpaid rows
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_test_already_done');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(0);

    // Must NOT have called verifyPaymentIntent or entered serializableTransaction
    expect(mockDb.serializableTransaction).not.toHaveBeenCalled();
  });

  it('returns error when Stripe is not configured', async () => {
    mockStripe.isConfigured.mockReturnValue(false);

    const result = await XPTaxService.payTax('user-1', 'pi_test');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('XP_TAX_PAYMENT_UNAVAILABLE');
  });

  it('returns error when Stripe payment status is not succeeded', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'requires_payment_method',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // Idempotency check

    const result = await XPTaxService.payTax('user-1', 'pi_test');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('PAYMENT_NOT_SUCCEEDED');
  });

  it('returns PAYMENT_NOT_OWNED when PI belongs to a different user (F51-4)', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'other-user' },
      },
    } as any);

    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // Idempotency check

    const result = await XPTaxService.payTax('user-1', 'pi_test');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('PAYMENT_NOT_OWNED');
  });

  it('returns PAYMENT_NOT_OWNED when PI metadata.user_id is absent (F51-4 fail-closed)', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax' }, // user_id absent
      },
    } as any);

    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // Idempotency check

    const result = await XPTaxService.payTax('user-1', 'pi_test');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('PAYMENT_NOT_OWNED');
  });
});

// ---------------------------------------------------------------------------
// payTax — F53-1: per-row PI idempotency inside FIFO loop
// ---------------------------------------------------------------------------

describe('XPTaxService.payTax — F53-1: per-PI per-row idempotency inside FIFO loop', () => {
  it('inserts dedup record into xp_tax_payment_intent_idempotency before awarding XP for each row (F53-1)', async () => {
    // The FIFO loop must INSERT into xp_tax_payment_intent_idempotency with ON CONFLICT DO NOTHING
    // before processing each tax row. Only proceed if rowCount === 1.
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 1000,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      // 1. Outer idempotency check — no existing rows
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes (two rows)
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
          { id: 'tax-2', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
        ],
        rowCount: 2,
      } as never)
      // 3. Dedup INSERT for tax-1 — row inserted (rowCount=1) → proceed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE xp_tax_ledger for tax-1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users XP for tax-1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. Dedup INSERT for tax-2 — row inserted (rowCount=1) → proceed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 7. UPDATE xp_tax_ledger for tax-2
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 8. UPDATE users XP for tax-2
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 9. UPDATE user_xp_tax_status (summary)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_test_dedup');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(1000); // 2 * (5000/10)

    // Must have entered serializableTransaction
    expect(mockDb.serializableTransaction).toHaveBeenCalledOnce();

    // Verify the dedup INSERT was issued for each row (calls 3 and 6 in mock sequence)
    // Call indices (0-based): 0=outer idempotency, rest inside tx via mockDb.query
    // calls[1]=SELECT unpaid, calls[2]=dedup tax-1, calls[3]=UPDATE ledger tax-1,
    // calls[4]=UPDATE users tax-1, calls[5]=dedup tax-2, calls[6]=UPDATE ledger tax-2,
    // calls[7]=UPDATE users tax-2, calls[8]=summary update
    const allSqls = mockDb.query.mock.calls.map(c => (c[0] as string).toLowerCase());
    const dedupInserts = allSqls.filter(sql => sql.includes('xp_tax_payment_intent_idempotency'));
    expect(dedupInserts.length).toBe(2); // one per row
    dedupInserts.forEach(sql => {
      expect(sql).toContain('on conflict');
      expect(sql).toContain('do nothing');
    });
  });

  // ---------------------------------------------------------------------------
  // F54-1: summary UPDATE must use COUNT(*) with xp_held_back = true, not SUM
  // ---------------------------------------------------------------------------
  it('summary UPDATE uses COUNT(*) + xp_held_back = true, not SUM(xp_held_back) > 0 (F54-1)', async () => {
    // PostgreSQL cannot SUM a boolean column. The subquery must use COUNT(*) with
    // WHERE xp_held_back = true instead of SUM(xp_held_back) WHERE xp_held_back > 0.
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      // 1. Outer idempotency check — no existing rows
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
        ],
        rowCount: 1,
      } as never)
      // 3. Dedup INSERT — new row
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE xp_tax_ledger (mark paid)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users (award XP)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. UPDATE user_xp_tax_status (summary)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_f54_count_test');

    expect(result.success).toBe(true);

    // Find the summary UPDATE call — it's the last query call
    const allSqls = mockDb.query.mock.calls.map(c => (c[0] as string));
    const summaryUpdateSql = allSqls.find(sql =>
      sql.toLowerCase().includes('update user_xp_tax_status')
    );
    expect(summaryUpdateSql).toBeDefined();

    // Must NOT use SUM(xp_held_back) — that crashes on boolean columns
    expect(summaryUpdateSql).not.toMatch(/SUM\s*\(\s*xp_held_back\s*\)/i);
    // Must NOT use boolean > 0 comparison — invalid in PostgreSQL for booleans
    expect(summaryUpdateSql).not.toMatch(/xp_held_back\s*>\s*0/i);

    // Must use COUNT(*) with xp_held_back = true (valid boolean comparison)
    expect(summaryUpdateSql).toMatch(/COUNT\s*\(\s*\*\s*\)/i);
    expect(summaryUpdateSql).toMatch(/xp_held_back\s*=\s*true/i);
  });

  it('skips XP award when dedup INSERT returns rowCount=0 (already processed row — retry guard, F53-1)', async () => {
    // Simulate transaction retry: the dedup table already has an entry for this PI+row
    // → INSERT ON CONFLICT DO NOTHING → rowCount=0 → skip XP award for that row
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      // 1. Outer idempotency check — no existing paid rows for this PI
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
        ],
        rowCount: 1,
      } as never)
      // 3. Dedup INSERT — conflict (already processed in a prior attempt) → rowCount=0 → skip
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // 4. UPDATE user_xp_tax_status (summary — still runs)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_test_already_processed');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(0); // skipped — dedup fired

    // Must NOT have called UPDATE users (XP award) — dedup blocked it
    const updateUsersCalls = mockDb.query.mock.calls.filter(c =>
      (c[0] as string).toLowerCase().includes('update users')
    );
    expect(updateUsersCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F58-1: payTax idempotency check must include user_id filter
// ---------------------------------------------------------------------------

describe('XPTaxService.payTax — F58-1: idempotency guard must filter by user_id', () => {
  it('idempotency check SQL includes AND user_id = $2 to prevent cross-user PI reuse (F58-1)', async () => {
    // The idempotency check query must include user_id in the WHERE clause.
    // Without it, a PI used by user A can short-circuit payTax for user B.
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-b' },
      },
    } as any);

    mockDb.query
      // 1. Idempotency check — no existing rows for this PI + user-b combination
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-b1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
        ],
        rowCount: 1,
      } as never)
      // 3. Dedup INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. UPDATE user_xp_tax_status (summary)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await XPTaxService.payTax('user-b', 'pi_originally_from_user_a');

    // The FIRST db.query call is the idempotency check — verify its SQL and params
    const idempotencyCall = mockDb.query.mock.calls[0];
    const idempotencySql = idempotencyCall[0] as string;
    const idempotencyParams = idempotencyCall[1] as unknown[];

    // SQL must reference user_id in the WHERE clause
    expect(idempotencySql.toLowerCase()).toContain('user_id');
    // The second parameter must be the userId (user-b)
    expect(idempotencyParams[1]).toBe('user-b');
  });

  it('user B proceeds to process their rows even when a PI was already used by user A (F58-1)', async () => {
    // Scenario: pi_shared was already used by user-a (row in xp_tax_ledger with that PI).
    // User B calls payTax with the same PI.
    // With the bug (no user_id filter): idempotency check returns a row → short-circuit → user B gets xp_released=0 without paying
    // With the fix (user_id = $2): idempotency check finds 0 rows for user-b → falls through → Stripe is verified
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        // PI metadata belongs to user-b legitimately
        metadata: { type: 'xp_tax', user_id: 'user-b' },
      },
    } as any);

    mockDb.query
      // 1. Idempotency check for (pi_shared, user-b): 0 rows → NOT a replay for user-b
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes for user-b
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-b1', tax_amount_cents: 500, gross_payout_cents: 5000, created_at: new Date() },
        ],
        rowCount: 1,
      } as never)
      // 3. Dedup INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. UPDATE user_xp_tax_status (summary)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-b', 'pi_shared');

    // Must have entered the FIFO loop and processed user-b's rows
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(500); // 5000/10
    expect(mockDb.serializableTransaction).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// F58-2: adminForgiveTax must credit users.xp_total with forgiven XP
// ---------------------------------------------------------------------------

describe('XPTaxService.adminForgiveTax — F58-2: must credit users.xp_total with forgiven XP', () => {
  it('calls UPDATE users SET xp_total = xp_total + $1 after forgiving taxes (F58-2)', async () => {
    // adminForgiveTax must:
    // 1. SELECT SUM(xp_amount) or equivalent to find XP to release
    // 2. UPDATE users SET xp_total = xp_total + <sum> WHERE id = userId
    // 3. UPDATE xp_tax_ledger SET tax_paid = TRUE ...
    // 4. UPDATE user_xp_tax_status SET total_unpaid_tax_cents = 0 ...
    // Currently steps 1-2 are missing — this test verifies they are added.
    mockDb.query
      // 1. SELECT SUM of XP to forgive (inside serializableTransaction)
      .mockResolvedValueOnce({ rows: [{ total_xp: 750 }], rowCount: 1 } as never) // SELECT SUM
      // 2. UPDATE users SET xp_total = xp_total + 750
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 3. UPDATE xp_tax_ledger SET tax_paid = TRUE ...
      .mockResolvedValueOnce({ rows: [], rowCount: 2 } as never)
      // 4. UPDATE user_xp_tax_status SET total_unpaid_tax_cents = 0 ...
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. INSERT admin_actions (fire-and-forget)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.adminForgiveTax('user-1', 'admin-1', 'audit override');

    expect(result.success).toBe(true);

    // Verify UPDATE users SET xp_total was called
    const allSqls = mockDb.query.mock.calls.map(c => (c[0] as string).toLowerCase());
    const updateUsersXpCall = allSqls.find(sql =>
      sql.includes('update users') && sql.includes('xp_total')
    );
    expect(updateUsersXpCall).toBeDefined();
    expect(updateUsersXpCall).toContain('xp_total = xp_total +');
  });

  it('credits the correct XP sum derived from ledger rows to users.xp_total (F58-2)', async () => {
    // The XP credited must come from a SELECT SUM/calculation of the forgiven rows.
    // Verify that the parameter passed to the UPDATE users query equals the summed XP.
    mockDb.query
      // 1. SELECT SUM returns total_xp = 1200
      .mockResolvedValueOnce({ rows: [{ total_xp: 1200 }], rowCount: 1 } as never)
      // 2. UPDATE users SET xp_total = xp_total + 1200
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 3. UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 3 } as never)
      // 4. UPDATE user_xp_tax_status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. INSERT admin_actions
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await XPTaxService.adminForgiveTax('user-1', 'admin-1', 'test');

    // Find the UPDATE users call and check the XP parameter
    const updateUserCall = mockDb.query.mock.calls.find(c => {
      const sql = (c[0] as string).toLowerCase();
      return sql.includes('update users') && sql.includes('xp_total');
    });
    expect(updateUserCall).toBeDefined();
    const params = updateUserCall![1] as unknown[];
    // First param should be the XP amount (1200)
    expect(params[0]).toBe(1200);
    // Second param should be the userId
    expect(params[1]).toBe('user-1');
  });
});

// ---------------------------------------------------------------------------
// F61-3: payTax sets xp_held_back = FALSE on paid rows
// ---------------------------------------------------------------------------

describe('XPTaxService.payTax — F61-3: xp_held_back cleared to FALSE when tax is paid', () => {
  it('F61-3: the xp_tax_ledger UPDATE in the FIFO loop includes xp_held_back = FALSE', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 500,
        metadata: { type: 'xp_tax', user_id: 'user-1' },
      },
    } as any);

    mockDb.query
      // 1. Idempotency check — no existing rows with this PI
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes (one row with xp_held_back=TRUE)
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-1', tax_amount_cents: 500, gross_payout_cents: 5000, xp_held_back: true, created_at: new Date() },
        ],
        rowCount: 1,
      } as never)
      // 3. Dedup INSERT into xp_tax_payment_intent_idempotency (rowCount=1 → proceed)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE xp_tax_ledger SET tax_paid=TRUE, xp_held_back=FALSE, xp_released=TRUE ...
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users SET xp_total = xp_total + N
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. UPDATE user_xp_tax_status (summary reconciliation)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-1', 'pi_test_f61_3');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(500); // 5000/10

    // Find the UPDATE xp_tax_ledger call and verify xp_held_back = FALSE is present.
    // Note: the outer idempotency check also queries xp_tax_ledger with tax_paid = TRUE,
    // so we filter specifically for UPDATE (not SELECT) statements.
    const ledgerUpdateCall = mockDb.query.mock.calls.find(call => {
      const sql = (call[0] as string).trimStart();
      return sql.startsWith('UPDATE xp_tax_ledger') && sql.includes('tax_paid = TRUE');
    });
    expect(ledgerUpdateCall).toBeDefined();
    const ledgerSql = ledgerUpdateCall![0] as string;
    expect(ledgerSql).toContain('xp_held_back = FALSE');
  });

  it('F61-3: xp_held_back = FALSE appears on each row in a multi-row FIFO loop', async () => {
    mockStripe.isConfigured.mockReturnValue(true);
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 1000,
        metadata: { type: 'xp_tax', user_id: 'user-2' },
      },
    } as any);

    mockDb.query
      // 1. Outer idempotency check — no existing rows
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // Inside serializableTransaction:
      // 2. SELECT unpaid taxes (two rows)
      .mockResolvedValueOnce({
        rows: [
          { id: 'tax-a', tax_amount_cents: 500, gross_payout_cents: 5000, xp_held_back: true, created_at: new Date('2026-01-01') },
          { id: 'tax-b', tax_amount_cents: 500, gross_payout_cents: 5000, xp_held_back: true, created_at: new Date('2026-01-02') },
        ],
        rowCount: 2,
      } as never)
      // 3. Dedup INSERT for tax-a (rowCount=1)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 4. UPDATE xp_tax_ledger for tax-a
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 5. UPDATE users XP for tax-a
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 6. Dedup INSERT for tax-b (rowCount=1)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 7. UPDATE xp_tax_ledger for tax-b
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 8. UPDATE users XP for tax-b
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 9. UPDATE user_xp_tax_status (summary)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await XPTaxService.payTax('user-2', 'pi_multi_row');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.xp_released).toBe(1000); // 2 rows × 500 XP

    // All xp_tax_ledger UPDATE calls must include xp_held_back = FALSE.
    // Filter specifically for UPDATE (not SELECT) to avoid matching the outer
    // idempotency check which also queries xp_tax_ledger with tax_paid = TRUE.
    const ledgerUpdateCalls = mockDb.query.mock.calls.filter(call => {
      const sql = (call[0] as string).trimStart();
      return sql.startsWith('UPDATE xp_tax_ledger') && sql.includes('tax_paid = TRUE');
    });
    expect(ledgerUpdateCalls.length).toBe(2);
    for (const call of ledgerUpdateCalls) {
      expect(call[0] as string).toContain('xp_held_back = FALSE');
    }
  });
});
