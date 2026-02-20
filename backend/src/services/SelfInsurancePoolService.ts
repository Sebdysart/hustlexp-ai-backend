/**
 * SelfInsurancePoolService v1.0.0
 *
 * Platform-managed insurance pool funded by task contributions
 *
 * Contribution: 2% of task price deducted at escrow setup
 * Claims: Filed by hustlers for damages/disputes, reviewed by admin/AI
 * Coverage: 80% of claim amount (default), max $5000 per claim
 *
 * @see schema.sql v1.8.0 (self_insurance_pool, insurance_contributions, insurance_claims)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { logger } from '../logger';

const log = logger.child({ service: 'SelfInsurancePoolService' });

// ============================================================================
// TYPES
// ============================================================================

interface SelfInsurancePool {
  id: string;
  total_deposits_cents: number;
  total_claims_cents: number;
  available_balance_cents: number; // Computed column
  coverage_percentage: number;
  max_claim_cents: number;
  updated_at: Date;
}

interface InsuranceContribution {
  id: string;
  task_id: string;
  hustler_id: string;
  contribution_cents: number;
  contribution_percentage: number;
  created_at: Date;
}

type ClaimStatus = 'pending' | 'approved' | 'denied' | 'paid';

interface InsuranceClaim {
  id: string;
  task_id: string;
  hustler_id: string;
  claim_amount_cents: number;
  status: ClaimStatus;
  claim_reason: string;
  evidence_urls: string[];
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  paid_at: Date | null;
  created_at: Date;
}

interface PoolStatus {
  total_deposits_cents: number;
  total_claims_cents: number;
  available_balance_cents: number;
  coverage_percentage: number;
  max_claim_cents: number;
}

// ============================================================================
// SERVICE
// ============================================================================

export const SelfInsurancePoolService = {
  /**
   * Calculate required insurance contribution
   * Default: 2% of task price
   */
  calculateContribution: (taskPriceCents: number, contributionPercentage = 2.0): number => {
    return Math.round(taskPriceCents * (contributionPercentage / 100));
  },

  /**
   * Record contribution to insurance pool
   * Called during escrow setup
   */
  recordContribution: async (
    taskId: string,
    hustlerId: string,
    contributionCents: number,
    contributionPercentage = 2.0
  ): Promise<ServiceResult<void>> => {
    try {
      // Insert contribution record
      await db.query(
        `INSERT INTO insurance_contributions (
          task_id, hustler_id, contribution_cents, contribution_percentage
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (task_id, hustler_id) DO NOTHING`,
        [taskId, hustlerId, contributionCents, contributionPercentage]
      );

      // Update pool total
      await db.query(
        `UPDATE self_insurance_pool
         SET total_deposits_cents = total_deposits_cents + $1,
             updated_at = NOW()`,
        [contributionCents]
      );

      log.info({ taskId, hustlerId, amountCents: contributionCents }, 'Recorded contribution');

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId, hustlerId }, 'Failed to record contribution');
      return {
        success: false,
        error: {
          code: 'RECORD_CONTRIBUTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to record contribution'
        }
      };
    }
  },

  /**
   * File a claim against the insurance pool
   */
  fileClaim: async (
    taskId: string,
    hustlerId: string,
    claimAmountCents: number,
    reason: string,
    evidenceUrls: string[]
  ): Promise<ServiceResult<string>> => {
    try {
      // Validate claim amount against max
      const poolStatus = await SelfInsurancePoolService.getPoolStatus();
      if (!poolStatus.success || !poolStatus.data) {
        throw new Error('Failed to get pool status');
      }

      if (claimAmountCents > poolStatus.data.max_claim_cents) {
        return {
          success: false,
          error: {
            code: 'CLAIM_EXCEEDS_MAX',
            message: `Claim amount $${(claimAmountCents / 100).toFixed(2)} exceeds maximum $${(poolStatus.data.max_claim_cents / 100).toFixed(2)}`
          }
        };
      }

      // Insert claim
      const result = await db.query<{ id: string }>(
        `INSERT INTO insurance_claims (
          task_id, hustler_id, claim_amount_cents, claim_reason, evidence_urls
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id`,
        [taskId, hustlerId, claimAmountCents, reason, evidenceUrls]
      );

      const claimId = result.rows[0].id;
      log.info({ claimId, taskId, amountCents: claimAmountCents }, 'Filed claim');

      return { success: true, data: claimId };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId, hustlerId }, 'Failed to file claim');
      return {
        success: false,
        error: {
          code: 'FILE_CLAIM_FAILED',
          message: error instanceof Error ? error.message : 'Failed to file claim'
        }
      };
    }
  },

  /**
   * Review a claim (admin/AI)
   * Approves or denies claim
   */
  reviewClaim: async (
    claimId: string,
    reviewerId: string,
    approved: boolean,
    reviewNotes: string
  ): Promise<ServiceResult<void>> => {
    try {
      const newStatus: ClaimStatus = approved ? 'approved' : 'denied';

      await db.query(
        `UPDATE insurance_claims
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_notes = $3
         WHERE id = $4`,
        [newStatus, reviewerId, reviewNotes, claimId]
      );

      log.info({ claimId, approved }, 'Reviewed claim');

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), claimId }, 'Failed to review claim');
      return {
        success: false,
        error: {
          code: 'REVIEW_CLAIM_FAILED',
          message: error instanceof Error ? error.message : 'Failed to review claim'
        }
      };
    }
  },

  /**
   * Pay an approved claim
   * Transfers funds from pool to hustler
   */
  payClaim: async (claimId: string): Promise<ServiceResult<void>> => {
    try {
      // Get claim details
      const claimResult = await db.query<InsuranceClaim>(
        'SELECT * FROM insurance_claims WHERE id = $1',
        [claimId]
      );

      if (!claimResult.rows[0]) {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_FOUND',
            message: 'Claim not found'
          }
        };
      }

      const claim = claimResult.rows[0];

      if (claim.status !== 'approved') {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_APPROVED',
            message: 'Claim must be approved before payment'
          }
        };
      }

      // Get pool status
      const poolStatus = await SelfInsurancePoolService.getPoolStatus();
      if (!poolStatus.success || !poolStatus.data) {
        throw new Error('Failed to get pool status');
      }

      // Calculate covered amount (default 80%)
      const coveredAmountCents = Math.round(
        claim.claim_amount_cents * (poolStatus.data.coverage_percentage / 100)
      );

      // Check if pool has sufficient balance
      if (coveredAmountCents > poolStatus.data.available_balance_cents) {
        return {
          success: false,
          error: {
            code: 'INSUFFICIENT_POOL_BALANCE',
            message: `Pool balance insufficient. Available: $${(poolStatus.data.available_balance_cents / 100).toFixed(2)}, Required: $${(coveredAmountCents / 100).toFixed(2)}`
          }
        };
      }

      // Update pool balance
      await db.query(
        `UPDATE self_insurance_pool
         SET total_claims_cents = total_claims_cents + $1,
             updated_at = NOW()`,
        [coveredAmountCents]
      );

      // Mark claim as paid
      await db.query(
        `UPDATE insurance_claims
         SET status = 'paid',
             paid_at = NOW()
         WHERE id = $1`,
        [claimId]
      );

      // Transfer funds to hustler via Stripe Connect
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        try {
          const hustlerResult = await db.query<{ stripe_connect_id: string }>(
            `SELECT stripe_connect_id FROM users WHERE id = $1`,
            [claim.hustler_id]
          );
          const connectId = hustlerResult.rows[0]?.stripe_connect_id;
          if (connectId) {
            const transferResponse = await fetch('https://api.stripe.com/v1/transfers', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${stripeKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                amount: coveredAmountCents.toString(),
                currency: 'usd',
                destination: connectId,
                description: `Insurance claim payout: ${claimId}`,
                'metadata[claim_id]': claimId,
                'metadata[task_id]': claim.task_id,
              }).toString(),
            });
            if (!transferResponse.ok) {
              log.error({ claimId, taskId: claim.task_id, statusCode: transferResponse.status }, 'Stripe transfer failed for claim payout');
              await db.query(
                `UPDATE insurance_claims SET review_notes = COALESCE(review_notes, '') || ' [STRIPE_TRANSFER_FAILED]' WHERE id = $1`,
                [claimId]
              );
            }
          } else {
            log.warn({ hustlerId: claim.hustler_id, claimId }, 'Hustler has no Stripe Connect ID');
          }
        } catch (stripeError) {
          log.error({ err: stripeError instanceof Error ? stripeError.message : String(stripeError), claimId }, 'Stripe error during claim payout');
        }
      }

      log.info({ claimId, coveredAmountCents }, 'Paid claim');

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), claimId }, 'Failed to pay claim');
      return {
        success: false,
        error: {
          code: 'PAY_CLAIM_FAILED',
          message: error instanceof Error ? error.message : 'Failed to pay claim'
        }
      };
    }
  },

  /**
   * Get pool status (balance, coverage, limits)
   */
  getPoolStatus: async (): Promise<ServiceResult<PoolStatus>> => {
    try {
      const result = await db.query<SelfInsurancePool>(
        'SELECT * FROM self_insurance_pool LIMIT 1'
      );

      if (!result.rows[0]) {
        // Pool not initialized yet
        return {
          success: true,
          data: {
            total_deposits_cents: 0,
            total_claims_cents: 0,
            available_balance_cents: 0,
            coverage_percentage: 80.0,
            max_claim_cents: 500000
          }
        };
      }

      const pool = result.rows[0];
      return {
        success: true,
        data: {
          total_deposits_cents: pool.total_deposits_cents,
          total_claims_cents: pool.total_claims_cents,
          available_balance_cents: pool.available_balance_cents,
          coverage_percentage: pool.coverage_percentage,
          max_claim_cents: pool.max_claim_cents
        }
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to get pool status');
      return {
        success: false,
        error: {
          code: 'GET_POOL_STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get pool status'
        }
      };
    }
  },

  /**
   * Get user's claims
   */
  getMyClaims: async (hustlerId: string): Promise<ServiceResult<InsuranceClaim[]>> => {
    try {
      const result = await db.query<InsuranceClaim>(
        `SELECT * FROM insurance_claims
         WHERE hustler_id = $1
         ORDER BY created_at DESC`,
        [hustlerId]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), hustlerId }, 'Failed to get claims');
      return {
        success: false,
        error: {
          code: 'GET_MY_CLAIMS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get claims'
        }
      };
    }
  }
};
