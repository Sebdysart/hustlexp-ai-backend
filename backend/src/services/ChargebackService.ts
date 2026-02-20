/**
 * ChargebackService v1.0.0
 *
 * Handles Stripe payment dispute lifecycle:
 * - charge.dispute.created → record + reverse ledger + freeze payouts + downgrade trust
 * - charge.dispute.updated → update status
 * - charge.dispute.closed → resolve (won: reverse the reversal + unfreeze; lost: permanent)
 *
 * Principles:
 * - All state changes are idempotent (keyed on stripe_dispute_id)
 * - All financial mutations are append-only (compensating entries, never edits)
 * - DB NOW() is authoritative for timestamps
 * - Stripe event_id is traced on every record for audit
 *
 * @see chargeback_lifecycle.sql (payment_disputes table)
 * @see RevenueService (ledger append)
 */

import { db } from '../db';
import { RevenueService } from './RevenueService';
import type { ServiceResult } from '../types';
import { stripeLogger } from '../logger';

const log = stripeLogger.child({ service: 'ChargebackService' });

// ============================================================================
// TYPES
// ============================================================================

interface DisputeCreatedParams {
  stripeDisputeId: string;
  stripeChargeId: string;
  stripePaymentIntentId: string | null;
  stripeEventId: string;
  amountCents: number;
  currency: string;
  reason: string | null;
}

interface DisputeUpdatedParams {
  stripeDisputeId: string;
  stripeEventId: string;
  status: string;
  reason: string | null;
}

interface DisputeClosedParams {
  stripeDisputeId: string;
  stripeEventId: string;
  status: 'won' | 'lost';
  reason: string | null;
}

