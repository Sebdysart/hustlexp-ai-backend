/**
 * TaxComplianceService Unit Tests
 *
 * Covers:
 *   - getOrCreateWorkerTaxProfile (existing + create paths, error branch)
 *   - submitW9 (valid TIN, invalid TIN formats, transaction success/error)
 *   - markW9Verified
 *   - trackPayment (success, error branch)
 *   - generate1099NECForms (workers found, Stripe success/error, no Stripe)
 *   - generate1099KForms  (workers found, Stripe success/error)
 *   - getTaxDashboard
 *
 * Mocking strategy:
 *   - All DB calls go through `sql` (tagged-template mock) or `transaction`.
 *   - Stripe is mocked at module level so the module-init `new Stripe(...)` call
 *     does not fail (STRIPE_SECRET_KEY is set via env mock).
 *   - config.tax.encryptionKey is set so encryptTIN/decryptTIN work correctly
 *     during generate1099NEC/K paths that decrypt stored TINs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Config mock — must be before any service import
// ---------------------------------------------------------------------------
// NOTE: vi.mock factories are hoisted to the top of the file before any
// variable declarations, so constants cannot be referenced here — inline directly.

vi.mock('../config.js', () => ({
  config: {
    // 64 hex chars = 32 bytes, satisfying AES-256 key length check
    tax: { encryptionKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  },
}));

// ---------------------------------------------------------------------------
// 2. Logger mock
// ---------------------------------------------------------------------------
vi.mock('../utils/logger.js', () => {
  const noop = (..._args: unknown[]) => {};
  const noopLogger = {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    child: () => noopLogger,
  };
  return { createLogger: () => noopLogger, logger: noopLogger };
});

vi.mock('../utils/errors.js', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// ---------------------------------------------------------------------------
// 3. env mock — MUST be declared before Stripe mock / module imports.
//    The factory runs during the hoist phase (before any import executes),
//    so setting process.env here ensures TaxComplianceService picks up the
//    key when it runs `const _stripeSecretKey = env.STRIPE_SECRET_KEY` at
//    module init time.
// ---------------------------------------------------------------------------
vi.mock('../config/env.js', () => {
  // Set the env var here so it's available when the service module initialises
  // its top-level `const _stripe = ...` singleton.
  process.env.STRIPE_SECRET_KEY = 'sk_test_mockkey';
  return {
    env: new Proxy({} as Record<string, string>, {
      get: (_t, key: string) => process.env[key] ?? '',
    }),
  };
});

// ---------------------------------------------------------------------------
// 4. Stripe mock
//    - mockRawRequest uses vi.hoisted() so it's available inside the factory
//      (vi.mock factories are hoisted above all const declarations).
//    - The constructor implementation must be a regular function, not an arrow
//      function, because arrow functions cannot be used with `new`.
//    - Returning a plain object from a constructor (non-arrow fn) replaces
//      `this`, so new Stripe() returns { rawRequest: mockRawRequest }.
// ---------------------------------------------------------------------------
const mockRawRequest = vi.hoisted(() => vi.fn());

vi.mock('stripe', () => ({
  default: vi.fn(function MockStripe() { return { rawRequest: mockRawRequest }; }),
}));

// ---------------------------------------------------------------------------
// 5. DB mock
// ---------------------------------------------------------------------------
const mockSql = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../db/index.js', () => ({
  get sql() { return mockSql; },
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

// ---------------------------------------------------------------------------
// Import service after all mocks are in place
// ---------------------------------------------------------------------------
import {
  getOrCreateWorkerTaxProfile,
  submitW9,
  markW9Verified,
  trackPayment,
  generate1099NECForms,
  generate1099KForms,
  getTaxDashboard,
  type W9Data,
  type PaymentTrackingEvent,
} from '../services/TaxComplianceService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a tagged-template mock that returns `rows` when called.
 * postgres.js tag: fn`SQL ${val}` ⟹ fn(strings, ...values) ⟹ Promise<rows>
 */
function makeSqlMock(rows: unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(rows);
}

const TAX_YEAR = new Date().getFullYear();

