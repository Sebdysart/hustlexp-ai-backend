import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

/** Read-only historical dispute reporting; no processor event handlers. */
export const ChargebackService = {
  getPlatformDisputeRate: async (): Promise<ServiceResult<{
    window30d: { charges: number; disputes: number; rate: number; riskLevel: string };
    window90d: { charges: number; disputes: number; rate: number; riskLevel: string };
    platformLossCents: number;
    payoutBlockedCents: number;
  }>> => {
    try {
      const calc = async (days: number) => {
        const charges = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM escrows WHERE funded_at > NOW() - make_interval(days => $1)`,
          [days]
        );
        const disputes = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM payment_disputes WHERE created_at > NOW() - make_interval(days => $1)`,
          [days]
        );
        const c = parseInt(charges.rows[0].count, 10);
        const d = parseInt(disputes.rows[0].count, 10);
        const rate = c > 0 ? d / c : 0;
        const riskLevel = rate > 0.02 ? 'CRITICAL'
                        : rate > 0.01 ? 'HIGH'
                        : rate > 0.0075 ? 'MONITORING'
                        : rate > 0.006 ? 'WARNING'
                        : 'HEALTHY';
        return { charges: c, disputes: d, rate, riskLevel };
      };

      const [w30, w90] = await Promise.all([calc(30), calc(90)]);

      // Loss classification from ledger metadata
      const lossQuery = await db.query<{ loss_type: string; total: string }>(
        `SELECT
           metadata->>'loss_type' as loss_type,
           COALESCE(SUM(ABS(amount_cents)), 0) as total
         FROM revenue_ledger
         WHERE event_type = 'chargeback'
         GROUP BY metadata->>'loss_type'`
      );

      let platformLossCents = 0;
      let payoutBlockedCents = 0;
      for (const row of lossQuery.rows) {
        if (row.loss_type === 'platform_loss') platformLossCents = parseInt(row.total, 10);
        if (row.loss_type === 'payout_blocked') payoutBlockedCents = parseInt(row.total, 10);
      }

      return {
        success: true,
        data: {
          window30d: w30,
          window90d: w90,
          platformLossCents,
          payoutBlockedCents,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PLATFORM_DISPUTE_RATE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};
export default ChargebackService;
