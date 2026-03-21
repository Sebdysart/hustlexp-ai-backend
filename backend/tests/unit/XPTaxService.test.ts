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
    // 1. UPDATE xp_tax_ledger
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 2 } as never) // UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE user_xp_tax_status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT admin_actions (fire-and-forget catch)

    const result = await XPTaxService.adminForgiveTax('user-1', 'admin-1', 'audit override');

    expect(result.success).toBe(true);

    // Verify the xp_tax_ledger UPDATE includes xp_held_back = FALSE
    const ledgerUpdateCall = mockDb.query.mock.calls[0];
    const ledgerSql = ledgerUpdateCall[0] as string;
    expect(ledgerSql).toContain('xp_held_back = FALSE');

    // Verify the user_xp_tax_status UPDATE includes total_xp_held_back = 0
    const summaryUpdateCall = mockDb.query.mock.calls[1];
    const summarySql = summaryUpdateCall[0] as string;
    expect(summarySql).toContain('total_xp_held_back = 0');
    expect(summarySql).toContain('total_unpaid_tax_cents = 0');
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
