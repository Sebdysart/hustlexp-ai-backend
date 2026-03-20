/**
 * TaxReportingService Unit Tests
 *
 * Covers threshold logic, generate1099Form error paths, and
 * checkThresholdApproaching notification levels.
 *
 * Threshold: $600 = 60,000 cents (REPORTING_THRESHOLD_CENTS)
 * Notification levels: none (<80%), approaching (80-89%), near (90-99%), exceeded (>=100%)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that trigger module evaluation
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_placeholder', platformFeePercent: 15 },
    redis: { url: null },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

// Mock Stripe constructor — TaxReportingService lazily creates an instance
vi.mock('stripe', () => ({
  default: class MockStripe {
    rawRequest = vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { TaxReportingService } from '../../src/services/TaxReportingService';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal worker earnings row */
function makeWorkerRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'worker-abc',
    total_earnings_cents: 75000,
    task_count: 5,
    ...overrides,
  };
}

/** Builds a minimal tax filing row */
function makeTaxFilingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'filing-1',
    user_id: 'worker-abc',
    tax_year: 2025,
    form_type: '1099-NEC',
    total_earnings_cents: 75000,
    stripe_tax_form_id: null,
    status: 'pending',
    filed_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('TaxReportingService', () => {
  // -------------------------------------------------------------------------
  // getWorkersAboveThreshold
  // -------------------------------------------------------------------------
  describe('getWorkersAboveThreshold', () => {
    it('returns workers with earnings at or above the $600 (60000 cent) threshold', async () => {
      const workers = [
        makeWorkerRow({ user_id: 'w1', total_earnings_cents: 60000 }), // exactly at threshold
        makeWorkerRow({ user_id: 'w2', total_earnings_cents: 120000 }), // well above
      ];
      mockDb.query.mockResolvedValueOnce({ rows: workers, rowCount: 2 } as never);

      const result = await TaxReportingService.getWorkersAboveThreshold(2025);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data![0].total_earnings_cents).toBe(60000);

      // Verify the query was called with the threshold constant (60000 cents)
      // and uses net earnings (after platform fee deduction) for the 1099 threshold check.
      // The platform fee is now passed as a bound parameter ($3) from config.stripe.platformFeePercent
      // rather than hardcoded as a literal — preventing drift if the fee config changes.
      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('HAVING SUM(ROUND(e.amount * (1.0 - $3 / 100.0)))');
      expect(params).toContain(60000);
      // Third param is platformFeePercent from config (defaults to 15)
      expect(params[2]).toBe(15);
    });

    it('returns an empty array when no workers are above the threshold', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TaxReportingService.getWorkersAboveThreshold(2025);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it('returns a DB_ERROR when the query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection refused') as never);

      const result = await TaxReportingService.getWorkersAboveThreshold(2025);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('DB_ERROR');
      expect(result.error!.message).toContain('connection refused');
    });
  });

  // -------------------------------------------------------------------------
  // createTaxFiling
  // -------------------------------------------------------------------------
  describe('createTaxFiling', () => {
    it('inserts a filing and returns the created row', async () => {
      const row = makeTaxFilingRow({ user_id: 'w1', total_earnings_cents: 80000 });
      mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never);

      const result = await TaxReportingService.createTaxFiling('w1', 2025, 80000);

      expect(result.success).toBe(true);
      expect(result.data!.user_id).toBe('w1');
      expect(result.data!.status).toBe('pending');
    });

    it('returns a DB_ERROR when insert fails', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('unique violation') as never);

      const result = await TaxReportingService.createTaxFiling('w1', 2025, 80000);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('DB_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // generate1099Form — error paths (no live Stripe call needed)
  // -------------------------------------------------------------------------
  describe('generate1099Form', () => {
    it('returns NO_CONNECT_ACCOUNT when worker has no stripe_connect_id', async () => {
      // Query 1: users table — no connect id
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      } as never);

      const result = await TaxReportingService.generate1099Form('worker-no-connect', 2025);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('NO_CONNECT_ACCOUNT');
      expect(result.error!.message).toContain('no Stripe Connect account');
    });

    it('returns NO_CONNECT_ACCOUNT when user row is not found', async () => {
      // Query 1: users table — row missing entirely
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TaxReportingService.generate1099Form('ghost-user', 2025);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('NO_CONNECT_ACCOUNT');
    });

    it('returns NO_FILING when connect account exists but no filing record found', async () => {
      // Query 1: users table — has connect id
      mockDb.query.mockResolvedValueOnce({
        rows: [{ stripe_connect_id: 'acct_test_abc' }],
        rowCount: 1,
      } as never);
      // Query 2: tax_filings table — no record
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TaxReportingService.generate1099Form('worker-no-filing', 2025);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('NO_FILING');
      expect(result.error!.message).toContain('processAnnualFilings');
    });
  });

  // -------------------------------------------------------------------------
  // get1099Status
  // -------------------------------------------------------------------------
  describe('get1099Status', () => {
    it('returns filings for the given user and year', async () => {
      const filing = makeTaxFilingRow({ status: 'generated', stripe_tax_form_id: 'ftf_123' });
      mockDb.query.mockResolvedValueOnce({ rows: [filing], rowCount: 1 } as never);

      const result = await TaxReportingService.get1099Status('worker-abc', 2025);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].stripe_tax_form_id).toBe('ftf_123');
    });

    it('returns an empty array when no filings exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TaxReportingService.get1099Status('worker-abc', 2025);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it('defaults to current year when taxYear is omitted', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await TaxReportingService.get1099Status('worker-abc');

      const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe(new Date().getFullYear());
    });
  });

  // -------------------------------------------------------------------------
  // checkThresholdApproaching — notification levels
  // Threshold is 60000 cents ($600).
  // none: <80% (<48000), approaching: 80-89% (48000-53399),
  // near: 90-99% (54000-59399), exceeded: >=100% (>=60000)
  // -------------------------------------------------------------------------
  describe('checkThresholdApproaching', () => {
    function mockEarnings(cents: number) {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total_earnings_cents: String(cents) }],
        rowCount: 1,
      } as never);
    }

    it('reports "none" when earnings are well below threshold (< 80%)', async () => {
      mockEarnings(30000); // 50% of 60000

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(true);
      expect(result.data!.notificationLevel).toBe('none');
      expect(result.data!.threshold).toBe(60000);
      expect(result.data!.percentOfThreshold).toBe(50);
    });

    it('reports "approaching" when earnings are 80-89% of threshold', async () => {
      mockEarnings(48000); // exactly 80% of 60000

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(true);
      expect(result.data!.notificationLevel).toBe('approaching');
    });

    it('reports "near" when earnings are 90-99% of threshold', async () => {
      mockEarnings(54000); // exactly 90% of 60000

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(true);
      expect(result.data!.notificationLevel).toBe('near');
    });

    it('reports "exceeded" when earnings are at or above the threshold (>=100%)', async () => {
      mockEarnings(60000); // exactly $600 = 100%

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(true);
      expect(result.data!.notificationLevel).toBe('exceeded');
      expect(result.data!.totalEarnings).toBe(60000);
    });

    it('reports "exceeded" when earnings are well above the threshold', async () => {
      mockEarnings(120000); // $1200 = 200%

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(true);
      expect(result.data!.notificationLevel).toBe('exceeded');
      expect(result.data!.percentOfThreshold).toBe(200);
    });

    it('returns zero earnings and "none" level when worker has no released escrows', async () => {
      mockEarnings(0);

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(true);
      expect(result.data!.totalEarnings).toBe(0);
      expect(result.data!.notificationLevel).toBe('none');
      expect(result.data!.percentOfThreshold).toBe(0);
    });

    it('returns DB_ERROR when the query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('db down') as never);

      const result = await TaxReportingService.checkThresholdApproaching('w1', 2025);

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('DB_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // processAnnualFilings
  // -------------------------------------------------------------------------
  describe('processAnnualFilings', () => {
    it('processes all workers and returns counts', async () => {
      // getWorkersAboveThreshold query
      mockDb.query.mockResolvedValueOnce({
        rows: [
          makeWorkerRow({ user_id: 'w1' }),
          makeWorkerRow({ user_id: 'w2' }),
        ],
        rowCount: 2,
      } as never);
      // createTaxFiling for w1
      mockDb.query.mockResolvedValueOnce({
        rows: [makeTaxFilingRow({ user_id: 'w1' })],
        rowCount: 1,
      } as never);
      // createTaxFiling for w2
      mockDb.query.mockResolvedValueOnce({
        rows: [makeTaxFilingRow({ user_id: 'w2' })],
        rowCount: 1,
      } as never);

      const result = await TaxReportingService.processAnnualFilings(2025);

      expect(result.success).toBe(true);
      expect(result.data!.processed).toBe(2);
      expect(result.data!.errors).toBe(0);
    });

    it('counts errors when individual filing creation fails', async () => {
      // getWorkersAboveThreshold
      mockDb.query.mockResolvedValueOnce({
        rows: [makeWorkerRow({ user_id: 'w1' })],
        rowCount: 1,
      } as never);
      // createTaxFiling throws
      mockDb.query.mockRejectedValueOnce(new Error('insert failed') as never);

      const result = await TaxReportingService.processAnnualFilings(2025);

      expect(result.success).toBe(true);
      expect(result.data!.processed).toBe(0);
      expect(result.data!.errors).toBe(1);
    });
  });
});
