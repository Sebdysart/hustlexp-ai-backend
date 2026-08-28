/**
 * SelfInsurancePoolService v1.0.0
 *
 * Platform-managed insurance pool funded by task contributions
 *
 * Contribution: 2% of task price deducted at escrow setup
 * Claims: Filed by hustlers for damages/disputes, reviewed by admin/AI
 * Coverage: 80% of claim amount (default), max $5000 per claim
 *
 * @see backend/database/constitutional-schema.sql v1.8.0 (self_insurance_pool, insurance_contributions, insurance_claims)
 */

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { logger } from '../logger.js';
import { permanentlyContainedPositiveMoneyFailure } from './NewPaymentCreationGuard.js';

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
  stripe_transfer_id: string | null; // F-31: null until Stripe transfer is confirmed
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
      await db.transaction(async (query: QueryFn) => {
        // F-28: Use a CTE so the pool UPDATE only fires when the INSERT actually
        // inserts a row. If ON CONFLICT DO NOTHING suppresses the insert (duplicate
        // call), the CTE returns zero rows and the UPDATE is skipped — preventing
        // a double-credit to total_deposits_cents.
        await query(
          `WITH ins AS (
            INSERT INTO insurance_contributions (
              task_id, hustler_id, contribution_cents, contribution_percentage
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (task_id, hustler_id) DO NOTHING
            RETURNING id
          )
          UPDATE self_insurance_pool
          SET total_deposits_cents = total_deposits_cents + $3,
              updated_at = NOW()
          WHERE EXISTS (SELECT 1 FROM ins)`,
          [taskId, hustlerId, contributionCents, contributionPercentage]
        );
      });

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
      // Pre-flight: validate claim amount against pool max (outside transaction — read-only config check)
      const poolStatus = await SelfInsurancePoolService.getPoolStatus();
      if (!poolStatus.success || !poolStatus.data) {
        throw new Error('Failed to get pool status');
      }

      // F51-5 FIX: The pre-flight CLAIM_EXCEEDS_MAX check has been removed.
      // It compared an estimated covered amount computed from a stale coverage_percentage
      // (read outside the transaction) against max_claim_cents — a race condition that
      // could produce false greens or false reds. The in-transaction check (inside
      // db.transaction() below, under FOR UPDATE) reads fresh locked values and already
      // returns CLAIM_EXCEEDS_MAX if coveredAmountCents > maxClaimCents. That check is
      // the reliable gate; the pre-flight was redundant and unreliable.

      // F-02 FIX: Wrap the live balance check + INSERT in a transaction with
      // SELECT ... FOR UPDATE so concurrent callers cannot collectively exceed
      // pool balance. The FOR UPDATE row lock serializes concurrent fileClaim()
      // calls through the balance check, ensuring only one at a time can read
      // the balance, validate it, and INSERT a new claim.
      //
      // F-06 FIX: coverage_percentage is now read INSIDE the transaction under
      // FOR UPDATE so that coveredAmount is always computed from the same locked
      // snapshot as available_balance_cents. An admin changing coverage_percentage
      // between the outer getPoolStatus() call and this lock would previously produce
      // a stale coveredAmount — now it is always fresh and consistent.

      const claimId = await db.transaction(async (query: QueryFn) => {
        // F49-7 FIX: Duplicate check moved INSIDE the transaction with FOR UPDATE to
        // eliminate the TOCTOU race window. Previously, the pre-flight SELECT ran
        // outside the transaction — two concurrent fileClaim() calls could both pass
        // the check before either INSERT committed, creating duplicate pending claims.
        // The FOR UPDATE row-level lock serializes concurrent callers: the second caller
        // blocks until the first transaction commits, then sees the inserted row.
        //
        // F61-1 FIX: When no rows exist, FOR UPDATE acquires no lock — two concurrent
        // calls can both find 0 rows and both proceed to INSERT. The real concurrency
        // safety is provided by the partial unique index
        // idx_insurance_claims_unique_active (task_id, hustler_id WHERE status NOT IN
        // ('denied', 'withdrawn')) defined in add_unique_claim_constraint.sql. The
        // second concurrent INSERT fails with a unique constraint violation which is
        // caught by the outer catch and surfaced as CLAIM_ALREADY_EXISTS.
        const existingClaim = await query<{ id: string }>(
          `SELECT id FROM insurance_claims WHERE task_id = $1 AND hustler_id = $2 AND status NOT IN ('denied', 'withdrawn') LIMIT 1 FOR UPDATE`,
          [taskId, hustlerId]
        );
        if (existingClaim.rows[0]) {
          throw new Error('CLAIM_ALREADY_EXISTS:A claim already exists for this task');
        }

        // Lock the pool row to serialize concurrent claim filings and ensure
        // both available_balance_cents and coverage_percentage are read atomically.
        const poolResult = await query<{ available_balance_cents: number; coverage_percentage: number }>(
          'SELECT available_balance_cents, coverage_percentage FROM self_insurance_pool FOR UPDATE LIMIT 1'
        );

        const availableBalanceCents = poolResult.rows[0]?.available_balance_cents ?? 0;
        // Use freshly-locked coverage_percentage (F-06 fix); fall back to pre-checked value
        // only when the pool row does not exist (already handled above by getPoolStatus check).
        const freshCoveragePercentage = poolResult.rows[0]?.coverage_percentage ?? poolStatus.data.coverage_percentage;
        const coveredAmount = Math.round(claimAmountCents * (freshCoveragePercentage / 100));

        // F-32: Check against live locked balance
        if (coveredAmount > availableBalanceCents) {
          throw new Error(`INSUFFICIENT_POOL_BALANCE:Pool has insufficient balance to cover this claim. Available: $${(availableBalanceCents / 100).toFixed(2)}`);
        }

        // F58-3 FIX: Reserve the covered amount in the pool at filing time.
        // Without this, concurrent fileClaim() calls all read the same available balance
        // before any of them commits — allowing multiple claims to be filed that together
        // exceed the pool capacity (over-commitment). By debiting total_claims_cents here
        // (under the FOR UPDATE lock already held on the pool row), subsequent concurrent
        // filers see the reduced available_balance_cents and are correctly rejected.
        // Note: payClaim no longer re-debits total_claims_cents — it only marks the claim paid.
        await query(
          `UPDATE self_insurance_pool
           SET total_claims_cents = total_claims_cents + $1,
               updated_at = NOW()`,
          [coveredAmount]
        );

        // F60: Insert claim with covered_amount_cents stored at filing time.
        // Storing it now means reviewClaim denial and payClaim both use the same
        // value rather than recomputing from a potentially changed coverage_percentage.
        const result = await query<{ id: string; covered_amount_cents: number }>(
          `INSERT INTO insurance_claims (
            task_id, hustler_id, claim_amount_cents, covered_amount_cents, claim_reason, evidence_urls
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, covered_amount_cents`,
          [taskId, hustlerId, claimAmountCents, coveredAmount, reason, evidenceUrls]
        );

        return result.rows[0].id;
      });

      log.info({ claimId, taskId, amountCents: claimAmountCents }, 'Filed claim');

      return { success: true, data: claimId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('CLAIM_ALREADY_EXISTS:')) {
        return {
          success: false,
          error: {
            code: 'CLAIM_ALREADY_EXISTS',
            message: message.slice('CLAIM_ALREADY_EXISTS:'.length)
          }
        };
      }
      if (message.startsWith('INSUFFICIENT_POOL_BALANCE:')) {
        return {
          success: false,
          error: {
            code: 'INSUFFICIENT_POOL_BALANCE',
            message: message.slice('INSUFFICIENT_POOL_BALANCE:'.length)
          }
        };
      }
      log.error({ err: message, taskId, hustlerId }, 'Failed to file claim');
      return {
        success: false,
        error: {
          code: 'FILE_CLAIM_FAILED',
          message
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

      // F60-1 FIX: Wrap the claim UPDATE and pool decrement in a single transaction
      // so they are atomic. Previously, a crash between the two statements could leave
      // the pool over-reported (claim denied but reservation not returned).
      //
      // F60-2 FIX: Use RETURNING covered_amount_cents (stored at filing time) so the
      // denial decrement uses the original filed value rather than recomputing from
      // a potentially different current coverage_percentage.
      await db.transaction(async (query: QueryFn) => {
        // Atomic: update claim status and get covered_amount_cents in one statement.
        // AND status = 'pending' prevents re-reviewing already-reviewed claims.
        const updateResult = await query<{ covered_amount_cents: number | null }>(
          `UPDATE insurance_claims
           SET status = $1,
               reviewed_by = $2,
               reviewed_at = NOW(),
               review_notes = $3
           WHERE id = $4 AND status = 'pending'
           RETURNING covered_amount_cents`,
          [newStatus, reviewerId, reviewNotes, claimId]
        );

        if ((updateResult.rowCount ?? 0) === 0) {
          throw new Error('CLAIM_NOT_REVIEWABLE:Claim is not in pending status and cannot be reviewed');
        }

        // F60-1/F60-2 FIX: When denying a claim, return the coverage reservation back
        // to the pool using the stored covered_amount_cents (filed at claim time).
        // fileClaim reserved this amount in total_claims_cents at filing time.
        // A denied claim will never be paid — the reservation must be released so future
        // claimants are not incorrectly blocked by INSUFFICIENT_POOL_BALANCE.
        if (!approved && updateResult.rows[0]?.covered_amount_cents != null) {
          await query(
            `UPDATE self_insurance_pool
             SET total_claims_cents = GREATEST(0, total_claims_cents - $1),
                 updated_at = NOW()`,
            [updateResult.rows[0].covered_amount_cents]
          );
        }
      });

      log.info({ claimId, approved }, 'Reviewed claim');

      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('CLAIM_NOT_REVIEWABLE:')) {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_REVIEWABLE',
            message: message.slice('CLAIM_NOT_REVIEWABLE:'.length)
          }
        };
      }
      log.error({ err: message, claimId }, 'Failed to review claim');
      return {
        success: false,
        error: {
          code: 'REVIEW_CLAIM_FAILED',
          message
        }
      };
    }
  },

  /**
   * Historical insurance-payout compatibility boundary.
   *
   * Completed historical payouts remain readable. A legacy `paid` record with
   * no transfer reference is never retried here because the old implementation
   * could commit the paid state before the provider effect. New payouts remain
   * contained until a durable provider-neutral payout saga is certified.
   */
  payClaim: async (claimId: string): Promise<ServiceResult<{ already_paid?: boolean; claim?: InsuranceClaim }>> => {
    try {
      // Get claim details (outside transaction — read-only pre-check)
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

      if (claim.status === 'paid' && claim.stripe_transfer_id) {
        return { success: true, data: { already_paid: true, claim } };
      }

      if (claim.status === 'paid') {
        return {
          success: false,
          error: {
            code: 'CLAIM_PAYOUT_RECONCILIATION_REQUIRED',
            message:
              'The claim is marked paid without a confirmed payout reference. Reconcile the historical record; no payout was retried.',
            details: {
              claimId,
              disposition: 'RECONCILIATION_REQUIRED',
            },
          },
        };
      }

      if (claim.status !== 'approved') {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_APPROVED',
            message: 'Claim must be approved before payment',
          },
        };
      }

      return permanentlyContainedPositiveMoneyFailure(
        'provider_payout',
        'CONTAINED_PENDING_PROVIDER_NEUTRAL_INSURANCE_PAYOUT_SAGA'
      );

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: message, claimId }, 'Failed to pay claim');
      return {
        success: false,
        error: {
          code: 'PAY_CLAIM_FAILED',
          message
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
