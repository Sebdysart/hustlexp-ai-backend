import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { StripeService } from './StripeService.js';

const log = logger.child({ service: 'XPTaxService' });

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

export const XPTaxService = {
  calculateTax: (grossPayoutCents: number, paymentMethod: PaymentMethod): number => {
    if (paymentMethod === 'escrow') return 0;
    return Math.round(grossPayoutCents * 0.10);
  },

  recordOfflinePayment: async (
    userId: string,
    taskId: string,
    paymentMethod: Exclude<PaymentMethod, 'escrow'>,
    grossPayoutCents: number
  ): Promise<ServiceResult<void>> => {
    try {
      const taxPercentage = 10.0;
      const taxAmountCents = Math.round(grossPayoutCents * (taxPercentage / 100));
      const netPayoutCents = grossPayoutCents;

      await db.query(
        `INSERT INTO xp_tax_ledger (
          user_id, task_id, gross_payout_cents, tax_percentage,
          tax_amount_cents, net_payout_cents, payment_method, xp_held_back
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
        ON CONFLICT (task_id, user_id) DO NOTHING`,
        [userId, taskId, grossPayoutCents, taxPercentage, taxAmountCents, netPayoutCents, paymentMethod]
      );

      await db.query(
        `INSERT INTO user_xp_tax_status (user_id, total_unpaid_tax_cents)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET
           total_unpaid_tax_cents = user_xp_tax_status.total_unpaid_tax_cents + $2,
           last_updated_at = NOW()`,
        [userId, taxAmountCents]
      );

      log.info({ userId, taskId, taxAmountCents }, 'Recorded offline payment');
      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'recordOfflinePayment failed');
      return { success: false, error: { code: 'RECORD_OFFLINE_PAYMENT_FAILED', message: error instanceof Error ? error.message : 'Failed to record offline payment' } };
    }
  },

  checkTaxStatus: async (userId: string): Promise<ServiceResult<TaxStatus>> => {
    try {
      const result = await db.query<UserXPTaxStatus>(
        'SELECT total_unpaid_tax_cents, total_xp_held_back FROM user_xp_tax_status WHERE user_id = $1',
        [userId]
      );
      if (!result.rows[0]) {
        return { success: true, data: { unpaid_tax_cents: 0, xp_held_back: 0, blocked: false } };
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
      return { success: false, error: { code: 'CHECK_TAX_STATUS_FAILED', message: error instanceof Error ? error.message : 'Failed to check tax status' } };
    }
  },

  payTax: async (
    userId: string,
    stripePaymentIntentId: string
  ): Promise<ServiceResult<{ xp_released: number }>> => {
    try {
      if (!StripeService.isConfigured()) {
        return { success: false, error: { code: 'XP_TAX_PAYMENT_UNAVAILABLE', message: 'Stripe is not configured. Cannot process tax payment.' } };
      }

      const existingPayment = await db.query<{ id: string }>(
        `SELECT id FROM xp_tax_ledger WHERE stripe_payment_intent_id = $1 AND tax_paid = TRUE LIMIT 1`,
        [stripePaymentIntentId]
      );
      if (existingPayment.rows.length > 0) {
        log.info({ userId, stripePaymentIntentId }, 'payTax: idempotent replay');
        return { success: true, data: { xp_released: 0 } };
      }

      const piResult = await StripeService.verifyPaymentIntent(stripePaymentIntentId);

      let amountPaidCents: number;

      if (piResult.success && piResult.data) {
        if (piResult.data.status !== 'succeeded') {
          return { success: false, error: { code: 'PAYMENT_NOT_SUCCEEDED', message: `Payment intent status is "${piResult.data.status}", expected "succeeded"` } };
        }

        if (piResult.data.metadata.type !== 'xp_tax') {
          return { success: false, error: { code: 'INVALID_PAYMENT_TYPE', message: 'Payment intent is not an XP tax payment' } };
        }

        // FIX: Verify the payment intent belongs to the calling user.
        // Without this check, User A could submit User B's valid tax PI
        // to clear User A's taxes using User B's payment.
        if (piResult.data.metadata.user_id !== userId) {
          return { success: false, error: { code: 'PAYMENT_USER_MISMATCH', message: 'Payment intent does not belong to this user' } };
        }

        amountPaidCents = piResult.data.amountCents;
      } else {
        return { success: false, error: { code: 'STRIPE_VERIFICATION_FAILED', message: (piResult as { error?: { message?: string } }).error?.message ?? 'Failed to verify Stripe payment intent' } };
      }

      if (amountPaidCents <= 0) {
        return { success: true, data: { xp_released: 0 } };
      }

      const unpaidTaxes = await db.query<XPTaxLedger>(
        'SELECT * FROM xp_tax_ledger WHERE user_id = $1 AND tax_paid = FALSE ORDER BY created_at ASC',
        [userId]
      );

      let remainingPayment = amountPaidCents;
      let totalXpReleased = 0;
      let totalTaxPaid = 0;

      for (const tax of unpaidTaxes.rows) {
        if (remainingPayment >= tax.tax_amount_cents) {
          await db.query(
            `UPDATE xp_tax_ledger
             SET tax_paid = TRUE, tax_paid_at = NOW(), xp_released = TRUE, xp_released_at = NOW(), stripe_payment_intent_id = $2
             WHERE id = $1`,
            [tax.id, stripePaymentIntentId]
          );

          const xpAmount = Math.round(tax.gross_payout_cents / 10);
          await db.query(`UPDATE users SET xp_total = xp_total + $1 WHERE id = $2`, [xpAmount, userId]);

          remainingPayment -= tax.tax_amount_cents;
          totalTaxPaid += tax.tax_amount_cents;
          totalXpReleased += xpAmount;
        }
      }

      await db.query(
        `UPDATE user_xp_tax_status
         SET total_unpaid_tax_cents = GREATEST(total_unpaid_tax_cents - $1, 0),
             total_xp_held_back = GREATEST(total_xp_held_back - $2, 0),
             last_updated_at = NOW()
         WHERE user_id = $3`,
        [totalTaxPaid, totalXpReleased, userId]
      );

      log.info({ userId, totalTaxPaidCents: totalTaxPaid, xpReleased: totalXpReleased }, 'Tax payment processed');
      return { success: true, data: { xp_released: totalXpReleased } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'payTax failed');
      return { success: false, error: { code: 'PAY_TAX_FAILED', message: error instanceof Error ? error.message : 'Failed to pay tax' } };
    }
  },

  getTaxHistory: async (userId: string, limit = 20): Promise<ServiceResult<XPTaxLedger[]>> => {
    try {
      const result = await db.query<XPTaxLedger>(
        'SELECT * FROM xp_tax_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'getTaxHistory failed');
      return { success: false, error: { code: 'GET_TAX_HISTORY_FAILED', message: error instanceof Error ? error.message : 'Failed to get tax history' } };
    }
  },

  adminForgiveTax: async (userId: string, adminId: string, reason: string): Promise<ServiceResult<void>> => {
    try {
      await db.query(
        `UPDATE xp_tax_ledger SET tax_paid = TRUE, tax_paid_at = NOW() WHERE user_id = $1 AND tax_paid = FALSE`,
        [userId]
      );
      await db.query(
        `UPDATE user_xp_tax_status SET total_unpaid_tax_cents = 0, last_updated_at = NOW() WHERE user_id = $1`,
        [userId]
      );

      log.info({ adminId, userId, reason }, 'Admin forgave XP taxes');
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, target_user_id, result)
         VALUES ($1, 'admin', 'forgive_xp_taxes', $2::JSONB, $3, 'success')`,
        [adminId, JSON.stringify({ reason, userId }), userId]
      ).catch(err => log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to log admin forgive action'));

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), adminId, userId }, 'adminForgiveTax failed');
      return { success: false, error: { code: 'ADMIN_FORGIVE_FAILED', message: error instanceof Error ? error.message : 'Failed to forgive tax' } };
    }
  }
};
