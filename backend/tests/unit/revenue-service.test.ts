/**
 * RevenueService Unit Tests
 *
 * Tests ledger event logging, revenue summary, P&L reporting,
 * and financial integrity verification.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));

import { db } from '../../src/db';
import { RevenueService } from '../../src/services/RevenueService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RevenueService', () => {
  // -------------------------------------------------------------------------
  // logEvent
  // -------------------------------------------------------------------------
  describe('logEvent', () => {
    it('inserts ledger entry with V2 financial decomposition', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'rev-1' }], rowCount: 1 } as never);

      const result = await RevenueService.logEvent({
        eventType: 'platform_fee',
        userId: 'user-1',
        taskId: 'task-1',
        amountCents: 750,
        currency: 'usd',
        grossAmountCents: 5000,
        platformFeeCents: 750,
        netAmountCents: 4250,
        feeBasisPoints: 1500,
        escrowId: 'esc-1',
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.id).toBe('rev-1');
      expect(mockDb.query).toHaveBeenCalledOnce();
      expect(mockDb.query.mock.calls[0][1]).toContain('platform_fee');
    });

    it('defaults V2 fields when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'rev-2' }], rowCount: 1 } as never);

      const result = await RevenueService.logEvent({
        eventType: 'featured_listing',
        userId: 'user-1',
        amountCents: 999,
      });

      expect(result.success).toBe(true);
      // Verify defaults: currency=usd, gross=amount, fee=0, net=amount
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[4]).toBe('usd');    // currency
      expect(args[5]).toBe(999);      // grossAmountCents defaults to amountCents
      expect(args[6]).toBe(0);        // platformFeeCents defaults to 0
      expect(args[7]).toBe(999);      // netAmountCents defaults to amountCents
    });

    it('returns error on DB failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('insert failed'));

      const result = await RevenueService.logEvent({
        eventType: 'platform_fee',
        userId: 'user-1',
        amountCents: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('REVENUE_LOG_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // getRevenueSummary
  // -------------------------------------------------------------------------
  describe('getRevenueSummary', () => {
    it('returns grouped summary', async () => {
      const rows = [
        { event_type: 'platform_fee', count: '10', total_cents: '7500' },
        { event_type: 'featured_listing', count: '3', total_cents: '2997' },
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as never);

      const result = await RevenueService.getRevenueSummary(30);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].event_type).toBe('platform_fee');
      }
    });

    it('returns error on DB failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('query failed'));

      const result = await RevenueService.getRevenueSummary();
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getMonthlyPnl
  // -------------------------------------------------------------------------
  describe('getMonthlyPnl', () => {
    it('returns P&L from view', async () => {
      const rows = [{ month: '2026-02', currency: 'usd', net_revenue: '15000' }];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as never);

      const result = await RevenueService.getMonthlyPnl(12);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // verifyLedgerIntegrity
  // -------------------------------------------------------------------------
  describe('verifyLedgerIntegrity', () => {
    it('returns isBalanced=true when gross - net = fees', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          event_count: '100',
          total_gross: '500000',
          total_net: '425000',
          total_fees: '75000',
        }],
        rowCount: 1,
      } as never);

      const result = await RevenueService.verifyLedgerIntegrity();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isBalanced).toBe(true);
        expect(result.data.delta).toBe(0);
        expect(result.data.totalGross).toBe(500000);
        expect(result.data.totalFees).toBe(75000);
      }
    });

    it('returns isBalanced=false when delta is non-zero', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          event_count: '50',
          total_gross: '500000',
          total_net: '425000',
          total_fees: '74999', // Off by 1
        }],
        rowCount: 1,
      } as never);

      const result = await RevenueService.verifyLedgerIntegrity();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isBalanced).toBe(false);
        expect(result.data.delta).toBe(1);
      }
    });
  });
});
