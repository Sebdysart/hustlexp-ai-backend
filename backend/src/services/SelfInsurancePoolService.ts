import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { logger } from '../logger.js';
import { StripeService } from './StripeService.js';

const log = logger.child({ service: 'SelfInsurancePoolService' });

interface SelfInsurancePool {
  id: string;
  total_deposits_cents: number;
  total_claims_cents: number;
  available_balance_cents: number;
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
}

interface PoolStatus {
  total_deposits_cents: number;
  total_claims_cents: number;
  available_balance_cents: number;
  coverage_percentage: number;
  max_claim_cents: number;
}

export const SelfInsurancePoolService = {
  calculateContribution: (taskPriceCents: number, contributionPercentage = 2.0): number => {
    return Math.round(taskPriceCents * (contributionPercentage / 100));
  },

  recordContribution: async (
    taskId: string,
    hustlerId: string,
    contributionCents: number,
    contributionPercentage = 2.0
  ): Promise<ServiceResult<void>> => {
    try {
      await db.query(
        `INSERT INTO insurance_contributions (
          task_id, hustler_id, contribution_cents, contribution_percentage
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (task_id, hustler_id) DO NOTHING`,
        [taskId, hustlerId, contributionCents, contributionPercentage]
      );
      await db.query(
        `UPDATE self_insurance_pool
         SET total_deposits_cents = total_deposits_cents + $1, updated_at = NOW()`,
        [contributionCents]
      );
      log.info({ taskId, hustlerId, amountCents: contributionCents }, 'Recorded contribution');
      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId, hustlerId }, 'Failed to record contribution');
      return { success: false, error: { code: 'RECORD_CONTRIBUTION_FAILED', message: error instanceof Error ? error.message : 'Failed to record contribution' } };
    }
  },

  fileClaim: async (
    taskId: string,
    hustlerId: string,
    claimAmountCents: number,
    reason: string,
    evidenceUrls: string[]
  ): Promise<ServiceResult<string>> => {
    try {
      const poolStatus = await SelfInsurancePoolService.getPoolStatus();
      if (!poolStatus.success || !poolStatus.data) throw new Error('Failed to get pool status');
      if (claimAmountCents > poolStatus.data.max_claim_cents) {
        return { success: false, error: { code: 'CLAIM_EXCEEDS_MAX', message: `Claim exceeds maximum $${(poolStatus.data.max_claim_cents / 100).toFixed(2)}` } };
      }
      const result = await db.query<{ id: string }>(
        `INSERT INTO insurance_claims (task_id, hustler_id, claim_amount_cents, claim_reason, evidence_urls)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [taskId, hustlerId, claimAmountCents, reason, evidenceUrls]
      );
      log.info({ claimId: result.rows[0].id, taskId, amountCents: claimAmountCents }, 'Filed claim');
      return { success: true, data: result.rows[0].id };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId, hustlerId }, 'Failed to file claim');
      return { success: false, error: { code: 'FILE_CLAIM_FAILED', message: error instanceof Error ? error.message : 'Failed to file claim' } };
    }
  },

  reviewClaim: async (claimId: string, reviewerId: string, approved: boolean, reviewNotes: string): Promise<ServiceResult<void>> => {
    try {
      const newStatus: ClaimStatus = approved ? 'approved' : 'denied';
      await db.query(
        `UPDATE insurance_claims SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3 WHERE id = $4`,
        [newStatus, reviewerId, reviewNotes, claimId]
      );
      log.info({ claimId, approved }, 'Reviewed claim');
      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), claimId }, 'Failed to review claim');
      return { success: false, error: { code: 'REVIEW_CLAIM_FAILED', message: error instanceof Error ? error.message : 'Failed to review claim' } };
    }
  },

  // EXPLOIT FIX (B7): payClaim now attempts Stripe transfer BEFORE deducting
  // from the pool. If the transfer fails, pool balance is untouched and the
  // claim stays 'approved' for retry. Previously the pool was deducted and
  // claim marked 'paid' before the transfer, so a failed transfer "lost"
  // money from the pool permanently.
  payClaim: async (claimId: string): Promise<ServiceResult<void>> => {
    try {
      const claimResult = await db.query<InsuranceClaim>('SELECT * FROM insurance_claims WHERE id = $1', [claimId]);
      if (!claimResult.rows[0]) return { success: false, error: { code: 'CLAIM_NOT_FOUND', message: 'Claim not found' } };

      const claim = claimResult.rows[0];
      if (claim.status !== 'approved') return { success: false, error: { code: 'CLAIM_NOT_APPROVED', message: 'Claim must be approved before payment' } };

      const poolStatus = await SelfInsurancePoolService.getPoolStatus();
      if (!poolStatus.success || !poolStatus.data) throw new Error('Failed to get pool status');

      const coveredAmountCents = Math.round(claim.claim_amount_cents * (poolStatus.data.coverage_percentage / 100));
      if (coveredAmountCents > poolStatus.data.available_balance_cents) {
        return { success: false, error: { code: 'INSUFFICIENT_POOL_BALANCE', message: `Pool balance insufficient` } };
      }

      // Step 1: Attempt Stripe transfer FIRST (before touching pool balance)
      if (StripeService.isConfigured()) {
        const hustlerResult = await db.query<{ stripe_connect_id: string }>(
          'SELECT stripe_connect_id FROM users WHERE id = $1', [claim.hustler_id]
        );
        const connectId = hustlerResult.rows[0]?.stripe_connect_id;

        if (!connectId) {
          log.warn({ hustlerId: claim.hustler_id, claimId }, 'Hustler has no Stripe Connect ID — cannot pay claim');
          return { success: false, error: { code: 'NO_STRIPE_CONNECT', message: 'Hustler has no Stripe Connect account' } };
        }

        const transferResult = await StripeService.createTransfer({
          escrowId: `insurance_${claimId}`,
          taskId: claim.task_id,
          workerId: claim.hustler_id,
          workerStripeAccountId: connectId,
          amount: coveredAmountCents,
          description: `Insurance claim payout: ${claimId}`,
        });

        if (!transferResult.success) {
          log.error({ claimId, error: transferResult.error }, 'Stripe transfer failed — pool balance NOT deducted');
          return { success: false, error: { code: 'STRIPE_TRANSFER_FAILED', message: 'Stripe transfer failed — claim remains approved for retry' } };
        }
      }

      // Step 2: Transfer succeeded — NOW deduct from pool and mark paid
      await db.query(
        `UPDATE self_insurance_pool SET total_claims_cents = total_claims_cents + $1, updated_at = NOW()`,
        [coveredAmountCents]
      );
      await db.query(
        `UPDATE insurance_claims SET status = 'paid', paid_at = NOW() WHERE id = $1`,
        [claimId]
      );

      log.info({ claimId, coveredAmountCents }, 'Paid claim');
      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), claimId }, 'Failed to pay claim');
      return { success: false, error: { code: 'PAY_CLAIM_FAILED', message: error instanceof Error ? error.message : 'Failed to pay claim' } };
    }
  },

  getPoolStatus: async (): Promise<ServiceResult<PoolStatus>> => {
    try {
      const result = await db.query<SelfInsurancePool>('SELECT * FROM self_insurance_pool LIMIT 1');
      if (!result.rows[0]) {
        return { success: true, data: { total_deposits_cents: 0, total_claims_cents: 0, available_balance_cents: 0, coverage_percentage: 80.0, max_claim_cents: 500000 } };
      }
      const pool = result.rows[0];
      return { success: true, data: { total_deposits_cents: pool.total_deposits_cents, total_claims_cents: pool.total_claims_cents, available_balance_cents: pool.available_balance_cents, coverage_percentage: pool.coverage_percentage, max_claim_cents: pool.max_claim_cents } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to get pool status');
      return { success: false, error: { code: 'GET_POOL_STATUS_FAILED', message: error instanceof Error ? error.message : 'Failed to get pool status' } };
    }
  },

  getMyClaims: async (hustlerId: string): Promise<ServiceResult<InsuranceClaim[]>> => {
    try {
      const result = await db.query<InsuranceClaim>('SELECT * FROM insurance_claims WHERE hustler_id = $1 ORDER BY created_at DESC', [hustlerId]);
      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), hustlerId }, 'Failed to get claims');
      return { success: false, error: { code: 'GET_MY_CLAIMS_FAILED', message: error instanceof Error ? error.message : 'Failed to get claims' } };
    }
  }
};