interface PaymentDispute {
  id: string;
  stripe_dispute_id: string;
  stripe_charge_id: string;
  user_id: string | null;
  escrow_id: string | null;
  task_id: string | null;
  amount_cents: number;
  status: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const ChargebackService = {
  /**
   * Handle charge.dispute.created
   *
   * Steps:
   * 1. Find related user/escrow/task from stripe_payment_intent_id or stripe_charge_id
   * 2. Insert payment_disputes record (idempotent on stripe_dispute_id)
   * 3. Insert negative revenue_ledger entry (chargeback)
   * 4. Freeze user payouts
   * 5. Increment dispute counter
   * 6. Downgrade trust tier if threshold exceeded
   */
  handleDisputeCreated: async (
    params: DisputeCreatedParams
  ): Promise<ServiceResult<{ paymentDisputeId: string }>> => {
    const {
      stripeDisputeId,
      stripeChargeId,
      stripePaymentIntentId,
      stripeEventId,
      amountCents,
      currency,
      reason,
    } = params;

    try {
      // 1. Resolve HustleXP references from Stripe IDs
      let userId: string | null = null;
      let escrowId: string | null = null;
      let taskId: string | null = null;
      let escrowState: string | null = null;

      if (stripePaymentIntentId) {
        // Try to find escrow by payment intent
        const escrowResult = await db.query<{
          id: string;
          task_id: string;
          state: string;
        }>(
          `SELECT id, task_id, state FROM escrows
           WHERE stripe_payment_intent_id = $1`,
          [stripePaymentIntentId]
        );

        if (escrowResult.rows.length > 0) {
          escrowId = escrowResult.rows[0].id;
          taskId = escrowResult.rows[0].task_id;
          escrowState = escrowResult.rows[0].state;

          // Get poster (the person who paid)
          const taskResult = await db.query<{ poster_id: string }>(
            `SELECT poster_id FROM tasks WHERE id = $1`,
            [taskId]
          );
          if (taskResult.rows.length > 0) {
            userId = taskResult.rows[0].poster_id;
          }
        }
      }

      // Fallback: find user by stripe_customer_id from the charge metadata
      // (Stripe includes customer in the dispute object)
      if (!userId) {
        // Try featured_listings, skill_verifications, insurance_subscriptions
        // via stripe_payment_intent_id
        if (stripePaymentIntentId) {
          const featureResult = await db.query<{ user_id: string }>(
            `SELECT user_id FROM featured_listings
             WHERE stripe_payment_intent_id = $1 LIMIT 1`,
            [stripePaymentIntentId]
          );
          if (featureResult.rows.length > 0) {
            userId = featureResult.rows[0].user_id;
          }
        }
      }

      // 2. Insert payment_disputes record (idempotent on stripe_dispute_id)
      const insertResult = await db.query<{ id: string }>(
        `INSERT INTO payment_disputes (
           stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id,
           stripe_event_id, user_id, escrow_id, task_id,
           amount_cents, currency, reason, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')
         ON CONFLICT (stripe_dispute_id) DO NOTHING
         RETURNING id`,
        [
          stripeDisputeId,
          stripeChargeId,
          stripePaymentIntentId,
          stripeEventId,
          userId,
          escrowId,
          taskId,
          amountCents,
          currency,
          reason,
        ]
      );

      // Already processed → idempotent exit
      if (insertResult.rowCount === 0) {
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM payment_disputes WHERE stripe_dispute_id = $1`,
          [stripeDisputeId]
        );
        return {
          success: true,
          data: { paymentDisputeId: existing.rows[0]?.id || 'already_processed' },
        };
      }

      const paymentDisputeId = insertResult.rows[0].id;

      // 3. Insert negative revenue_ledger entry (chargeback loss)
      // Classify loss: if escrow already RELEASED, platform eats the loss.
      // If escrow still FUNDED, payout is blocked — no platform loss.
      const lossType = escrowState === 'RELEASED' ? 'platform_loss'
                     : escrowState === 'FUNDED' ? 'payout_blocked'
                     : escrowState ? 'escrow_' + escrowState.toLowerCase()
                     : 'no_escrow';

      const ledgerResult = await RevenueService.logEvent({
        eventType: 'chargeback',
        userId: userId || '00000000-0000-0000-0000-000000000000', // system user fallback
        taskId: taskId || undefined,
        amountCents: -amountCents, // NEGATIVE = loss
        // V2: Financial decomposition
        currency: currency || 'usd',
        grossAmountCents: -amountCents,
        platformFeeCents: 0,
        netAmountCents: -amountCents,
        feeBasisPoints: 0,
        escrowId: escrowId || undefined,
        stripeEventId: stripeEventId,
        stripeChargeId: stripeChargeId,
        stripePaymentIntentId: stripePaymentIntentId || undefined,
        metadata: {
          stripe_dispute_id: stripeDisputeId,
          stripe_charge_id: stripeChargeId,
          reason,
          payment_dispute_id: paymentDisputeId,
          currency,
          loss_type: lossType,       // platform_loss | payout_blocked | no_escrow
          escrow_state: escrowState,  // snapshot at dispute time
        },
      });

      // Link reversal ledger entry to payment dispute
      if (ledgerResult.success) {
        await db.query(
          `UPDATE payment_disputes
           SET reversal_ledger_id = $2, reversal_amount_cents = $3
           WHERE id = $1`,
          [paymentDisputeId, ledgerResult.data.id, amountCents]
        );
      }

      // 4. Freeze user payouts (if user identified)
      if (userId) {
        await db.query(
          `UPDATE users
           SET payouts_locked = TRUE,
               payouts_locked_at = NOW(),
               payouts_locked_reason = $2,
               dispute_count = COALESCE(dispute_count, 0) + 1,
               last_dispute_at = NOW()
           WHERE id = $1
             AND payouts_locked = FALSE`,
          [userId, `Chargeback: ${stripeDisputeId} (${reason || 'unknown'})`]
        );

        // Update payment dispute to record the freeze
        await db.query(
          `UPDATE payment_disputes SET payouts_were_frozen = TRUE WHERE id = $1`,
          [paymentDisputeId]
        );

        // 5. Downgrade trust tier if dispute_count >= 2
        const userResult = await db.query<{
          trust_tier: number;
          dispute_count: number;
        }>(
          `SELECT trust_tier, dispute_count FROM users WHERE id = $1`,
          [userId]
        );

        if (userResult.rows.length > 0) {
          const { trust_tier, dispute_count } = userResult.rows[0];

          // Downgrade rules:
          // 1st dispute: freeze only, no tier change
          // 2nd dispute: drop 1 tier
          // 3rd+ dispute: drop to tier 1
          let newTier = trust_tier;
          if (dispute_count >= 3) {
            newTier = 1;
          } else if (dispute_count >= 2 && trust_tier > 1) {
            newTier = trust_tier - 1;
          }

          if (newTier !== trust_tier) {
            await db.query(
              `UPDATE users SET trust_tier = $2 WHERE id = $1`,
              [userId, newTier]
            );

            // Record in trust_ledger for audit
            await db.query(
              `INSERT INTO trust_ledger (
                 user_id, old_tier, new_tier, reason, reason_details,
                 changed_by, idempotency_key, event_source, source_event_id
               )
               VALUES ($1, $2, $3, $4, $5, 'system', $6, 'chargeback', $7)
               ON CONFLICT (idempotency_key) DO NOTHING`,
              [
                userId,
                trust_tier,
                newTier,
                `Trust downgrade: ${dispute_count} chargebacks`,
                JSON.stringify({
                  stripe_dispute_id: stripeDisputeId,
                  dispute_count,
                  previous_tier: trust_tier,
                }),
                `chargeback:${stripeDisputeId}:trust_downgrade`,
                stripeEventId,
              ]
            );

            // Update payment dispute to record the downgrade
            await db.query(
              `UPDATE payment_disputes
               SET trust_was_downgraded = TRUE, previous_trust_tier = $2
               WHERE id = $1`,
              [paymentDisputeId, trust_tier]
            );
          }
        }
      }

      // 6. Lock related escrow if it's still FUNDED (not yet released)
      if (escrowId) {
        await db.query(
          `UPDATE escrows
           SET state = 'LOCKED_DISPUTE'
           WHERE id = $1 AND state = 'FUNDED'`,
          [escrowId]
        );
      }

      log.info(
        { stripeDisputeId, amountCents, userId: userId || 'unknown', escrowId: escrowId || 'none', paymentDisputeId },
        'Chargeback processed'
      );

      return { success: true, data: { paymentDisputeId } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), stripeDisputeId }, 'handleDisputeCreated failed');
      return {
        success: false,
        error: {
          code: 'CHARGEBACK_PROCESSING_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Handle charge.dispute.updated
   *
   * Updates the status of an existing payment dispute.
   * No financial mutations — just status tracking.
   */
  handleDisputeUpdated: async (
    params: DisputeUpdatedParams
  ): Promise<ServiceResult<{ updated: boolean }>> => {
    const { stripeDisputeId, stripeEventId, status, reason } = params;

    try {
      // Map Stripe dispute status to our status enum
      const mappedStatus = mapStripeDisputeStatus(status);

      const result = await db.query(
        `UPDATE payment_disputes
         SET status = $2,
             reason = COALESCE($3, reason),
             updated_at = NOW()
         WHERE stripe_dispute_id = $1
           AND status NOT IN ('won', 'lost', 'closed')`,
        [stripeDisputeId, mappedStatus, reason]
      );

      if (result.rowCount === 0) {
        log.info(
          { stripeDisputeId },
          'Dispute update skipped (not found or already terminal)'
        );
        return { success: true, data: { updated: false } };
      }

      log.info({ stripeDisputeId, status: mappedStatus }, 'Dispute updated');
      return { success: true, data: { updated: true } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), stripeDisputeId }, 'handleDisputeUpdated failed');
      return {
        success: false,
        error: {
          code: 'CHARGEBACK_UPDATE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Handle charge.dispute.closed
   *
   * If WON:
   * 1. Insert positive revenue_ledger entry (chargeback_reversal)
   * 2. Unlock payouts (if no other open disputes)
   * 3. Mark dispute as 'won'
   *
   * If LOST:
   * 1. Keep negative ledger entry (loss is permanent)
   * 2. Increment dispute_lost_count
   * 3. Keep payouts locked (if other open disputes exist) or unlock
   * 4. Mark dispute as 'lost'
   */
  handleDisputeClosed: async (
    params: DisputeClosedParams
  ): Promise<ServiceResult<{ resolved: boolean }>> => {
    const { stripeDisputeId, stripeEventId, status, reason } = params;

    try {
      // Fetch the dispute record
      const disputeResult = await db.query<PaymentDispute>(
        `SELECT id, stripe_dispute_id, stripe_charge_id, user_id, escrow_id,
                task_id, amount_cents, status
         FROM payment_disputes
         WHERE stripe_dispute_id = $1`,
        [stripeDisputeId]
      );

      if (disputeResult.rows.length === 0) {
        log.info({ stripeDisputeId }, 'Dispute close skipped (not found)');
        return { success: true, data: { resolved: false } };
      }

      const dispute = disputeResult.rows[0];

      // Already resolved → idempotent
      if (['won', 'lost', 'closed'].includes(dispute.status)) {
        return { success: true, data: { resolved: false } };
      }

      if (status === 'won') {
        // === DISPUTE WON: We keep the money ===

        // 1. Insert positive reversal entry in ledger
        await RevenueService.logEvent({
          eventType: 'chargeback_reversal',
          userId: dispute.user_id || '00000000-0000-0000-0000-000000000000',
          taskId: dispute.task_id || undefined,
          amountCents: dispute.amount_cents, // POSITIVE = reversal of loss
          // V2: Financial decomposition
          currency: 'usd',
          grossAmountCents: dispute.amount_cents,
          platformFeeCents: 0,
          netAmountCents: dispute.amount_cents,
          feeBasisPoints: 0,
          escrowId: dispute.escrow_id || undefined,
          stripeEventId: stripeEventId,
          stripeChargeId: dispute.stripe_charge_id,
          metadata: {
            stripe_dispute_id: stripeDisputeId,
            stripe_charge_id: dispute.stripe_charge_id,
            payment_dispute_id: dispute.id,
            resolution: 'won',
          },
        });

        // 2. Unlock payouts if no OTHER open disputes
        if (dispute.user_id) {
          const otherOpenDisputes = await db.query<{ count: string }>(
            `SELECT COUNT(*) as count FROM payment_disputes
             WHERE user_id = $1
               AND id != $2
               AND status NOT IN ('won', 'lost', 'closed')`,
            [dispute.user_id, dispute.id]
          );

          if (parseInt(otherOpenDisputes.rows[0].count, 10) === 0) {
            await db.query(
              `UPDATE users
               SET payouts_locked = FALSE,
                   payouts_locked_at = NULL,
                   payouts_locked_reason = NULL
               WHERE id = $1`,
              [dispute.user_id]
            );
          }
        }

        log.info({ stripeDisputeId, amountCents: dispute.amount_cents, resolution: 'won' }, 'Dispute won - funds recovered');
      } else {
        // === DISPUTE LOST: Money is gone ===

        // 1. Negative ledger entry already exists from creation — no new entry needed
        // 2. Increment lost count
        if (dispute.user_id) {
          await db.query(
            `UPDATE users
             SET dispute_lost_count = COALESCE(dispute_lost_count, 0) + 1
             WHERE id = $1`,
            [dispute.user_id]
          );

          // 3. Unlock payouts if no OTHER open disputes (even on loss, we don't perma-lock)
          const otherOpenDisputes = await db.query<{ count: string }>(
            `SELECT COUNT(*) as count FROM payment_disputes
             WHERE user_id = $1
               AND id != $2
               AND status NOT IN ('won', 'lost', 'closed')`,
            [dispute.user_id, dispute.id]
          );

          if (parseInt(otherOpenDisputes.rows[0].count, 10) === 0) {
            await db.query(
              `UPDATE users
               SET payouts_locked = FALSE,
                   payouts_locked_at = NULL,
                   payouts_locked_reason = NULL
               WHERE id = $1`,
              [dispute.user_id]
            );
          }
        }

        log.warn({ stripeDisputeId, amountCents: dispute.amount_cents, resolution: 'lost' }, 'Dispute lost - funds lost permanently');
      }

      // 4. Mark dispute as resolved
      await db.query(
        `UPDATE payment_disputes
         SET status = $2,
             resolved_at = NOW(),
             resolution_stripe_event_id = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [dispute.id, status, stripeEventId]
      );

      return { success: true, data: { resolved: true } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), stripeDisputeId }, 'handleDisputeClosed failed');
      return {
        success: false,
        error: {
          code: 'CHARGEBACK_CLOSE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get dispute rate for a user.
   * Stripe threshold: > 0.75% = monitoring, > 1% = restrictions.
   */
  getDisputeRate: async (
    userId: string
  ): Promise<ServiceResult<{
    totalCharges: number;
    totalDisputes: number;
    disputeRate: number;
    isAtRisk: boolean;
  }>> => {
    try {
      // Count total charges (escrows funded) for this user in last 90 days
      const chargeResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.poster_id = $1
           AND e.funded_at > NOW() - INTERVAL '90 days'`,
        [userId]
      );

      const disputeResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_disputes
         WHERE user_id = $1
           AND created_at > NOW() - INTERVAL '90 days'`,
        [userId]
      );

      const totalCharges = parseInt(chargeResult.rows[0].count, 10);
      const totalDisputes = parseInt(disputeResult.rows[0].count, 10);
      const disputeRate = totalCharges > 0 ? totalDisputes / totalCharges : 0;

      return {
        success: true,
        data: {
          totalCharges,
          totalDisputes,
          disputeRate,
          isAtRisk: disputeRate > 0.0075, // 0.75% Stripe threshold
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DISPUTE_RATE_QUERY_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Platform-level dispute rate.
   * Stripe monitors the PLATFORM dispute ratio, not individual users.
   * Thresholds: > 0.60% = warning, > 0.75% = monitoring, > 1.0% = restrictions, > 2.0% = termination risk
   *
   * Returns 30-day and 90-day rolling rates with loss classification.
   */
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

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Map Stripe dispute status to our internal status.
 * Stripe statuses: warning_needs_response, warning_under_review, warning_closed,
 *                  needs_response, under_review, charge_refunded, won, lost
 */
function mapStripeDisputeStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case 'needs_response':
    case 'warning_needs_response':
      return 'needs_response';
    case 'under_review':
    case 'warning_under_review':
      return 'under_review';
    case 'won':
      return 'won';
    case 'lost':
    case 'charge_refunded':
      return 'lost';
    case 'warning_closed':
      return 'closed';
    default:
      return 'open';
  }
}

export default ChargebackService;
