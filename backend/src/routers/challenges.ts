/**
 * Daily Challenges Router v1.0.0
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure } from '../trpc.js';
import { db } from '../db.js';

// Default daily challenges if none exist for today
const DEFAULT_CHALLENGES = [
  { title: 'Complete a Task', description: 'Finish any task today', challenge_type: 'complete_task', target_value: 1, xp_reward: 10 },
  { title: 'Speed Run', description: 'Complete a task in under 30 minutes', challenge_type: 'fast_completion', target_value: 1, xp_reward: 15 },
  { title: 'Keep the Streak', description: 'Maintain your daily streak', challenge_type: 'streak_maintain', target_value: 1, xp_reward: 5 },
];

export const challengesRouter = router({
  getTodaysChallenges: hustlerProcedure
    .input(z.void())
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

      // Auto-create default challenges if none exist (batch insert)
      if (challenges.rows.length === 0) {
        const placeholders = DEFAULT_CHALLENGES.map((_, i) =>
          `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
        ).join(', ');
        const params = DEFAULT_CHALLENGES.flatMap(dc => [
          today, dc.title, dc.description, dc.challenge_type, dc.target_value, dc.xp_reward
        ]);
        await db.query(
          `INSERT INTO daily_challenges (challenge_date, title, description, challenge_type, target_value, xp_reward)
           VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
          params
        );
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

  updateProgress: hustlerProcedure
    .input(z.object({
      challengeId: z.string().uuid(),
      progress: z.number().int().min(0).max(10000),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Get challenge target — must be today's active challenge
      const challenge = await db.query<{ target_value: number; xp_reward: number; challenge_type: string }>(
        `SELECT target_value, xp_reward, challenge_type FROM daily_challenges
         WHERE id = $1 AND challenge_date = CURRENT_DATE AND active = TRUE`,
        [input.challengeId]
      );

      if (challenge.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: "Challenge not found or is not today's active challenge" });
      }

      // Server-side verification: cap progress at what the user has actually completed
      // For task-based challenges (complete_task, fast_completion), cross-reference
      // with actual completed tasks to prevent self-reported cheating.
      // For other challenge types (streak_maintain), cap at the target_value floor.
      const challengeRow = challenge.rows[0] as { target_value: number; xp_reward: number; challenge_type?: string };
      let verifiedProgress = input.progress;

      if (challengeRow.challenge_type === 'complete_task') {
        const actualProgress = await db.query<{ completed_tasks: string }>(
          `SELECT COUNT(*) as completed_tasks
           FROM tasks
           WHERE worker_id = $1 AND state = 'COMPLETED'
             AND updated_at >= CURRENT_DATE
             AND updated_at < CURRENT_DATE + INTERVAL '1 day'`,
          [userId]
        );
        verifiedProgress = Math.min(
          input.progress,
          Number(actualProgress.rows[0].completed_tasks)
        );
      } else if (challengeRow.challenge_type === 'fast_completion') {
        const actualProgress = await db.query<{ completed_tasks: string }>(
          `SELECT COUNT(*) as completed_tasks
           FROM tasks
           WHERE worker_id = $1
             AND state = 'COMPLETED'
             AND updated_at >= CURRENT_DATE
             AND updated_at < CURRENT_DATE + INTERVAL '1 day'
             AND (updated_at - accepted_at) < INTERVAL '30 minutes'`,
          [userId]
        );
        verifiedProgress = Math.min(
          input.progress,
          Number(actualProgress.rows[0].completed_tasks)
        );
      } else {
        // For unrecognized or server-verified challenge types (streak_maintain, etc.),
        // reject self-reported progress — set to 0 and let server-side jobs update it
        verifiedProgress = 0;
      }

      // Hard cap: progress cannot exceed the challenge's target value
      verifiedProgress = Math.min(verifiedProgress, challengeRow.target_value);

      const isCompleted = verifiedProgress >= challengeRow.target_value;

      await db.query(
        `INSERT INTO daily_challenge_completions (challenge_id, user_id, progress, completed, completed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (challenge_id, user_id) DO UPDATE SET
           progress = GREATEST(daily_challenge_completions.progress, $3),
           completed = $4,
           completed_at = CASE WHEN $4 AND NOT daily_challenge_completions.completed THEN NOW() ELSE daily_challenge_completions.completed_at END`,
        [input.challengeId, userId, verifiedProgress, isCompleted, isCompleted ? new Date() : null]
      );

      return { success: true, completed: isCompleted, xpReward: isCompleted ? challengeRow.xp_reward : 0 };
    }),
});
