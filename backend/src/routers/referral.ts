/**
 * Referral Router v1.0.0
 * Manages referral codes, redemption, and rewards
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';

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
  getOrCreateCode: protectedProcedure
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

  redeemCode: protectedProcedure
    .input(z.object({ code: z.string().min(2).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const referredId = ctx.user.id;

      // Check if already referred
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

      // Create redemption (rewards given after first task completion)
      await db.query(
        `INSERT INTO referral_redemptions (referral_code_id, referrer_id, referred_id)
         VALUES ($1, $2, $3)`,
        [referralCode.id, referralCode.user_id, referredId]
      );

      // Increment uses count
      await db.query(
        'UPDATE referral_codes SET uses_count = uses_count + 1 WHERE id = $1',
        [referralCode.id]
      );

      return { success: true, message: 'Referral code applied! Complete your first task to earn $5.' };
    }),

  getReferralStats: protectedProcedure
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
});
