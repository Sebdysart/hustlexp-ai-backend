/**
 * BadgeEvaluationService v1.0.0
 *
 * Defines badge types, earning conditions, and evaluates badge eligibility.
 * Called after task completion, tier promotion, and milestone events.
 */

import { db } from '../db';
import { logger } from '../logger';
import { BadgeService } from './BadgeService';
import type { ServiceResult } from '../types';

const log = logger.child({ service: 'BadgeEvaluationService' });

// ============================================================================
// BADGE DEFINITIONS
// ============================================================================

interface BadgeDefinition {
  type: string;
  name: string;
  description: string;
  icon: string;
  tiers: {
    tier: number;
    requirement: string;
    threshold: number;
  }[];
}

const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    type: 'task_master',
    name: 'Task Master',
    description: 'Complete tasks to earn this badge',
    icon: '⚡',
    tiers: [
      { tier: 1, requirement: 'Complete 5 tasks', threshold: 5 },
      { tier: 2, requirement: 'Complete 25 tasks', threshold: 25 },
      { tier: 3, requirement: 'Complete 100 tasks', threshold: 100 },
      { tier: 4, requirement: 'Complete 500 tasks', threshold: 500 },
    ],
  },
  {
    type: 'five_star',
    name: 'Five Star',
    description: 'Receive 5-star ratings',
    icon: '⭐',
    tiers: [
      { tier: 1, requirement: 'Receive 3 five-star ratings', threshold: 3 },
      { tier: 2, requirement: 'Receive 10 five-star ratings', threshold: 10 },
      { tier: 3, requirement: 'Receive 50 five-star ratings', threshold: 50 },
      { tier: 4, requirement: 'Receive 200 five-star ratings', threshold: 200 },
    ],
  },
  {
    type: 'streak_warrior',
    name: 'Streak Warrior',
    description: 'Maintain daily streaks',
    icon: '🔥',
    tiers: [
      { tier: 1, requirement: '3-day streak', threshold: 3 },
      { tier: 2, requirement: '7-day streak', threshold: 7 },
      { tier: 3, requirement: '14-day streak', threshold: 14 },
      { tier: 4, requirement: '30-day streak', threshold: 30 },
    ],
  },
  {
    type: 'early_bird',
    name: 'Early Bird',
    description: 'Complete tasks before the deadline',
    icon: '🐦',
    tiers: [
      { tier: 1, requirement: 'Complete 3 tasks early', threshold: 3 },
      { tier: 2, requirement: 'Complete 10 tasks early', threshold: 10 },
      { tier: 3, requirement: 'Complete 25 tasks early', threshold: 25 },
      { tier: 4, requirement: 'Complete 100 tasks early', threshold: 100 },
    ],
  },
  {
    type: 'money_maker',
    name: 'Money Maker',
    description: 'Earn through task completions',
    icon: '💰',
    tiers: [
      { tier: 1, requirement: 'Earn $50', threshold: 5000 },
      { tier: 2, requirement: 'Earn $250', threshold: 25000 },
      { tier: 3, requirement: 'Earn $1,000', threshold: 100000 },
      { tier: 4, requirement: 'Earn $5,000', threshold: 500000 },
    ],
  },
  {
    type: 'verified_pro',
    name: 'Verified Pro',
    description: 'Complete verification steps',
    icon: '✅',
    tiers: [
      { tier: 1, requirement: 'Verify email', threshold: 1 },
      { tier: 2, requirement: 'Verify phone', threshold: 2 },
      { tier: 3, requirement: 'Verify ID', threshold: 3 },
      { tier: 4, requirement: 'Complete all verifications', threshold: 4 },
    ],
  },
  {
    type: 'community_hero',
    name: 'Community Hero',
    description: 'Help resolve disputes as a juror',
    icon: '🦸',
    tiers: [
      { tier: 1, requirement: 'Serve on 1 jury', threshold: 1 },
      { tier: 2, requirement: 'Serve on 5 juries', threshold: 5 },
      { tier: 3, requirement: 'Serve on 15 juries', threshold: 15 },
      { tier: 4, requirement: 'Serve on 50 juries', threshold: 50 },
    ],
  },
  {
    type: 'speed_demon',
    name: 'Speed Demon',
    description: 'Complete instant/ASAP tasks',
    icon: '⚡',
    tiers: [
      { tier: 1, requirement: 'Complete 3 instant tasks', threshold: 3 },
      { tier: 2, requirement: 'Complete 10 instant tasks', threshold: 10 },
      { tier: 3, requirement: 'Complete 25 instant tasks', threshold: 25 },
      { tier: 4, requirement: 'Complete 100 instant tasks', threshold: 100 },
    ],
  },
];

