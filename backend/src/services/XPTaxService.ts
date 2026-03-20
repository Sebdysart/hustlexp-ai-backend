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

import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { StripeService } from './StripeService.js';

const log = logger.child({ service: 'XPTaxService' });

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

      // F46-2 FIX: Wrap both queries in a serializable transaction to prevent
      // non-atomic double-credit. Previously, two independent db.query() calls were
      // used: the first (xp_tax_ledger INSERT) had ON CONFLICT DO NOTHING for
      // idempotency, but the second (user_xp_tax_status UPDATE) always ran, even on
      // duplicate calls — double-billing total_unpaid_tax_cents for the same task.
      // Fix: both queries run atomically. Only if the ledger INSERT inserted a new row
      // (rowCount === 1) do we update the summary. Duplicate calls become true no-ops.
      await db.serializableTransaction(async (query) => {
        // Insert tax record
        const insertResult = await query(
          `INSERT INTO xp_tax_ledger (
            user_id, task_id, gross_payout_cents, tax_percentage,
            tax_amount_cents, net_payout_cents, payment_method, xp_held_back
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
          ON CONFLICT (task_id, user_id) DO NOTHING`,
          [userId, taskId, grossPayoutCents, taxPercentage, taxAmountCents, netPayoutCents, paymentMethod]
        );

        // Only update the summary if a new ledger row was actually inserted.
        // ON CONFLICT DO NOTHING sets rowCount=0 on a duplicate → skip the increment.
        if ((insertResult.rowCount ?? 0) > 0) {
          // Update summary table
          await query(
            `INSERT INTO user_xp_tax_status (user_id, total_unpaid_tax_cents)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET
               total_unpaid_tax_cents = user_xp_tax_status.total_unpaid_tax_cents + $2,
               last_updated_at = NOW()`,
            [userId, taxAmountCents]
          );
        }
      });

      log.info({ userId, taskId, taxAmountCents }, 'Recorded offline payment');

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'recordOfflinePayment failed');
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
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'checkTaxStatus failed');
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
   *
   * IDEMPOTENCY: If stripePaymentIntentId has already been recorded as a paid
   * tax entry, this call returns immediately with success to prevent double-charging
   * on network retries or iOS re-submissions of the same intent.
   */
  payTax: async (
    userId: string,
    stripePaymentIntentId: string
  ): Promise<ServiceResult<{ xp_released: number }>> => {
    try {
      // FIX: Hard-block if Stripe is not configured — never process tax payments without verification
      if (!StripeService.isConfigured()) {
        return {
          success: false,
          error: {
            code: 'XP_TAX_PAYMENT_UNAVAILABLE',
            message: 'XP_TAX_PAYMENT_UNAVAILABLE: Stripe is not configured. Cannot process tax payment.',
          },
        };
      }

      // IDEMPOTENCY CHECK: Return early only if ALL unpaid rows have been processed for
      // this payment intent — i.e. the PI is recorded AND no rows remain with tax_paid=FALSE.
      // F47-2 FIX: The old guard returned early if ANY row was marked paid with this PI,
      // which made a partially-completed loop (crash mid-FIFO) permanently irrecoverable —
      // the remaining unpaid rows could never be finished. Now we only short-circuit when
      // there are truly no remaining unpaid rows for this user.
      const existingPayment = await db.query<{ id: string }>(
        `SELECT id FROM xp_tax_ledger
         WHERE stripe_payment_intent_id = $1 AND tax_paid = TRUE
         LIMIT 1`,
        [stripePaymentIntentId]
      );
      if (existingPayment.rows.length > 0) {
        // PI was seen before — but check whether any rows are still unpaid (partial failure)
        const remainingUnpaid = await db.query<{ id: string }>(
          `SELECT id FROM xp_tax_ledger WHERE user_id = $1 AND tax_paid = FALSE LIMIT 1`,
          [userId]
        );
        if (remainingUnpaid.rows.length === 0) {
          log.info({ userId, stripePaymentIntentId }, 'payTax: idempotent replay — all rows already processed');
          return { success: true, data: { xp_released: 0 } };
        }
        // Some rows still unpaid — fall through to finish the FIFO loop
        log.info({ userId, stripePaymentIntentId }, 'payTax: idempotent replay — resuming partial FIFO loop');
      }

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

        // F46-5 FIX: Verify the payment intent belongs to the calling user.
        // Without this check, any user holding a succeeded xp_tax PaymentIntent
        // (even one created for a different user) could submit it to payTax() and
        // have their own held XP released without actually paying. The PI metadata
        // contains user_id set by createTaxPaymentIntent(), so we enforce the match.
        if (piResult.data.metadata.user_id && piResult.data.metadata.user_id !== userId) {
          return {
            success: false,
            error: {
              code: 'PAYMENT_USER_MISMATCH',
              message: 'Payment intent does not belong to this user',
            },
          };
        }

        amountPaidCents = piResult.data.amountCents;
      } else {
        // Stripe returned an error despite being configured — propagate it
        return {
          success: false,
          error: {
            code: 'STRIPE_VERIFICATION_FAILED',
            message: piResult.error?.message ?? 'Failed to verify Stripe payment intent',
          },
        };
      }

      if (amountPaidCents <= 0) {
        return { success: true, data: { xp_released: 0 } };
      }

      // F47-2 FIX: Wrap the entire FIFO loop and the summary update in a single
      // serializableTransaction so that all ledger row updates + XP awards + summary
      // decrement are applied atomically. Previously, three independent db.query()
      // calls per iteration meant a mid-loop crash left some rows paid+XP-awarded
      // and others not — with the idempotency guard making the partial state
      // irrecoverable. Now the whole loop either commits or rolls back as a unit.
      const { totalXpReleased, totalTaxPaid } = await db.serializableTransaction(async (query) => {
        // Get unpaid tax entries (FIFO order) — read inside the transaction for consistency
        const unpaidTaxes = await query<XPTaxLedger>(
          'SELECT * FROM xp_tax_ledger WHERE user_id = $1 AND tax_paid = FALSE ORDER BY created_at ASC',
          [userId]
        );

        let remainingPayment = amountPaidCents;
        let innerTotalXpReleased = 0;
        let innerTotalTaxPaid = 0;

        // Pay taxes in FIFO order
        for (const tax of unpaidTaxes.rows) {
          if (remainingPayment >= tax.tax_amount_cents) {
            // Mark tax as paid and release held XP, recording the Stripe intent ID
            // for idempotency (prevents double-charge on retry).
            await query(
              `UPDATE xp_tax_ledger
               SET tax_paid = TRUE,
                   tax_paid_at = NOW(),
                   xp_released = TRUE,
                   xp_released_at = NOW(),
                   stripe_payment_intent_id = $2
               WHERE id = $1`,
              [tax.id, stripePaymentIntentId]
            );

            // Calculate held XP to release (100 XP per $1 of gross payout)
            const xpAmount = Math.round(tax.gross_payout_cents / 10);

            // Release held XP directly to user's xp_total
            // Note: This bypasses INV-1 (no escrow) because tax XP is already earned,
            // just held back pending tax payment. We update the user directly.
            await query(
              `UPDATE users SET xp_total = xp_total + $1 WHERE id = $2`,
              [xpAmount, userId]
            );

            remainingPayment -= tax.tax_amount_cents;
            innerTotalTaxPaid += tax.tax_amount_cents;
            innerTotalXpReleased += xpAmount;
          }
        }

        // Update summary table — inside same transaction so it is always consistent
        await query(
          `UPDATE user_xp_tax_status
           SET total_unpaid_tax_cents = GREATEST(total_unpaid_tax_cents - $1, 0),
               total_xp_held_back = GREATEST(total_xp_held_back - $2, 0),
               last_updated_at = NOW()
           WHERE user_id = $3`,
          [innerTotalTaxPaid, innerTotalXpReleased, userId]
        );

        return { totalXpReleased: innerTotalXpReleased, totalTaxPaid: innerTotalTaxPaid };
      });

      log.info({ userId, totalTaxPaidCents: totalTaxPaid, xpReleased: totalXpReleased }, 'Tax payment processed');

      return { success: true, data: { xp_released: totalXpReleased } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'payTax failed');
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
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'getTaxHistory failed');
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
      // Mark all unpaid taxes as forgiven and clear the xp_held_back flag
      // F47-1 FIX: Also reset xp_held_back = FALSE so the ledger rows no longer
      // show as "held" after forgiveness. Without this, the ledger entries stayed
      // in a permanently inconsistent state (tax_paid=TRUE but xp_held_back=TRUE).
      await db.query(
        `UPDATE xp_tax_ledger
         SET tax_paid = TRUE,
             tax_paid_at = NOW(),
             xp_held_back = FALSE
         WHERE user_id = $1 AND tax_paid = FALSE`,
        [userId]
      );

      // Reset summary
      // F47-1 FIX: Also reset total_xp_held_back = 0 so dashboards and future
      // XP-blocked checks no longer see stale held-XP after forgiveness.
      await db.query(
        `UPDATE user_xp_tax_status
         SET total_unpaid_tax_cents = 0,
             total_xp_held_back = 0,
             last_updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      // Log to admin_actions audit table
      log.info({ adminId, userId, reason }, 'Admin forgave XP taxes');
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, target_user_id, result)
         VALUES ($1, 'admin', 'forgive_xp_taxes', $2::JSONB, $3, 'success')`,
        [adminId, JSON.stringify({ reason, userId }), userId]
      ).catch(err => log.error({ err: err instanceof Error ? err.message : String(err), adminId, userId }, 'Failed to log admin forgive action'));

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), adminId, userId }, 'adminForgiveTax failed');
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
