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

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { logger } from '../logger.js';
import { StripeService } from './StripeService.js';

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

        // Insert claim (holds the lock through commit, preventing double-filing past the balance)
        const result = await query<{ id: string }>(
          `INSERT INTO insurance_claims (
            task_id, hustler_id, claim_amount_cents, claim_reason, evidence_urls
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING id`,
          [taskId, hustlerId, claimAmountCents, reason, evidenceUrls]
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

      // F-04 FIX: Add AND status = 'pending' guard so already-paid or denied claims
      // cannot be re-reviewed. Without this guard, any claim can be flipped back to
      // 'approved' or 'denied' regardless of its current state.
      // F59-1 FIX: RETURNING claim_amount_cents so denial can decrement total_claims_cents.
      const result = await db.query<{ claim_amount_cents: number }>(
        `UPDATE insurance_claims
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             review_notes = $3
         WHERE id = $4
           AND status = 'pending'
         RETURNING claim_amount_cents`,
        [newStatus, reviewerId, reviewNotes, claimId]
      );

      if (result.rowCount === 0) {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_REVIEWABLE',
            message: 'Claim is not in pending status and cannot be reviewed'
          }
        };
      }

      // F59-1 FIX: When denying a claim, return the coverage reservation back to the pool.
      // fileClaim reserved coveredAmountCents in total_claims_cents at filing time.
      // A denied claim will never be paid — the reservation must be released so future
      // claimants are not incorrectly blocked by INSUFFICIENT_POOL_BALANCE.
      if (!approved && result.rows[0]) {
        const claimAmountCents = result.rows[0].claim_amount_cents;
        const poolStatus = await SelfInsurancePoolService.getPoolStatus();
        const coveragePct = poolStatus.success && poolStatus.data ? poolStatus.data.coverage_percentage : 80;
        const coveredAmount = Math.round(claimAmountCents * (coveragePct / 100));
        await db.query(
          `UPDATE self_insurance_pool
           SET total_claims_cents = GREATEST(0, total_claims_cents - $1),
               updated_at = NOW()`,
          [coveredAmount]
        );
      }

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
   *
   * F-17: Balance check + debit wrapped in a transaction with SELECT FOR UPDATE
   *       to prevent concurrent double-drain.
   * F-18: Idempotency check — returns early if claim is already paid.
   * F-19: Stripe transfer uses Idempotency-Key header based on claimId.
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

      // F-18 / F-31: Idempotency — return early only if paid AND Stripe transfer confirmed.
      // If status='paid' but stripe_transfer_id is NULL, the DB transaction committed but
      // the Stripe call failed — we must fall through and re-attempt the Stripe transfer.
      if (claim.status === 'paid' && claim.stripe_transfer_id) {
        return { success: true, data: { already_paid: true, claim } };
      }

      if (claim.status !== 'approved') {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_APPROVED',
            message: 'Claim must be approved before payment'
          }
        };
      }

      // F46-4 FIX: Pre-check Stripe Connect ID BEFORE the DB transaction.
      // Previously the Connect ID was fetched AFTER the DB committed: pool was debited
      // and claim marked 'paid', but no Stripe transfer occurred — the function then
      // returned { success: true } with pool funds permanently lost. The idempotency
      // guard (status='paid' AND stripe_transfer_id set) would never match because
      // stripe_transfer_id stays NULL, so every retry hit the same dead-end.
      // Fix: fail fast before any DB writes so the pool is never debited and the
      // caller can retry after the hustler completes Stripe Connect onboarding.
      // Note: we still re-verify the Connect ID inside the Stripe try block below
      // for correctness (concurrent onboarding revocation), but this early check
      // prevents the irreversible DB commit from happening without a valid account.
      const preCheckResult = await db.query<{ stripe_connect_id: string | null }>(
        `SELECT stripe_connect_id FROM users WHERE id = $1`,
        [claim.hustler_id]
      );
      const connectId = preCheckResult.rows[0]?.stripe_connect_id;
      if (!connectId) {
        return {
          success: false,
          error: {
            code: 'NO_CONNECT_ACCOUNT',
            message: `Hustler has no Stripe Connect account — cannot pay claim. Complete Stripe Connect onboarding first.`
          }
        };
      }

      // F-04 FIX: Do NOT fetch coverage_percentage outside the transaction.
      // coveredAmountCents must be computed from the freshly-locked pool row so that
      // an admin change to coverage_percentage between this point and the FOR UPDATE
      // lock cannot produce a stale covered amount (same bug that was fixed for
      // fileClaim in F-06/R44). The variable is declared here for use in the Stripe
      // call after the transaction commits.
      let coveredAmountCents: number = 0;

      // F59-2 FIX: Flag to detect when the transaction finds the claim is already paid.
      // Previously, status='paid' caused an early `return` inside the transaction, leaving
      // coveredAmountCents=0. After the transaction, Stripe was called with amount=0.
      // Now we set this flag instead of returning, and guard against the Stripe call below.
      let alreadyPaid = false;

      // F-17: Wrap balance check + pool debit + claim status update in a single
      // transaction with SELECT FOR UPDATE to prevent concurrent double-drain.
      await db.transaction(async (query: QueryFn) => {
        // F-25 / F-31: Re-verify claim status under row lock to prevent concurrent double-pay.
        // Only skip the DB debit if status='paid' AND stripe_transfer_id is set — meaning a
        // previous call fully completed. If stripe_transfer_id is NULL, DB committed but Stripe
        // failed; the outer idempotency check allows fall-through for Stripe retry, so here
        // we just skip the DB portion (pool already debited) by returning early.
        const claimCheck = await query<{ status: string; stripe_transfer_id: string | null; claim_amount_cents: number }>(
          'SELECT status, stripe_transfer_id, claim_amount_cents FROM insurance_claims WHERE id = $1 FOR UPDATE',
          [claimId]
        );
        if (!claimCheck.rows[0]) {
          return; // Claim locked/deleted by concurrent call — safe to exit
        }
        if (claimCheck.rows[0].status === 'paid') {
          // F59-2 FIX: Set flag instead of returning so coveredAmountCents stays 0
          // and the caller can detect this path without attempting a Stripe transfer.
          alreadyPaid = true;
          return; // DB already committed (with or without Stripe) — skip debit, outer code retries Stripe if needed
        }
        if (claimCheck.rows[0].status !== 'approved') {
          throw new Error(`CLAIM_NOT_APPROVED:Claim status changed to ${claimCheck.rows[0].status}`);
        }

        // F-04 FIX: Lock the pool row and re-read BOTH available_balance_cents AND
        // coverage_percentage atomically under FOR UPDATE. Previously, coverage_percentage
        // was fetched outside the transaction, leaving a window where an admin update
        // between the outer SELECT and this lock would produce a stale coveredAmountCents.
        // available_balance_cents is a computed column: total_deposits_cents - total_claims_cents
        // F48-2: Also read max_claim_cents under the lock so that a coverage_percentage raise
        // after claim filing cannot produce a payout that exceeds the pool cap.
        const poolResult = await query<{ available_balance_cents: number; coverage_percentage: number; max_claim_cents: number }>(
          'SELECT available_balance_cents, coverage_percentage, max_claim_cents FROM self_insurance_pool FOR UPDATE LIMIT 1'
        );

        const availableBalanceCents = poolResult.rows[0]?.available_balance_cents ?? 0;
        // Recompute from freshly-locked coverage_percentage (F-04 fix)
        const freshCoveragePercentage = poolResult.rows[0]?.coverage_percentage ?? 80.0;
        coveredAmountCents = Math.round(claimCheck.rows[0].claim_amount_cents * (freshCoveragePercentage / 100));

        // F48-2: Guard against coverage_percentage having been raised since claim filing —
        // throw before the balance check so the pool is never debited beyond the cap.
        const maxClaimCents = poolResult.rows[0]?.max_claim_cents ?? 500000;
        if (coveredAmountCents > maxClaimCents) {
          throw new Error('CLAIM_EXCEEDS_MAX:Covered payout would exceed pool maximum claim limit');
        }

        if (coveredAmountCents > availableBalanceCents) {
          throw new Error(`INSUFFICIENT_POOL_BALANCE:Pool balance insufficient. Available: $${(availableBalanceCents / 100).toFixed(2)}, Required: $${(coveredAmountCents / 100).toFixed(2)}`);
        }

        // F56-1 FIX: Move the Stripe minimum transfer floor check INSIDE the transaction,
        // BEFORE the pool debit and claim status UPDATE. Previously this check ran after
        // the transaction committed — the pool was permanently debited and claim marked
        // 'paid' with stripe_transfer_id=NULL, leaving the claim in an un-retryable limbo
        // (retry hits status='paid'/no transfer_id → falls through idempotency guard →
        // hits status guard → CLAIM_NOT_APPROVED permanently). By throwing here, the
        // transaction rolls back: no pool debit, no claim status change.
        if (coveredAmountCents < 50) {
          throw new Error(`TRANSFER_AMOUNT_TOO_LOW:Covered payout of ${coveredAmountCents} cents is below the minimum Stripe transfer amount (50 cents). Claim requires manual review.`);
        }

        // F58-3 FIX: Do NOT re-debit pool balance here. total_claims_cents was already
        // incremented by fileClaim at filing time (under the same FOR UPDATE lock) to
        // prevent concurrent over-commitment. Re-incrementing here would double-count
        // the reservation and permanently over-report total_claims_cents.
        // payClaim only needs to mark the claim as paid.

        // Mark claim as paid
        await query(
          `UPDATE insurance_claims
           SET status = 'paid',
               paid_at = NOW()
           WHERE id = $1`,
          [claimId]
        );
      });

      // F59-2 FIX: If the transaction detected the claim was already paid by a concurrent
      // caller, return early here — coveredAmountCents is still 0 at this point, so calling
      // Stripe with amount=0 would either error or produce a zero-dollar transfer.
      if (alreadyPaid) {
        return { success: true, data: { already_paid: true, claim } };
      }

      // Transfer funds to hustler via Stripe Connect
      // F-06 FIX: Use StripeService.createTransfer() instead of raw fetch() so the
      // call goes through the circuit breaker, SDK retry/timeout logic, and test stubs.
      // F-19: Pass claimId as part of the idempotency key to prevent duplicate transfers.
      // F53-10 FIX: Do NOT swallow Stripe failures. If Stripe throws or returns
      // success:false, return a STRIPE_TRANSFER_FAILED error so the caller knows the
      // worker was not paid. Previously, all Stripe errors were silently caught and the
      // function returned { success: true } — the DB had already committed status='paid'
      // but the worker received nothing (permanent money loss).
      // F46-4 FIX: Re-use the pre-checked connectId from above (no redundant DB query).
      // The pre-check already returned failure if connectId was null, so here it is
      // guaranteed non-null.
      let transferResult: Awaited<ReturnType<typeof StripeService.createTransfer>>;
      try {
        transferResult = await StripeService.createTransfer({
          escrowId: claimId, // use claimId as the correlation key for this payout
          taskId: claim.task_id,
          workerId: claim.hustler_id,
          workerStripeAccountId: connectId,
          amount: coveredAmountCents,
          description: `Insurance claim payout: ${claimId}`,
          idempotencyKeySuffix: `claim_payout_${claimId}`,
        });
      } catch (stripeException) {
        // F53-10 FIX: Stripe threw an exception (network error, SDK error, etc.)
        // Record it for ops visibility and return a structured failure — do NOT swallow.
        const errMsg = stripeException instanceof Error ? stripeException.message : String(stripeException);
        log.error({ err: errMsg, claimId }, 'Stripe threw during claim payout transfer');
        // Best-effort annotation — ignore any secondary DB failure so the structured error always returns.
        try {
          await db.query(
            `UPDATE insurance_claims SET review_notes = COALESCE(review_notes, '') || ' [STRIPE_TRANSFER_FAILED]' WHERE id = $1`,
            [claimId]
          );
        } catch {
          // Ignore secondary failures — the primary error is what matters to the caller
        }
        return {
          success: false,
          error: {
            code: 'STRIPE_TRANSFER_FAILED',
            message: `Stripe transfer threw: ${errMsg}`,
          },
        };
      }

      if (!transferResult.success) {
        // F53-10 FIX: Stripe returned a structured failure — record it for ops visibility
        // but propagate the error to the caller (do NOT return { success: true }).
        log.error({ claimId, taskId: claim.task_id, err: transferResult.error.message }, 'Stripe transfer failed for claim payout');
        await db.query(
          `UPDATE insurance_claims SET review_notes = COALESCE(review_notes, '') || ' [STRIPE_TRANSFER_FAILED]' WHERE id = $1`,
          [claimId]
        );
        return {
          success: false,
          error: {
            code: 'STRIPE_TRANSFER_FAILED',
            message: `Stripe transfer failed: ${transferResult.error.message}`,
          },
        };
      }

      // F-31: Record the transfer ID so the idempotency guard can confirm
      // that the Stripe call succeeded. Without this, a process crash after
      // DB commit but before Stripe completes leaves the claim in a
      // status='paid'/stripe_transfer_id=NULL limbo that is un-retryable.
      await db.query(
        'UPDATE insurance_claims SET stripe_transfer_id = $1 WHERE id = $2',
        [transferResult.data.transferId, claimId]
      );

      log.info({ claimId, coveredAmountCents }, 'Paid claim');

      return { success: true, data: {} };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Surface structured insufficient-balance errors
      if (message.startsWith('INSUFFICIENT_POOL_BALANCE:')) {
        return {
          success: false,
          error: {
            code: 'INSUFFICIENT_POOL_BALANCE',
            message: message.slice('INSUFFICIENT_POOL_BALANCE:'.length)
          }
        };
      }
      // Surface F48-2: covered payout exceeds pool cap
      if (message.startsWith('CLAIM_EXCEEDS_MAX:')) {
        return {
          success: false,
          error: {
            code: 'CLAIM_EXCEEDS_MAX',
            message: message.slice('CLAIM_EXCEEDS_MAX:'.length)
          }
        };
      }
      // Surface F56-1: transfer amount below Stripe minimum floor
      if (message.startsWith('TRANSFER_AMOUNT_TOO_LOW:')) {
        return {
          success: false,
          error: {
            code: 'TRANSFER_AMOUNT_TOO_LOW',
            message: message.slice('TRANSFER_AMOUNT_TOO_LOW:'.length)
          }
        };
      }
      // Surface claim-status-changed errors (F-25: concurrent double-pay guard)
      if (message.startsWith('CLAIM_NOT_APPROVED:')) {
        return {
          success: false,
          error: {
            code: 'CLAIM_NOT_APPROVED',
            message: message.slice('CLAIM_NOT_APPROVED:'.length)
          }
        };
      }
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
