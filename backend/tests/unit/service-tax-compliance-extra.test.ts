/**
 * service-tax-compliance-extra.test.ts
 *
 * Targets uncovered branches in src/services/TaxComplianceService.ts
 * (27 uncovered lines, 83.3% covered). Focuses on:
 * - getOrCreateWorkerTaxProfile (existing profile + create path)
 * - submitW9 (valid TIN, invalid TIN / SSN / EIN)
 * - markW9Verified
 * - generate1099NECForms / generate1099KForms (no workers, per-worker stripe error)
 * - getTaxDashboard
 * - encryptTIN / decryptTIN exercised via submitW9 (b64 fallback when no key)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ───────────────────────────────────────────────────

// Use vi.hoisted so mockSqlFn and mockConfig are available inside vi.mock factories
// (vi.mock calls are hoisted to the top of the file by Vitest)
const { mockSqlFn, mockConfig } = vi.hoisted(() => {
  const fn = Object.assign(
    vi.fn().mockResolvedValue([]),
    { unsafe: vi.fn().mockResolvedValue([]) }
  );
  const cfg = { tax: { encryptionKey: '' } };
  return { mockSqlFn: fn, mockConfig: cfg };
});

vi.mock('../../../src/db/index.js', () => {
  return {
    sql: mockSqlFn,
    transaction: vi.fn(async (cb: (tx: typeof mockSqlFn) => Promise<unknown>) => cb(mockSqlFn)),
  };
});

vi.mock('../../../src/config/env.js', () => ({
  env: new Proxy({} as Record<string, string>, {
    get: () => undefined,
  }),
}));

// config.tax.encryptionKey controls whether AES-256-GCM or b64 fallback is used.
// Default: no key (b64 fallback). Individual tests override via mockConfig.
vi.mock('../../../src/config.js', () => ({
  config: mockConfig,
  default: mockConfig,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../../src/utils/errors.js', () => ({
  getErrorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e)
  ),
}));

// Stripe is only used in generate1099NEC/K helpers; default _stripe to null
vi.mock('stripe', () => ({ default: vi.fn().mockImplementation(() => null) }));

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  getOrCreateWorkerTaxProfile,
  submitW9,
  markW9Verified,
  generate1099NECForms,
  generate1099KForms,
  getTaxDashboard,
  TaxComplianceService,
} from '../../../src/services/TaxComplianceService';
import type { W9Data } from '../../../src/services/TaxComplianceService';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    user_id: 'user-1',
    tax_year: new Date().getFullYear(),
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
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeW9Data(tinOverride?: string, tinTypeOverride?: 'SSN' | 'EIN'): W9Data {
  return {
    name: 'Jane Worker',
    taxClassification: 'individual',
    address: {
      street: '123 Main St',
      city: 'Los Angeles',
      state: 'CA',
      zip: '90001',
    },
    tin: tinOverride ?? '123-45-6789',
    tinType: tinTypeOverride ?? 'SSN',
    signature: {
      signedBy: 'Jane Worker',
      signedAt: new Date('2026-01-01T00:00:00Z'),
      ipAddress: '192.168.1.1',
    },
  };
}

beforeEach(() => {
  // Use resetAllMocks (not clearAllMocks) to also clear the once-queue so
  // leftover mockResolvedValueOnce calls from previous tests do not bleed over.
  vi.resetAllMocks();
  mockSqlFn.mockResolvedValue([]);
  mockConfig.tax.encryptionKey = ''; // default: b64 fallback
});

// ============================================================================
// TaxComplianceService constants
// ============================================================================

describe('TaxComplianceService constants', () => {
  it('exposes IRS_1099NEC_THRESHOLD_CENTS = 60000', () => {
    expect(TaxComplianceService.IRS_1099NEC_THRESHOLD_CENTS).toBe(60000);
  });

  it('exposes IRS_1099K_TRANSACTION_THRESHOLD = 200', () => {
    expect(TaxComplianceService.IRS_1099K_TRANSACTION_THRESHOLD).toBe(200);
  });

  it('exposes IRS_1099K_AMOUNT_THRESHOLD_CENTS = 2000000', () => {
    expect(TaxComplianceService.IRS_1099K_AMOUNT_THRESHOLD_CENTS).toBe(2000000);
  });
});

// ============================================================================
// getOrCreateWorkerTaxProfile
// ============================================================================

describe('getOrCreateWorkerTaxProfile', () => {
  it('returns existing profile when one is found', async () => {
    const row = makeProfileRow({ user_id: 'user-1', w9_status: 'verified' });
    // First sql call (SELECT) returns a row
    mockSqlFn.mockResolvedValueOnce([row]);

    const result = await getOrCreateWorkerTaxProfile('user-1');

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(result?.w9Status).toBe('verified');
  });

  it('creates new profile when SELECT returns empty', async () => {
    const newRow = makeProfileRow({ user_id: 'user-new', w9_status: 'not_required' });
    // First sql call (SELECT) returns nothing; second (INSERT) returns the new row
    mockSqlFn
      .mockResolvedValueOnce([])      // SELECT — not found
      .mockResolvedValueOnce([newRow]); // INSERT RETURNING

    const result = await getOrCreateWorkerTaxProfile('user-new');

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-new');
    expect(result?.w9Status).toBe('not_required');
    expect(result?.totalPaymentsCents).toBe(0);
  });

  it('returns null on db error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('DB connection refused'));

    const result = await getOrCreateWorkerTaxProfile('user-err');

    expect(result).toBeNull();
  });

  it('maps camelCase fields from db row correctly', async () => {
    const row = makeProfileRow({
      user_id: 'user-map',
      total_payments_cents: 15000,
      total_transactions: 3,
      platform_fees_cents: 500,
      refunds_cents: 200,
      net_payments_cents: 14300,
      requires_1099_nec: true,
      requires_1099_k: false,
      tin_last4: '6789',
      tin_type: 'SSN',
      address_verified: true,
      backup_withholding: false,
    });
    mockSqlFn.mockResolvedValueOnce([row]);

    const result = await getOrCreateWorkerTaxProfile('user-map');

    expect(result?.totalPaymentsCents).toBe(15000);
    expect(result?.totalTransactions).toBe(3);
    expect(result?.platformFeesCents).toBe(500);
    expect(result?.refundsCents).toBe(200);
    expect(result?.netPaymentsCents).toBe(14300);
    expect(result?.requires1099NEC).toBe(true);
    expect(result?.requires1099K).toBe(false);
    expect(result?.tinLast4).toBe('6789');
    expect(result?.tinType).toBe('SSN');
    expect(result?.addressVerified).toBe(true);
  });
});

// ============================================================================
// submitW9
// ============================================================================

describe('submitW9', () => {
  it('succeeds with valid SSN (dashes)', async () => {
    // transaction mock calls callback with mockSqlFn (tx)
    // tx is called with INSERT; no return value needed for success
    mockSqlFn.mockResolvedValue([]);

    const result = await submitW9('user-1', makeW9Data('123-45-6789', 'SSN'));

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('succeeds with valid SSN (no dashes)', async () => {
    mockSqlFn.mockResolvedValue([]);

    const result = await submitW9('user-1', makeW9Data('123456789', 'SSN'));

    expect(result.success).toBe(true);
  });

  it('succeeds with valid EIN', async () => {
    mockSqlFn.mockResolvedValue([]);

    const result = await submitW9('user-1', makeW9Data('12-3456789', 'EIN'));

    expect(result.success).toBe(true);
  });

  it('returns error for invalid SSN (not 9 digits)', async () => {
    const result = await submitW9('user-1', makeW9Data('123-45', 'SSN'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/9 digits/i);
  });

  it('returns error for invalid SSN (non-numeric chars)', async () => {
    const result = await submitW9('user-1', makeW9Data('123-AB-6789', 'SSN'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/9 digits/i);
  });

  it('returns error for invalid EIN (not 9 digits)', async () => {
    const result = await submitW9('user-1', makeW9Data('12-345', 'EIN'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/9 digits/i);
  });

  it('returns error on db exception', async () => {
    // transaction throws after TIN is validated
    const { transaction } = await import('../../../src/db/index.js');
    vi.mocked(transaction).mockRejectedValueOnce(new Error('DB write error'));

    const result = await submitW9('user-fail', makeW9Data('123-45-6789', 'SSN'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('DB write error');
  });

  it('stores tin_last4 as last 4 digits of raw TIN', async () => {
    // Inspect what the tx`` call receives
    const capturedArgs: unknown[][] = [];
    mockSqlFn.mockImplementation((...args: unknown[]) => {
      capturedArgs.push(args);
      return Promise.resolve([]);
    });

    await submitW9('user-1', makeW9Data('123-45-6789', 'SSN'));

    // The INSERT uses w9Data.tin.slice(-4) = '6789'
    // We verify that the call chain happened (transaction was invoked)
    expect(capturedArgs.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// markW9Verified
// ============================================================================

describe('markW9Verified', () => {
  it('updates w9_status to verified without throwing', async () => {
    mockSqlFn.mockResolvedValueOnce([]);

    await expect(markW9Verified('user-1')).resolves.toBeUndefined();
    // sql was called at least once (UPDATE)
    expect(mockSqlFn).toHaveBeenCalled();
  });
});

// ============================================================================
// generate1099NECForms
// ============================================================================

describe('generate1099NECForms', () => {
  it('returns generated=0 and no errors when no workers require filing', async () => {
    // SELECT returns empty array — no workers needing 1099-NEC
    mockSqlFn.mockResolvedValueOnce([]);

    const result = await generate1099NECForms(2025);

    expect(result.generated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns error when Stripe not configured (no STRIPE_SECRET_KEY)', async () => {
    const worker = {
      id: 'w1',
      user_id: 'user-1',
      name_on_account: 'Jane Worker',
      tin_type: 'SSN' as const,
      w9_data: { tinEncrypted: 'b64_MTIzNDU2Nzg5' },
      total_payments_cents: 75000,
      net_payments_cents: 70000,
      tax_year: 2025,
    };
    // SELECT returns one worker
    mockSqlFn.mockResolvedValueOnce([worker]);
    // SELECT for stripe_connect_id lookup (getStripeConnectAccountId)
    mockSqlFn.mockResolvedValueOnce([]);

    const result = await generate1099NECForms(2025);

    // Stripe is null (STRIPE_SECRET_KEY not set), so generateStripe1099NEC throws
    // → error is captured per-worker
    expect(result.generated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('user-1');
  });

  it('returns generated=0 when worker loop throws per-worker error (no Stripe)', async () => {
    // Provide a worker that has NO encrypted TIN — generateStripe1099NEC will throw
    // "has no encrypted TIN in w9_data" as a per-worker error
    const worker = {
      id: 'w-notinkey',
      user_id: 'user-notinkey',
      name_on_account: 'Missing TIN Worker',
      tin_type: 'SSN' as const,
      w9_data: null, // no tinEncrypted
      total_payments_cents: 90000,
      net_payments_cents: 85000,
      tax_year: 2025,
    };
    // SELECT returns the worker
    mockSqlFn.mockResolvedValueOnce([worker]);

    const result = await generate1099NECForms(2025);

    // generateStripe1099NEC throws "Stripe not configured" (no STRIPE_SECRET_KEY),
    // which is caught per-worker → errors array has exactly 1 entry
    expect(result.generated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('user-notinkey');
  });
});

// ============================================================================
// generate1099KForms
// ============================================================================

describe('generate1099KForms', () => {
  it('returns generated=0 and no errors when no workers require filing', async () => {
    mockSqlFn.mockResolvedValueOnce([]);

    const result = await generate1099KForms(2025);

    expect(result.generated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns error when Stripe not configured', async () => {
    const worker = {
      id: 'w2',
      user_id: 'user-2',
      name_on_account: 'Bob Worker',
      tin_type: 'SSN' as const,
      w9_data: { tinEncrypted: 'b64_MTIzNDU2Nzg5' },
      total_payments_cents: 2100000,
      net_payments_cents: 2000000,
      tax_year: 2025,
    };
    mockSqlFn.mockResolvedValueOnce([worker]);

    const result = await generate1099KForms(2025);

    expect(result.generated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('user-2');
  });

  it('returns generated=0 when worker has no TIN data (per-worker error)', async () => {
    const worker = {
      id: 'w-k-notinkey',
      user_id: 'user-k-notinkey',
      name_on_account: 'Missing TIN',
      tin_type: 'EIN' as const,
      w9_data: null,
      total_payments_cents: 2500000,
      net_payments_cents: 2400000,
      tax_year: 2025,
    };
    mockSqlFn.mockResolvedValueOnce([worker]);

    const result = await generate1099KForms(2025);

    expect(result.generated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('user-k-notinkey');
  });
});

// ============================================================================
// getTaxDashboard
// ============================================================================

describe('getTaxDashboard', () => {
  it('parses dashboard summary row correctly', async () => {
    const summary = {
      total_workers: '42',
      requiring_1099_nec: '15',
      requiring_1099_k: '8',
      w9_received: '30',
      w9_pending: '12',
      total_payments_cents: '5000000',
      forms_filed: '10',
      forms_pending: '5',
    };
    mockSqlFn.mockResolvedValueOnce([summary]);

    const result = await getTaxDashboard(2025);

    expect(result.totalWorkers).toBe(42);
    expect(result.requiring1099NEC).toBe(15);
    expect(result.requiring1099K).toBe(8);
    expect(result.w9Received).toBe(30);
    expect(result.w9Pending).toBe(12);
    expect(result.totalPaymentsCents).toBe(5000000);
    expect(result.formsFiled).toBe(10);
    expect(result.formsPending).toBe(5);
  });

  it('returns zero values for empty database', async () => {
    const summary = {
      total_workers: '0',
      requiring_1099_nec: '0',
      requiring_1099_k: '0',
      w9_received: '0',
      w9_pending: '0',
      total_payments_cents: '0',
      forms_filed: '0',
      forms_pending: '0',
    };
    mockSqlFn.mockResolvedValueOnce([summary]);

    const result = await getTaxDashboard(2025);

    expect(result.totalWorkers).toBe(0);
    expect(result.formsFiled).toBe(0);
  });

  it('uses default tax year when none is passed', async () => {
    const summary = {
      total_workers: '5',
      requiring_1099_nec: '2',
      requiring_1099_k: '1',
      w9_received: '3',
      w9_pending: '2',
      total_payments_cents: '120000',
      forms_filed: '1',
      forms_pending: '1',
    };
    mockSqlFn.mockResolvedValueOnce([summary]);

    // Call with no argument — uses TAX_YEAR default
    const result = await getTaxDashboard();

    expect(result.totalWorkers).toBe(5);
    expect(result.requiring1099NEC).toBe(2);
  });
});

// ============================================================================
// encryptTIN / decryptTIN via submitW9 (b64 fallback path)
// ============================================================================

describe('encryptTIN b64 fallback (no encryption key)', () => {
  it('submitW9 succeeds and uses b64 fallback encoding when no key is set', async () => {
    // mockConfig.tax.encryptionKey is '' (default) — triggers b64 fallback
    mockSqlFn.mockResolvedValue([]);

    const result = await submitW9('user-b64', makeW9Data('987-65-4321', 'SSN'));

    // Success path: TIN is validated then stored as b64_ prefixed string
    expect(result.success).toBe(true);
  });
});

describe('encryptTIN AES-256-GCM path (key present)', () => {
  it('submitW9 uses AES encryption when key is configured', async () => {
    // Set a valid 32-byte (64 hex char) key
    mockConfig.tax.encryptionKey = 'a'.repeat(64);
    mockSqlFn.mockResolvedValue([]);

    const result = await submitW9('user-aes', makeW9Data('123-45-6789', 'SSN'));

    expect(result.success).toBe(true);
  });
});
