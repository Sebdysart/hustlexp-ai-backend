import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
import { db } from '../../src/db';
import { ChargebackService } from '../../src/services/ChargebackService';
const mockDb = vi.mocked(db);
beforeEach(() => { mockDb.query.mockReset(); });
  describe('getPlatformDisputeRate', () => {
    // Note: getPlatformDisputeRate uses Promise.all([calc(30), calc(90)]).
    // With Promise.all, both calc functions start simultaneously. The actual
    // db.query call order is: charges30, charges90, disputes30, disputes90,
    // then the loss classification query. Use argument-based dispatch to avoid
    // interleaving issues.
    function stubPlatformCalcCalls(
      charges30: number, disputes30: number,
      charges90: number, disputes90: number,
      lossRows: Array<{ loss_type: string; total: string }> = []
    ) {
      mockDb.query.mockImplementation((sql: string, params?: unknown[]) => {
        // Loss classification query (no params, or after 4 count queries)
        if (typeof sql === 'string' && sql.includes('revenue_ledger')) {
          return Promise.resolve({ rows: lossRows, rowCount: lossRows.length });
        }
        // escrows COUNT queries → charges
        if (typeof sql === 'string' && sql.includes('escrows')) {
          const days = Array.isArray(params) ? params[0] : 0;
          const count = days === 30 ? charges30 : charges90;
          return Promise.resolve({ rows: [{ count: String(count) }], rowCount: 1 });
        }
        // payment_disputes COUNT queries → disputes
        if (typeof sql === 'string' && sql.includes('payment_disputes')) {
          const days = Array.isArray(params) ? params[0] : 0;
          const count = days === 30 ? disputes30 : disputes90;
          return Promise.resolve({ rows: [{ count: String(count) }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    }

    it('returns HEALTHY riskLevel when rate is very low', async () => {
      stubPlatformCalcCalls(1000, 1, 5000, 5);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('HEALTHY');
        expect(result.data.window30d.rate).toBeCloseTo(0.001);
      }
    });

    it('returns WARNING riskLevel at 0.6%-0.75%', async () => {
      // 6 disputes per 1000 charges = 0.6%
      stubPlatformCalcCalls(1000, 7, 5000, 35);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('WARNING');
      }
    });

    it('returns MONITORING riskLevel at 0.75%-1%', async () => {
      // 8 per 1000 = 0.8%
      stubPlatformCalcCalls(1000, 8, 5000, 40);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('MONITORING');
      }
    });

    it('returns HIGH riskLevel at 1%-2%', async () => {
      // 15 per 1000 = 1.5%
      stubPlatformCalcCalls(1000, 15, 5000, 75);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('HIGH');
      }
    });

    it('returns CRITICAL riskLevel above 2%', async () => {
      // 25 per 1000 = 2.5%
      stubPlatformCalcCalls(1000, 25, 5000, 125);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('CRITICAL');
      }
    });

    it('correctly maps platform_loss and payout_blocked from ledger', async () => {
      stubPlatformCalcCalls(1000, 1, 5000, 5, [
        { loss_type: 'platform_loss', total: '150000' },
        { loss_type: 'payout_blocked', total: '75000' },
      ]);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platformLossCents).toBe(150000);
        expect(result.data.payoutBlockedCents).toBe(75000);
      }
    });

    it('handles zero charges — returns 0 rate', async () => {
      stubPlatformCalcCalls(0, 0, 0, 0);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.rate).toBe(0);
        expect(result.data.window30d.riskLevel).toBe('HEALTHY');
      }
    });

    it('returns PLATFORM_DISPUTE_RATE_FAILED on DB error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PLATFORM_DISPUTE_RATE_FAILED');
      }
    });
  });
