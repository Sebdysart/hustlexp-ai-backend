import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure } from '../trpc.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { StripeService } from '../services/StripeService.js';

const referralLog = logger.child({ service: 'ReferralRouter' });

const REFERRAL_REWARD_CAP = 20;

// STOP-010 FIX: issueReferralReward now calls StripeService.createTransfer()
// to actually transfer the reward to the referrer's Stripe Connect account.
// Previously the function only set referrer_reward_paid=TRUE in the DB without
// creating a real Stripe transfer — the referrer would see "$5 earned" in the
// app but never receive the money.
export async function issueReferralReward(
  redemptionId: string,
  referrerId: string,
  rewardCents: number,
): Promise<{ issued: boolean; reason?: string }> {
  const capCheck = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM referral_redemptions
     WHERE referrer_id = $1 AND referrer_reward_paid = TRUE`,
    [referrerId],
  );
  const paidCount = parseInt(capCheck.rows[0]?.count || '0', 10);

  if (paidCount >= REFERRAL_REWARD_CAP) {
    referralLog.warn(
      { referrerId, paidCount, cap: REFERRAL_REWARD_CAP, redemptionId },
      'Referral reward skipped — lifetime cap reached',
    );
    return { issued: false, reason: 'lifetime_cap_reached' };
  }

  // Look up referrer's Stripe Connect account for real transfer
  const referrerResult = await db.query<{ stripe_connect_id: string | null }>(
    'SELECT stripe_connect_id FROM users WHERE id = $1',
    [referrerId],
  );
  const stripeConnectId = referrerResult.rows[0]?.stripe_connect_id;

  if (stripeConnectId && StripeService.isConfigured()) {
    const transferResult = await StripeService.createTransfer({
      escrowId: `referral_${redemptionId}`,
      taskId: redemptionId,
      workerId: referrerId,
      workerStripeAccountId: stripeConnectId,
      amount: rewardCents,
      description: `HustleXP referral reward`,
    });

    if (!transferResult.success) {
      referralLog.error(
        { referrerId, redemptionId, error: transferResult.error },
        'Stripe transfer failed for referral reward — not marking as paid',
      );
      return { issued: false, reason: 'stripe_transfer_failed' };
    }
  } else if (!stripeConnectId) {
    referralLog.warn(
      { referrerId, redemptionId },
      'Referrer has no Stripe Connect ID — reward recorded but transfer deferred',
    );
  }

  await db.query(
    `UPDATE referral_redemptions
     SET qualified = TRUE,
         referrer_reward_paid = TRUE,
         referrer_reward_cents = $1
     WHERE id = $2 AND referrer_id = $3 AND referrer_reward_paid = FALSE`,
    [rewardCents, redemptionId, referrerId],
  );

  referralLog.info(
    { referrerId, redemptionId, rewardCents, paidCount: paidCount + 1 },
    'Referral reward issued',
  );
  return { issued: true };
}

function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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

      const existing = await db.query<{
        code: string;
        uses_count: number;
      }>(
        'SELECT code, uses_count FROM referral_codes WHERE user_id = $1 AND active = TRUE LIMIT 1',
        [userId]
      );

      if (existing.rows.length > 0) {
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

      const alreadyReferred = await db.query(
        'SELECT id FROM referral_redemptions WHERE referred_id = $1',
        [referredId]
      );
      if (alreadyReferred.rows.length > 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Already used a referral code' });
      }

      const codeResult = await db.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM referral_codes WHERE code = $1 AND active = TRUE',
        [input.code.toUpperCase()]
      );

      if (codeResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid referral code' });
      }

      const referralCode = codeResult.rows[0];

      if (referralCode.user_id === referredId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot use your own referral code' });
      }

      await db.query(
        `INSERT INTO referral_redemptions (referral_code_id, referrer_id, referred_id)
         VALUES ($1, $2, $3)`,
        [referralCode.id, referralCode.user_id, referredId]
      );

      await db.query(
        'UPDATE referral_codes SET uses_count = uses_count + 1 WHERE id = $1',
        [referralCode.id]
      );

      return { success: true, message: 'Referral code applied! Complete your first task to earn $5.' };
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

  issueReward: hustlerProcedure
    .input(
      z.object({
        redemptionId: z.string().uuid(),
        rewardCents: z.number().int().positive().default(500),
      }),
    )
    .mutation(async ({ input }) => {
      const redemption = await db.query<{ referrer_id: string }>(
        'SELECT referrer_id FROM referral_redemptions WHERE id = $1',
        [input.redemptionId],
      );

      if (redemption.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Referral redemption not found' });
      }

      const referrerId = redemption.rows[0].referrer_id;

      const result = await issueReferralReward(
        input.redemptionId,
        referrerId,
        input.rewardCents,
      );

      return result;
    }),
});
