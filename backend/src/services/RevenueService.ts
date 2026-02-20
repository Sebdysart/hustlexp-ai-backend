/**
 * RevenueService v2.0.0
 *
 * Unified revenue tracking via the revenue_ledger table.
 * Logs all monetization events with full financial decomposition:
 * gross/net/fee/currency/escrow_id/stripe_event_id/stripe_charge_id.
 *
 * v2.0.0 changes:
 * - logEvent now accepts gross_amount_cents, platform_fee_cents, net_amount_cents
 * - logEvent now accepts fee_basis_points, escrow_id, stripe_event_id, stripe_charge_id, currency
 * - Every ledger entry is self-contained: P&L can be replayed from ledger alone
 *
 * @see revenue_ledger_v2.sql (v2 schema migration)
 * @see profitability_fixes.sql (original table)
 * @see hardening_invariants.sql (append-only triggers: HX701, HX702)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { logger } from '../logger';

const log = logger.child({ service: 'RevenueService' });

// ============================================================================
// TYPES
// ============================================================================

export type RevenueEventType =
  | 'platform_fee'
  | 'featured_listing'
  | 'skill_verification'
  | 'insurance_premium'
  | 'subscription'
  | 'xp_tax'
  | 'per_task_fee'
  | 'referral_payout'
  | 'chargeback'            // Negative entry: Stripe dispute loss
  | 'chargeback_reversal';  // Positive entry: Dispute won, funds recovered

interface LogEventParams {
  eventType: RevenueEventType;
  userId: string;
  taskId?: string;
  amountCents: number; // positive = revenue, negative = payout/loss

  // === V2 FIELDS: Financial decomposition ===
  currency?: string;             // ISO 4217 (default: 'usd')
  grossAmountCents?: number;     // Total amount before fees
  platformFeeCents?: number;     // Platform fee component (>= 0)
  netAmountCents?: number;       // Amount after fees
  feeBasisPoints?: number;       // Fee rate in basis points (1500 = 15%)
  stripeProcessingFeeCents?: number; // Stripe's processing fee (from balance_transaction)

  // === V2 FIELDS: Cross-references ===
  escrowId?: string;             // Related escrow UUID
  stripeEventId?: string;        // Stripe event that triggered this entry
  stripeChargeId?: string;       // Stripe charge ID

  // === V1 FIELDS: Existing Stripe references ===
  stripePaymentIntentId?: string;
  stripeSubscriptionId?: string;
  stripeTransferId?: string;

  metadata?: Record<string, unknown>;
}

interface RevenueSummaryRow {
  event_type: string;
  count: string;
  total_cents: string;
}

interface PnlRow {
  month: string;
  currency: string;
  platform_fee_revenue: string;
  featured_revenue: string;
  skill_verification_revenue: string;
  insurance_revenue: string;
  subscription_revenue: string;
  per_task_fee_revenue: string;
  xp_tax_revenue: string;
  chargeback_losses: string;
  chargeback_recoveries: string;
  referral_payouts: string;
  net_revenue: string;
  total_events: string;
  total_gmv_cents: string;
  dispute_count: string;
  dispute_won_count: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const RevenueService = {
  /**
   * Log a revenue event to the unified ledger.
   *
   * V2: Now includes financial decomposition (gross/net/fee) and
   * cross-references (escrow_id, stripe_event_id, stripe_charge_id).
   *
   * For platform_fee events:
   *   grossAmountCents = task price (what the poster paid)
   *   platformFeeCents = our cut (15%)
   *   netAmountCents = worker payout (gross - fee)
   *   amountCents = platformFeeCents (revenue line item)
   *
   * For simple revenue events (featured, subscription, etc.):
   *   grossAmountCents = amountCents (what was charged)
   *   platformFeeCents = 0
   *   netAmountCents = amountCents (100% revenue)
   *   amountCents = what was charged
   */
  logEvent: async (params: LogEventParams): Promise<ServiceResult<{ id: string }>> => {
    try {
      const result = await db.query<{ id: string }>(
        `INSERT INTO revenue_ledger
           (event_type, user_id, task_id, amount_cents,
            currency, gross_amount_cents, platform_fee_cents, net_amount_cents,
            fee_basis_points, stripe_processing_fee_cents,
            escrow_id, stripe_event_id, stripe_charge_id,
            stripe_payment_intent_id, stripe_subscription_id, stripe_transfer_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [
          params.eventType,
          params.userId,
          params.taskId || null,
          params.amountCents,
          params.currency || 'usd',
          params.grossAmountCents ?? params.amountCents,  // Default: gross = amount
          params.platformFeeCents ?? 0,                    // Default: no fee
          params.netAmountCents ?? params.amountCents,     // Default: net = amount
          params.feeBasisPoints ?? null,
          params.stripeProcessingFeeCents ?? null,         // Populated from balance_transaction
          params.escrowId || null,
          params.stripeEventId || null,
          params.stripeChargeId || null,
          params.stripePaymentIntentId || null,
          params.stripeSubscriptionId || null,
          params.stripeTransferId || null,
          JSON.stringify(params.metadata || {}),
        ]
      );

      return { success: true, data: { id: result.rows[0].id } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), eventType: params.eventType }, 'Failed to log event');
      return {
        success: false,
        error: {
          code: 'REVENUE_LOG_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get revenue summary grouped by event type for the last N days.
   */
  getRevenueSummary: async (
    days: number = 30
  ): Promise<ServiceResult<RevenueSummaryRow[]>> => {
    try {
      const result = await db.query<RevenueSummaryRow>(
        `SELECT event_type, COUNT(*) as count, SUM(amount_cents) as total_cents
         FROM revenue_ledger
         WHERE created_at > NOW() - make_interval(days => $1)
         GROUP BY event_type
         ORDER BY total_cents DESC`,
        [days]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), days }, 'Failed to get revenue summary');
      return {
        success: false,
        error: {
          code: 'REVENUE_QUERY_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get monthly P&L report from the ledger alone.
   * No joins to escrows, tasks, or Stripe — proves ledger self-sufficiency.
   */
  getMonthlyPnl: async (
    months: number = 12
  ): Promise<ServiceResult<PnlRow[]>> => {
    try {
      const result = await db.query<PnlRow>(
        `SELECT * FROM revenue_pnl_monthly
         WHERE month > NOW() - make_interval(months => $1)
         ORDER BY month DESC`,
        [months]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), months }, 'Failed to get monthly P&L');
      return {
        success: false,
        error: {
          code: 'REVENUE_PNL_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Financial integrity check: verify SUM(gross) - SUM(net) = SUM(platform_fee)
   * for platform_fee events. Returns delta — should be 0.
   */
  verifyLedgerIntegrity: async (): Promise<ServiceResult<{
    platformFeeEvents: number;
    totalGross: number;
    totalNet: number;
    totalFees: number;
    grossMinusNet: number;
    delta: number;
    isBalanced: boolean;
  }>> => {
    try {
      const result = await db.query<{
        event_count: string;
        total_gross: string;
        total_net: string;
        total_fees: string;
      }>(
        `SELECT
           COUNT(*) as event_count,
           COALESCE(SUM(gross_amount_cents), 0) as total_gross,
           COALESCE(SUM(net_amount_cents), 0) as total_net,
           COALESCE(SUM(platform_fee_cents), 0) as total_fees
         FROM revenue_ledger
         WHERE event_type = 'platform_fee'
           AND gross_amount_cents IS NOT NULL`
      );

      const row = result.rows[0];
      const totalGross = parseInt(row.total_gross, 10);
      const totalNet = parseInt(row.total_net, 10);
      const totalFees = parseInt(row.total_fees, 10);
      const grossMinusNet = totalGross - totalNet;
      const delta = grossMinusNet - totalFees;

      return {
        success: true,
        data: {
          platformFeeEvents: parseInt(row.event_count, 10),
          totalGross,
          totalNet,
          totalFees,
          grossMinusNet,
          delta,
          isBalanced: delta === 0,
        },
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Ledger integrity check failed');
      return {
        success: false,
        error: {
          code: 'INTEGRITY_CHECK_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

export default RevenueService;