export const BadgeEvaluationService = {
  /**
   * Get all badge definitions
   */
  getDefinitions: (): BadgeDefinition[] => BADGE_DEFINITIONS,

  /**
   * Evaluate all badge eligibility for a user after task completion
   */
  evaluateAfterTaskCompletion: async (userId: string, taskId: string): Promise<ServiceResult<string[]>> => {
    const awarded: string[] = [];

    try {
      // Get user stats
      const statsResult = await db.query<{
        tasks_completed: number;
        current_streak: number;
        total_earnings_cents: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM tasks WHERE worker_id = $1 AND state = 'completed')::int as tasks_completed,
          current_streak,
          COALESCE((SELECT SUM(net_payout_cents) FROM verification_earnings_ledger WHERE user_id = $1), 0)::int as total_earnings_cents
         FROM users WHERE id = $1`,
        [userId]
      );

      if (statsResult.rows.length === 0) return { success: true, data: [] };
      const stats = statsResult.rows[0];

      // Get existing badges
      const existingBadges = await BadgeService.getByUserId(userId);
      if (!existingBadges.success) return { success: true, data: [] };

      const userBadges = new Map<string, number>();
      for (const badge of existingBadges.data) {
        const current = userBadges.get(badge.badge_type) || 0;
        userBadges.set(badge.badge_type, Math.max(current, badge.badge_tier));
      }

      // Evaluate task_master
      const taskMaster = BADGE_DEFINITIONS.find(b => b.type === 'task_master')!;
      for (const tier of taskMaster.tiers) {
        if (stats.tasks_completed >= tier.threshold && (userBadges.get('task_master') || 0) < tier.tier) {
          const result = await BadgeService.award({
            userId, badgeType: 'task_master', badgeTier: tier.tier,
            awardedFor: tier.requirement, taskId,
          });
          if (result.success) awarded.push(`task_master_${tier.tier}`);
        }
      }

      // Evaluate streak_warrior
      const streakWarrior = BADGE_DEFINITIONS.find(b => b.type === 'streak_warrior')!;
      for (const tier of streakWarrior.tiers) {
        if (stats.current_streak >= tier.threshold && (userBadges.get('streak_warrior') || 0) < tier.tier) {
          const result = await BadgeService.award({
            userId, badgeType: 'streak_warrior', badgeTier: tier.tier,
            awardedFor: tier.requirement, taskId,
          });
          if (result.success) awarded.push(`streak_warrior_${tier.tier}`);
        }
      }

      // Evaluate money_maker
      const moneyMaker = BADGE_DEFINITIONS.find(b => b.type === 'money_maker')!;
      for (const tier of moneyMaker.tiers) {
        if (stats.total_earnings_cents >= tier.threshold && (userBadges.get('money_maker') || 0) < tier.tier) {
          const result = await BadgeService.award({
            userId, badgeType: 'money_maker', badgeTier: tier.tier,
            awardedFor: tier.requirement, taskId,
          });
          if (result.success) awarded.push(`money_maker_${tier.tier}`);
        }
      }

      // Evaluate five_star
      const fiveStarCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM ratings WHERE ratee_id = $1 AND stars = 5`,
        [userId]
      );
      const fiveStars = parseInt(fiveStarCount.rows[0]?.count || '0', 10);
      const fiveStarDef = BADGE_DEFINITIONS.find(b => b.type === 'five_star')!;
      for (const tier of fiveStarDef.tiers) {
        if (fiveStars >= tier.threshold && (userBadges.get('five_star') || 0) < tier.tier) {
          const result = await BadgeService.award({
            userId, badgeType: 'five_star', badgeTier: tier.tier,
            awardedFor: tier.requirement, taskId,
          });
          if (result.success) awarded.push(`five_star_${tier.tier}`);
        }
      }

      // Send notifications for awarded badges
      for (const badgeKey of awarded) {
        const [type, tierStr] = badgeKey.split('_').reduce((acc, part, i, arr) => {
          if (i === arr.length - 1) return [acc[0], part];
          return [acc[0] ? `${acc[0]}_${part}` : part, acc[1]];
        }, ['', ''] as [string, string]);

        const def = BADGE_DEFINITIONS.find(b => b.type === type);
        if (def) {
          await db.query(
            `INSERT INTO notifications (user_id, type, title, body, data, created_at)
             VALUES ($1, 'badge_earned', $2, $3, $4, NOW())`,
            [
              userId,
              `${def.icon} Badge Earned: ${def.name}!`,
              `You earned the ${def.name} badge (Tier ${tierStr})!`,
              JSON.stringify({ badge_type: type, badge_tier: parseInt(tierStr) })
            ]
          );
        }
      }

      return { success: true, data: awarded };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId, taskId }, 'evaluateAfterTaskCompletion failed');
      return { success: true, data: awarded }; // Return what we got so far
    }
  },
};

export default BadgeEvaluationService;
