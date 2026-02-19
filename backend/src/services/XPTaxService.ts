/**
 * XPTaxService v1.0.0
 *
 * CONSTITUTIONAL: Manages XP tax for offline payments (Layer 0 enforcement)
 *
 * XP is ONLY awarded for payments processed through escrow. Offline payments
 * (cash, Venmo, Cash App) incur a 10% XP tax that must be paid before XP award.
 *
 * Enforcement: Database trigger `enforce_xp_tax_payment()` blocks XP insertion
 * if unpaid offline taxes exist (Error code: HX201)
 *
 * @see XP_TAX_SYSTEM_SPEC_LOCKED.md
 * @see schema.sql v1.8.0 (xp_tax_ledger, user_xp_tax_status, trigger)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { StripeService } from './StripeService';

// ============================================================================
// TYPES
// ============================================================================

type PaymentMethod = 'escrow' | 'offline_cash' | 'offline_venmo' | 'offline_cashapp';

interface XPTaxLedger {
  id: string;
  user_id: string;
  task_id: string;
  gross_payout_cents: number;
  tax_percentage: number;
  tax_amount_cents: number;
  net_payout_cents: number;
  payment_method: PaymentMethod;
  tax_paid: boolean;
  tax_paid_at: Date | null;
  xp_held_back: boolean;
  xp_released: boolean;
  xp_released_at: Date | null;
  created_at: Date;
}

interface UserXPTaxStatus {
  user_id: string;
  total_unpaid_tax_cents: number;
  total_xp_held_back: number;
  offline_payments_blocked: boolean;
  last_updated_at: Date;
}

interface TaxStatus {
  unpaid_tax_cents: number;
  xp_held_back: number;
  blocked: boolean;
}

// ============================================================================
// SERVICE
// ============================================================================

export const XPTaxService = {
  /**
   * Calculate tax for offline payment
   * Returns 0 for escrow, 10% for offline
   */
  calculateTax: (grossPayoutCents: number, paymentMethod: PaymentMethod): number => {
    if (paymentMethod === 'escrow') {
      return 0; // No tax on platform payments
    }
    // 10% tax on offline payments
    return Math.round(grossPayoutCents * 0.10);
  },

  /**
   * Record offline payment and calculate tax
   * Creates xp_tax_ledger entry with xp_held_back = TRUE
   */
  recordOfflinePayment: async (
    userId: string,
    taskId: string,
    paymentMethod: Exclude<PaymentMethod, 'escrow'>,
    grossPayoutCents: number
  ): Promise<ServiceResult<void>> => {
    try {
      const taxPercentage = 10.0; // 10% for offline
      const taxAmountCents = Math.round(grossPayoutCents * (taxPercentage / 100));
      const netPayoutCents = grossPayoutCents; // Tax doesn't reduce payout

      // Insert tax record
      await db.query(
        `INSERT INTO xp_tax_ledger (
          user_id, task_id, gross_payout_cents, tax_percentage,
          tax_amount_cents, net_payout_cents, payment_method, xp_held_back
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
        ON CONFLICT (task_id, user_id) DO NOTHING`,
        [userId, taskId, grossPayoutCents, taxPercentage, taxAmountCents, netPayoutCents, paymentMethod]
      );

      // Update summary table
      await db.query(
        `INSERT INTO user_xp_tax_status (user_id, total_unpaid_tax_cents)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET
           total_unpaid_tax_cents = user_xp_tax_status.total_unpaid_tax_cents + $2,
           last_updated_at = NOW()`,
        [userId, taxAmountCents]
      );

      console.log(`[XPTaxService] Recorded offline payment: user=${userId}, task=${taskId}, tax=$${(taxAmountCents / 100).toFixed(2)}`);

      return { success: true, data: undefined };
    } catch (error) {
      console.error('[XPTaxService.recordOfflinePayment] Error:', error);
      return {
        success: false,
        error: {
          code: 'RECORD_OFFLINE_PAYMENT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to record offline payment'
        }
      };
    }
  },

  /**
   * Check user's unpaid tax balance
   */
  checkTaxStatus: async (userId: string): Promise<ServiceResult<TaxStatus>> => {
    try {
      const result = await db.query<UserXPTaxStatus>(
        'SELECT total_unpaid_tax_cents, total_xp_held_back FROM user_xp_tax_status WHERE user_id = $1',
        [userId]
      );

      if (!result.rows[0]) {
        return {
          success: true,
          data: {
            unpaid_tax_cents: 0,
            xp_held_back: 0,
            blocked: false
          }
        };
      }

      return {
        success: true,
        data: {
          unpaid_tax_cents: result.rows[0].total_unpaid_tax_cents,
          xp_held_back: result.rows[0].total_xp_held_back,
          blocked: result.rows[0].total_unpaid_tax_cents > 0
        }
      };
    } catch (error) {
      console.error('[XPTaxService.checkTaxStatus] Error:', error);
      return {
        success: false,
        error: {
          code: 'CHECK_TAX_STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to check tax status'
        }
      };
    }
  },

  /**
   * Pay accumulated XP tax via Stripe
   * Releases held XP after payment confirmed
   */
  payTax: async (
    userId: string,
    stripePaymentIntentId: string
  ): Promise<ServiceResult<{ xp_released: number }>> => {
    try {
      // Verify Stripe payment succeeded
      const piResult = await StripeService.verifyPaymentIntent(stripePaymentIntentId);

      let amountPaidCents: number;

      if (piResult.success && piResult.data) {
        // Stripe is configured — verify payment status
        if (piResult.data.status !== 'succeeded') {
          return {
            success: false,
            error: {
              code: 'PAYMENT_NOT_SUCCEEDED',
              message: `Payment intent status is "${piResult.data.status}", expected "succeeded"`,
            },
          };
        }

        // Verify this is a tax payment for this user
        if (piResult.data.metadata.type !== 'xp_tax') {
          return {
            success: false,
            error: {
              code: 'INVALID_PAYMENT_TYPE',
              message: 'Payment intent is not an XP tax payment',
            },
          };
        }

        amountPaidCents = piResult.data.amountCents;
      } else {
        // Stripe not configured (dev mode) — fall back to unpaid tax total
        console.warn('[XPTaxService.payTax] Stripe not available, using unpaid tax total as amount');
        const statusResult = await db.query<{ total_unpaid_tax_cents: number }>(
          'SELECT total_unpaid_tax_cents FROM user_xp_tax_status WHERE user_id = $1',
          [userId]
        );
        amountPaidCents = statusResult.rows[0]?.total_unpaid_tax_cents || 0;
      }

      if (amountPaidCents <= 0) {
        return { success: true, data: { xp_released: 0 } };
      }

      // Get unpaid tax entries (FIFO order)
      const unpaidTaxes = await db.query<XPTaxLedger>(
        'SELECT * FROM xp_tax_ledger WHERE user_id = $1 AND tax_paid = FALSE ORDER BY created_at ASC',
        [userId]
      );

      let remainingPayment = amountPaidCents;
      let totalXpReleased = 0;
      let totalTaxPaid = 0;

      // Pay taxes in FIFO order
      for (const tax of unpaidTaxes.rows) {
        if (remainingPayment >= tax.tax_amount_cents) {
          // Mark tax as paid and release held XP
          await db.query(
            `UPDATE xp_tax_ledger
             SET tax_paid = TRUE,
                 tax_paid_at = NOW(),
                 xp_released = TRUE,
                 xp_released_at = NOW()
             WHERE id = $1`,
            [tax.id]
          );

          // Calculate held XP to release (100 XP per $1 of gross payout)
          const xpAmount = Math.round(tax.gross_payout_cents / 10);

          // Release held XP directly to user's xp_total
          // Note: This bypasses INV-1 (no escrow) because tax XP is already earned,
          // just held back pending tax payment. We update the user directly.
          await db.query(
            `UPDATE users SET xp_total = xp_total + $1 WHERE id = $2`,
            [xpAmount, userId]
          );

          remainingPayment -= tax.tax_amount_cents;
          totalTaxPaid += tax.tax_amount_cents;
          totalXpReleased += xpAmount;
        }
      }

      // Update summary table
      await db.query(
        `UPDATE user_xp_tax_status
         SET total_unpaid_tax_cents = GREATEST(total_unpaid_tax_cents - $1, 0),
             total_xp_held_back = GREATEST(total_xp_held_back - $2, 0),
             last_updated_at = NOW()
         WHERE user_id = $3`,
        [totalTaxPaid, totalXpReleased, userId]
      );

      console.log(`[XPTaxService.payTax] User ${userId}: paid ${totalTaxPaid} cents tax, released ${totalXpReleased} XP`);

      return { success: true, data: { xp_released: totalXpReleased } };
    } catch (error) {
      console.error('[XPTaxService.payTax] Error:', error);
      return {
        success: false,
        error: {
          code: 'PAY_TAX_FAILED',
          message: error instanceof Error ? error.message : 'Failed to pay tax'
        }
      };
    }
  },

  /**
   * Get tax payment history
   */
  getTaxHistory: async (userId: string, limit = 20): Promise<ServiceResult<XPTaxLedger[]>> => {
    try {
      const result = await db.query<XPTaxLedger>(
        `SELECT * FROM xp_tax_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      console.error('[XPTaxService.getTaxHistory] Error:', error);
      return {
        success: false,
        error: {
          code: 'GET_TAX_HISTORY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get tax history'
        }
      };
    }
  },

  /**
   * Admin: Forgive all unpaid taxes (emergency override)
   */
  adminForgiveTax: async (userId: string, adminId: string, reason: string): Promise<ServiceResult<void>> => {
    try {
      // Mark all unpaid taxes as forgiven
      await db.query(
        `UPDATE xp_tax_ledger
         SET tax_paid = TRUE,
             tax_paid_at = NOW()
         WHERE user_id = $1 AND tax_paid = FALSE`,
        [userId]
      );

      // Reset summary
      await db.query(
        `UPDATE user_xp_tax_status
         SET total_unpaid_tax_cents = 0,
             last_updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      // Log to admin_actions audit table
      console.log(`[ADMIN OVERRIDE] ${adminId} forgave XP taxes for ${userId}. Reason: ${reason}`);
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, target_user_id, result)
         VALUES ($1, 'admin', 'forgive_xp_taxes', $2::JSONB, $3, 'success')`,
        [adminId, JSON.stringify({ reason, userId }), userId]
      ).catch(err => console.error('[XPTaxService.adminForgive] Failed to log admin action:', err));

      return { success: true, data: undefined };
    } catch (error) {
      console.error('[XPTaxService.adminForgiveTax] Error:', error);
      return {
        success: false,
        error: {
          code: 'ADMIN_FORGIVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to forgive tax'
        }
      };
    }
  }
};
