/**
 * Daily Challenges Router v1.0.0
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';

// Default daily challenges if none exist for today
const DEFAULT_CHALLENGES = [
  { title: 'Complete a Task', description: 'Finish any task today', challenge_type: 'complete_task', target_value: 1, xp_reward: 10 },
  { title: 'Speed Run', description: 'Complete a task in under 30 minutes', challenge_type: 'fast_completion', target_value: 1, xp_reward: 15 },
  { title: 'Keep the Streak', description: 'Maintain your daily streak', challenge_type: 'streak_maintain', target_value: 1, xp_reward: 5 },
];

export const challengesRouter = router({
  getTodaysChallenges: protectedProcedure
    .query(async ({ ctx }) => {
      const userId = ctx.user.id;
      const today = new Date().toISOString().split('T')[0];

      // Get today's challenges
      let challenges = await db.query<{
        id: string;
        title: string;
        description: string;
        challenge_type: string;
        target_value: number;
        xp_reward: number;
      }>(
        'SELECT * FROM daily_challenges WHERE challenge_date = $1 AND active = TRUE',
        [today]
      );

      // Auto-create default challenges if none exist
      if (challenges.rows.length === 0) {
        for (const dc of DEFAULT_CHALLENGES) {
          await db.query(
            `INSERT INTO daily_challenges (challenge_date, title, description, challenge_type, target_value, xp_reward)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [today, dc.title, dc.description, dc.challenge_type, dc.target_value, dc.xp_reward]
          );
        }
        challenges = await db.query(
          'SELECT * FROM daily_challenges WHERE challenge_date = $1 AND active = TRUE',
          [today]
        );
      }

      // Get user progress
      const progress = await db.query<{
        challenge_id: string;
        progress: number;
        completed: boolean;
      }>(
        `SELECT challenge_id, progress, completed
         FROM daily_challenge_completions
         WHERE user_id = $1 AND challenge_id = ANY($2::uuid[])`,
        [userId, challenges.rows.map(c => c.id)]
      );

      const progressMap = new Map(progress.rows.map(p => [p.challenge_id, p]));

      return challenges.rows.map(c => ({
        id: c.id,
        title: c.title,
        description: c.description,
        challengeType: c.challenge_type,
        targetValue: c.target_value,
        xpReward: c.xp_reward,
        progress: progressMap.get(c.id)?.progress || 0,
        completed: progressMap.get(c.id)?.completed || false,
      }));
    }),

  updateProgress: protectedProcedure
    .input(z.object({
      challengeId: z.string().uuid(),
      progress: z.number().min(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Get challenge target
      const challenge = await db.query<{ target_value: number; xp_reward: number }>(
        'SELECT target_value, xp_reward FROM daily_challenges WHERE id = $1',
        [input.challengeId]
      );

      if (challenge.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
      }

      const isCompleted = input.progress >= challenge.rows[0].target_value;

      await db.query(
        `INSERT INTO daily_challenge_completions (challenge_id, user_id, progress, completed, completed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (challenge_id, user_id) DO UPDATE SET
           progress = GREATEST(daily_challenge_completions.progress, $3),
           completed = $4,
           completed_at = CASE WHEN $4 AND NOT daily_challenge_completions.completed THEN NOW() ELSE daily_challenge_completions.completed_at END`,
        [input.challengeId, userId, input.progress, isCompleted, isCompleted ? new Date() : null]
      );

      return { success: true, completed: isCompleted, xpReward: isCompleted ? challenge.rows[0].xp_reward : 0 };
    }),
});