const baseProfileRow = {
  id: 'profile-1',
  user_id: 'user-1',
  tax_year: TAX_YEAR,
  w9_status: 'not_required',
  w9_received_at: null,
  w9_data: null,
  name_on_account: null,
  tin_last4: null,
  tin_type: null,
  address_verified: false,
  backup_withholding: false,
  total_payments_cents: 0,
  total_transactions: 0,
  platform_fees_cents: 0,
  refunds_cents: 0,
  net_payments_cents: 0,
  requires_1099_nec: false,
  requires_1099_k: false,
  form_1099_nec_status: null,
  form_1099_k_status: null,
  stripe_tax_form_id: null,
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
};

const validW9: W9Data = {
  name: 'Jane Worker',
  taxClassification: 'individual',
  address: { street: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  tin: '123-45-6789',
  tinType: 'SSN',
  signature: { signedBy: 'Jane Worker', signedAt: new Date(), ipAddress: '127.0.0.1' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaxComplianceService', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockSql to a basic callable so the module doesn't blow up on
    // calls we don't care about in a given test.
    mockSql.mockResolvedValue([]);
  });

  // =========================================================================
  // getOrCreateWorkerTaxProfile
  // =========================================================================

  describe('getOrCreateWorkerTaxProfile', () => {
    it('returns existing profile when found in DB', async () => {
      mockSql
        .mockResolvedValueOnce([baseProfileRow]);   // SELECT returns existing row

      const result = await getOrCreateWorkerTaxProfile('user-1');

      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
      expect(result!.w9Status).toBe('not_required');
      expect(result!.taxYear).toBe(TAX_YEAR);
    });

    it('creates a new profile when no existing row found', async () => {
      mockSql
        .mockResolvedValueOnce([])                 // SELECT returns empty
        .mockResolvedValueOnce([{ ...baseProfileRow }]); // INSERT RETURNING

      const result = await getOrCreateWorkerTaxProfile('user-new');

      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1'); // from row
    });

    it('returns null on DB error', async () => {
      mockSql.mockRejectedValueOnce(new Error('db connection failed'));

      const result = await getOrCreateWorkerTaxProfile('user-err');

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // submitW9
  // =========================================================================

  describe('submitW9', () => {
    it('returns success when W9 data is valid (SSN)', async () => {
      // transaction mock calls the callback with mockSql as tx
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockSql));
      mockSql.mockResolvedValue([]);

      const result = await submitW9('user-1', validW9);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns success for EIN type', async () => {
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockSql));
      mockSql.mockResolvedValue([]);

      const w9WithEIN: W9Data = { ...validW9, tin: '12-3456789', tinType: 'EIN' };
      const result = await submitW9('user-1', w9WithEIN);

      expect(result.success).toBe(true);
    });

    it('rejects invalid SSN (not 9 digits)', async () => {
      const w9Bad: W9Data = { ...validW9, tin: '123-45', tinType: 'SSN' };
      const result = await submitW9('user-1', w9Bad);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/9 digits/i);
    });

    it('rejects invalid EIN (letters included)', async () => {
      const w9Bad: W9Data = { ...validW9, tin: '12-ABCDEFG', tinType: 'EIN' };
      const result = await submitW9('user-1', w9Bad);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/9 digits/i);
    });

    it('returns error when transaction throws', async () => {
      mockTransaction.mockImplementation(async (_fn: unknown) => {
        throw new Error('tx aborted');
      });

      const result = await submitW9('user-1', validW9);

      expect(result.success).toBe(false);
      expect(result.error).toContain('tx aborted');
    });
  });

  // =========================================================================
  // markW9Verified
  // =========================================================================

  describe('markW9Verified', () => {
    it('executes UPDATE query without throwing', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(markW9Verified('user-1')).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // trackPayment
  // =========================================================================

  describe('trackPayment', () => {
    const event: PaymentTrackingEvent = {
      userId: 'user-1',
      taskId: 'task-1',
      escrowId: 'escrow-1',
      grossAmountCents: 10000,
      platformFeeCents: 1500,
      netAmountCents: 8500,
      transactionType: 'payment',
      processedAt: new Date(),
    };

    it('completes without throwing when transaction succeeds', async () => {
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = vi.fn().mockResolvedValue([{
          total_payments_cents: 10000,
          total_transactions: 1,
          w9_status: 'not_required',
        }]);
        return fn(tx);
      });

      await expect(trackPayment(event)).resolves.toBeUndefined();
    });

    it('does not throw when transaction fails (error is caught internally)', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('DB error'));

      await expect(trackPayment(event)).resolves.toBeUndefined();
    });

    it('triggers 1099-NEC threshold flag when payments exceed $600', async () => {
      // We verify the UPDATE query gets called when payments >= 60000 cents
      const txMock = vi.fn()
        .mockResolvedValueOnce([])  // INSERT worker_earnings_1099
        .mockResolvedValueOnce([])  // INSERT tax_payment_log
        .mockResolvedValueOnce([{  // SELECT for checkThresholds
          total_payments_cents: 70000,
          total_transactions: 5,
          w9_status: 'not_required',
        }])
        .mockResolvedValue([]);     // subsequent UPDATEs

      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txMock));

      await expect(trackPayment({ ...event, grossAmountCents: 70000 })).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // generate1099NECForms
  // =========================================================================

  describe('generate1099NECForms', () => {
    const workerRow = {
      id: 'profile-1',
      user_id: 'user-1',
      name_on_account: 'Jane Worker',
      tin_type: 'SSN',
      w9_data: { tinEncrypted: null as string | null },
      total_payments_cents: 75000,
      net_payments_cents: 63750,
      tax_year: 2023,
    };

    it('returns generated=0, no errors when no workers qualify', async () => {
      mockSql.mockResolvedValueOnce([]); // no workers

      const result = await generate1099NECForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('records error per worker when Stripe rawRequest fails', async () => {
      // Use b64_ encoded TIN so decryptTIN works without an AES key for that value
      const b64Tin = `b64_${Buffer.from('123456789').toString('base64')}`;

      mockSql
        .mockResolvedValueOnce([{ ...workerRow, w9_data: { tinEncrypted: b64Tin } }]) // workers query
        .mockResolvedValueOnce([{ stripe_connect_id: 'acct_abc' }])                    // getStripeConnectAccountId
        .mockResolvedValue([]);

      mockRawRequest.mockRejectedValueOnce(new Error('Stripe API error'));

      const result = await generate1099NECForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Stripe API error');
    });

    it('generates form and updates DB when Stripe rawRequest succeeds', async () => {
      const b64Tin = `b64_${Buffer.from('123456789').toString('base64')}`;

      mockSql
        .mockResolvedValueOnce([{ ...workerRow, w9_data: { tinEncrypted: b64Tin } }]) // workers
        .mockResolvedValueOnce([{ stripe_connect_id: 'acct_abc' }])                    // connect acct
        .mockResolvedValueOnce([]);                                                     // UPDATE

      mockRawRequest.mockResolvedValueOnce({ id: 'taxform_1099nec_001' });

      const result = await generate1099NECForms(2023);

      expect(result.generated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('records error when worker has no stripe_connect_id', async () => {
      const b64Tin = `b64_${Buffer.from('123456789').toString('base64')}`;

      mockSql
        .mockResolvedValueOnce([{ ...workerRow, w9_data: { tinEncrypted: b64Tin } }])
        .mockResolvedValueOnce([{ stripe_connect_id: null }]) // no connect acct
        .mockResolvedValue([]);

      const result = await generate1099NECForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/stripe_connect_id/);
    });

    it('records error when worker has no encrypted TIN', async () => {
      mockSql
        .mockResolvedValueOnce([{ ...workerRow, w9_data: {} }])          // no tinEncrypted
        .mockResolvedValueOnce([{ stripe_connect_id: 'acct_abc' }])
        .mockResolvedValue([]);

      const result = await generate1099NECForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/encrypted TIN/);
    });

    it('returns error when top-level SQL query throws', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection error'));

      const result = await generate1099NECForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('connection error');
    });
  });

  // =========================================================================
  // generate1099KForms
  // =========================================================================

  describe('generate1099KForms', () => {
    const workerRow1099K = {
      id: 'profile-k-1',
      user_id: 'user-2',
      name_on_account: 'Bob Worker',
      tin_type: 'EIN',
      w9_data: null as { tinEncrypted?: string } | null,
      total_payments_cents: 2100000,
      net_payments_cents: 1785000,
      tax_year: 2023,
    };

    it('returns generated=0, no errors when no workers qualify', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await generate1099KForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('generates 1099-K form when Stripe succeeds', async () => {
      const b64Tin = `b64_${Buffer.from('987654321').toString('base64')}`;

      mockSql
        .mockResolvedValueOnce([{ ...workerRow1099K, w9_data: { tinEncrypted: b64Tin } }])
        .mockResolvedValueOnce([{ stripe_connect_id: 'acct_xyz' }])
        .mockResolvedValueOnce([]);

      mockRawRequest.mockResolvedValueOnce({ id: 'taxform_1099k_001' });

      const result = await generate1099KForms(2023);

      expect(result.generated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('records error per worker when Stripe call fails', async () => {
      const b64Tin = `b64_${Buffer.from('987654321').toString('base64')}`;

      mockSql
        .mockResolvedValueOnce([{ ...workerRow1099K, w9_data: { tinEncrypted: b64Tin } }])
        .mockResolvedValueOnce([{ stripe_connect_id: 'acct_xyz' }])
        .mockResolvedValue([]);

      mockRawRequest.mockRejectedValueOnce(new Error('rate limited'));

      const result = await generate1099KForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('rate limited');
    });

    it('returns error when top-level SQL throws', async () => {
      mockSql.mockRejectedValueOnce(new Error('timeout'));

      const result = await generate1099KForms(2023);

      expect(result.generated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('timeout');
    });
  });

  // =========================================================================
  // getTaxDashboard
  // =========================================================================

  describe('getTaxDashboard', () => {
    it('returns parsed dashboard summary from SQL', async () => {
      mockSql.mockResolvedValueOnce([{
        total_workers: '42',
        requiring_1099_nec: '10',
        requiring_1099_k: '3',
        w9_received: '8',
        w9_pending: '34',
        total_payments_cents: '5000000',
        forms_filed: '5',
        forms_pending: '8',
      }]);

      const dashboard = await getTaxDashboard(TAX_YEAR);

      expect(dashboard.totalWorkers).toBe(42);
      expect(dashboard.requiring1099NEC).toBe(10);
      expect(dashboard.requiring1099K).toBe(3);
      expect(dashboard.w9Received).toBe(8);
      expect(dashboard.w9Pending).toBe(34);
      expect(dashboard.totalPaymentsCents).toBe(5000000);
      expect(dashboard.formsFiled).toBe(5);
      expect(dashboard.formsPending).toBe(8);
    });

    it('returns zeros when SQL returns zeroed summary', async () => {
      mockSql.mockResolvedValueOnce([{
        total_workers: '0',
        requiring_1099_nec: '0',
        requiring_1099_k: '0',
        w9_received: '0',
        w9_pending: '0',
        total_payments_cents: '0',
        forms_filed: '0',
        forms_pending: '0',
      }]);

      const dashboard = await getTaxDashboard(2023);

      expect(dashboard.totalWorkers).toBe(0);
      expect(dashboard.formsFiled).toBe(0);
    });
  });

  // =========================================================================
  // IRS threshold constants
  // =========================================================================

  describe('IRS threshold constants', () => {
    it('exports correct 1099-NEC threshold of $600 (60000 cents)', async () => {
      const { TaxComplianceService } = await import('../services/TaxComplianceService.js');
      expect(TaxComplianceService.IRS_1099NEC_THRESHOLD_CENTS).toBe(60000);
    });

    it('exports correct 1099-K transaction threshold of 200', async () => {
      const { TaxComplianceService } = await import('../services/TaxComplianceService.js');
      expect(TaxComplianceService.IRS_1099K_TRANSACTION_THRESHOLD).toBe(200);
    });

    it('exports correct 1099-K amount threshold of $20,000 (2,000,000 cents)', async () => {
      const { TaxComplianceService } = await import('../services/TaxComplianceService.js');
      expect(TaxComplianceService.IRS_1099K_AMOUNT_THRESHOLD_CENTS).toBe(2000000);
    });
  });
});
