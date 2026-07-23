/**
 * Referral Router v1.0.0
 * Manages referral codes, redemption, and rewards
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, financialAdminProcedure, hustlerProcedure } from '../trpc.js';
import { db } from '../db.js';

/**
 * Build Now carries a zero cash-incentive budget. Referral relationships may be
 * recorded, but no cash liability or paid-state claim may be created until a
 * capped, settled-task-bound, ledger-backed reward rail is separately approved.
 *
 * @param redemptionId - The referral_redemptions.id to mark as paid
 * @param referrerId   - The user_id of the referrer (for cap check)
 * @param rewardCents  - The reward amount in cents to record
 * @returns { issued: boolean; reason?: string }
 */
export async function issueReferralReward(
  _redemptionId: string,
  _referrerId: string,
  _rewardCents: number,
): Promise<{ issued: boolean; reason?: string }> {
  return { issued: false, reason: 'cash_incentives_disabled_build_now' };
}

// Generate a random referral code
function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 0, 1 for clarity
  let code = 'HX';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export const referralRouter = router({
  getOrCreateCode: hustlerProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;

      // Check existing code
      const existing = await db.query<{
        code: string;
        uses_count: number;
      }>(
        'SELECT code, uses_count FROM referral_codes WHERE user_id = $1 AND active = TRUE LIMIT 1',
        [userId]
      );

      if (existing.rows.length > 0) {
        // Get total earned
        const earned = await db.query<{ total: string }>(
          `SELECT COALESCE(SUM(referrer_reward_cents), 0) as total
           FROM referral_redemptions
           WHERE referrer_id = $1 AND referrer_reward_paid = TRUE`,
          [userId]
        );

        return {
          code: existing.rows[0].code,
          usesCount: existing.rows[0].uses_count,
          totalEarnedCents: parseInt(earned.rows[0]?.total || '0', 10),
        };
      }

      // Create new code
      let code = generateReferralCode();
      let attempts = 0;
      while (attempts < 5) {
        try {
          await db.query(
            'INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)',
            [userId, code]
          );
          break;
        } catch {
          code = generateReferralCode();
          attempts++;
        }
      }

      return { code, usesCount: 0, totalEarnedCents: 0 };
    }),

  redeemCode: hustlerProcedure
    .input(z.object({ code: z.string().min(2).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const referredId = ctx.user.id;

      // AUDIT FIX M8 (2026-06-11): the check-then-act ("already referred?" →
      // INSERT) and the separate uses_count UPDATE were non-transactional —
      // concurrent redemptions could double-redeem and drift the counter.
      // Now: one transaction; the INSERT is the idempotency witness via
      // ON CONFLICT (referred_id) DO NOTHING (unique index added in
      // migrations/audit_fixes_concurrency.sql); uses_count increments only
      // when the INSERT actually landed.
      // Check if already referred (fast-path UX error; the unique index is the guarantee)
      const alreadyReferred = await db.query(
        'SELECT id FROM referral_redemptions WHERE referred_id = $1',
        [referredId]
      );
      if (alreadyReferred.rows.length > 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Already used a referral code' });
      }

      // Find the referral code
      const codeResult = await db.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM referral_codes WHERE code = $1 AND active = TRUE',
        [input.code.toUpperCase()]
      );

      if (codeResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid referral code' });
      }

      const referralCode = codeResult.rows[0];

      // Can't refer yourself
      if (referralCode.user_id === referredId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot use your own referral code' });
      }

      const redeemed = await db.transaction(async (q) => {
        // Create redemption (rewards given after first task completion)
        const insertResult = await q(
          `INSERT INTO referral_redemptions (
             referral_code_id, referrer_id, referred_id,
             referrer_reward_cents, referred_reward_cents
           )
           VALUES ($1, $2, $3, 0, 0)
           ON CONFLICT (referred_id) DO NOTHING`,
          [referralCode.id, referralCode.user_id, referredId]
        );

        if ((insertResult.rowCount ?? 0) === 0) {
          return false; // raced: another request redeemed first
        }

        // Increment uses count — same transaction as the redemption row
        await q(
          'UPDATE referral_codes SET uses_count = uses_count + 1 WHERE id = $1',
          [referralCode.id]
        );
        return true;
      });

      if (!redeemed) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Already used a referral code' });
      }

      return {
        success: true,
        message: 'Referral code applied. Cash rewards are not enabled in the Build-Now release.',
      };
    }),

  getReferralStats: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const userId = ctx.user.id;

      const stats = await db.query<{
        total_referrals: string;
        qualified_referrals: string;
        total_earned: string;
      }>(
        `SELECT
          COUNT(*) as total_referrals,
          COUNT(*) FILTER (WHERE qualified = TRUE) as qualified_referrals,
          COALESCE(SUM(referrer_reward_cents) FILTER (WHERE referrer_reward_paid = TRUE), 0) as total_earned
         FROM referral_redemptions WHERE referrer_id = $1`,
        [userId]
      );

      return {
        totalReferrals: parseInt(stats.rows[0]?.total_referrals || '0', 10),
        qualifiedReferrals: parseInt(stats.rows[0]?.qualified_referrals || '0', 10),
        totalEarnedCents: parseInt(stats.rows[0]?.total_earned || '0', 10),
      };
    }),

  /**
   * Called by the task-completion flow when a referred user finishes their
   * first task.  Enforces the REFERRAL_REWARD_CAP before issuing the payout.
   *
   * Input:
   *   redemptionId  — referral_redemptions.id
   *   rewardCents   — reward amount (defaults to 500 = $5)
   */
  issueReward: financialAdminProcedure
    .input(
      z.object({
        redemptionId: z.string().uuid(),
        rewardCents: z.number().int().positive().default(500),
      }),
    )
    .mutation(() => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Cash referral rewards are not available in the Build-Now release.',
      });
    }),
});
