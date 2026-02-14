/**
 * Matchmaker AI Router v1.0.0
 *
 * CONSTITUTIONAL: AI_INFRASTRUCTURE.md, Authority Level A2 (Proposal-Only)
 *
 * Endpoints for AI-powered task-worker matching, match explanations,
 * and price suggestions.
 *
 * @see backend/src/services/MatchmakerAIService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { MatchmakerAIService } from '../services/MatchmakerAIService';
import { db } from '../db';

export const matchmakerRouter = router({
  // --------------------------------------------------------------------------
  // CANDIDATE RANKING (Admin Only)
  // --------------------------------------------------------------------------

  /**
   * Rank candidate workers for a task.
   *
   * Fetches the task and eligible candidates from the database,
   * then calls MatchmakerAIService.rankCandidates for AI-powered ranking.
   *
   * AI_INFRASTRUCTURE.md: A2 authority - proposals only, cannot assign workers.
   */
  rankCandidates: adminProcedure
    .input(z.object({
      taskId: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      // Fetch task from DB
      const taskResult = await db.query<{
        id: string; title: string; description: string;
        category: string | null; location_text: string | null; price: number;
        requirements: string | null;
      }>('SELECT id, title, description, category, location_text, price, requirements FROM tasks WHERE id = $1', [input.taskId]);

      if (taskResult.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }

      const taskRow = taskResult.rows[0];
      const task = {
        id: taskRow.id,
        title: taskRow.title,
        description: taskRow.description,
        category: taskRow.category ?? undefined,
        location: taskRow.location_text ?? undefined,
        price: taskRow.price,
        requirements: taskRow.requirements ?? undefined,
      };

      // Fetch eligible candidates from DB
      const candidateResult = await db.query<{
        id: string; trust_tier: number; completed_tasks: number;
        completion_rate: number; average_rating: number | null;
      }>(`SELECT u.id, u.trust_tier,
          COALESCE((SELECT COUNT(*) FROM tasks WHERE worker_id = u.id AND state = 'COMPLETED'), 0)::int as completed_tasks,
          COALESCE((SELECT COUNT(*) FILTER(WHERE state = 'COMPLETED')::float / NULLIF(COUNT(*) FILTER(WHERE state IN ('COMPLETED','CANCELLED')), 0) FROM tasks WHERE worker_id = u.id), 1.0) as completion_rate,
          (SELECT AVG(stars)::float FROM task_ratings WHERE ratee_id = u.id) as average_rating
         FROM users u
         WHERE u.default_mode IN ('hustler', 'flex')
         AND u.account_status = 'active'
         LIMIT 50`);

      const candidates = candidateResult.rows.map((c) => ({
        userId: c.id,
        trustTier: c.trust_tier,
        completedTasks: c.completed_tasks,
        completionRate: c.completion_rate,
        averageRating: c.average_rating ?? undefined,
        isAvailable: true,
      }));

      const result = await MatchmakerAIService.rankCandidates(task, candidates);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // MATCH EXPLANATION
  // --------------------------------------------------------------------------

  /**
   * "Why this task?" explanation for the iOS app.
   *
   * Returns a human-readable explanation of why a task was recommended
   * to a specific worker.
   */
  explainMatch: protectedProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      userId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      // Fetch task from DB
      const taskResult = await db.query<{
        id: string; title: string; description: string;
        category: string | null; location_text: string | null; price: number;
        requirements: string | null;
      }>('SELECT id, title, description, category, location_text, price, requirements FROM tasks WHERE id = $1', [input.taskId]);

      if (taskResult.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }

      const taskRow = taskResult.rows[0];
      const task = {
        id: taskRow.id,
        title: taskRow.title,
        description: taskRow.description,
        category: taskRow.category ?? undefined,
        location: taskRow.location_text ?? undefined,
        price: taskRow.price,
        requirements: taskRow.requirements ?? undefined,
      };

      // Fetch worker profile from DB
      const workerResult = await db.query<{
        id: string; trust_tier: number; completed_tasks: number;
        completion_rate: number; average_rating: number | null;
      }>(`SELECT u.id, u.trust_tier,
          COALESCE((SELECT COUNT(*) FROM tasks WHERE worker_id = u.id AND state = 'COMPLETED'), 0)::int as completed_tasks,
          COALESCE((SELECT COUNT(*) FILTER(WHERE state = 'COMPLETED')::float / NULLIF(COUNT(*) FILTER(WHERE state IN ('COMPLETED','CANCELLED')), 0) FROM tasks WHERE worker_id = u.id), 1.0) as completion_rate,
          (SELECT AVG(stars)::float FROM task_ratings WHERE ratee_id = u.id) as average_rating
         FROM users u
         WHERE u.id = $1`, [input.userId]);

      if (workerResult.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Worker not found',
        });
      }

      const w = workerResult.rows[0];
      const worker = {
        userId: w.id,
        trustTier: w.trust_tier,
        completedTasks: w.completed_tasks,
        completionRate: w.completion_rate,
        averageRating: w.average_rating ?? undefined,
        isAvailable: true,
      };

      const result = await MatchmakerAIService.explainMatch(task, worker);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // PRICE SUGGESTION
  // --------------------------------------------------------------------------

  /**
   * Lightweight price hint for task posters.
   *
   * Uses heuristics first; only calls AI if heuristic confidence is low.
   */
  suggestPrice: protectedProcedure
    .input(z.object({
      title: z.string(),
      description: z.string(),
      category: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const taskDescription = `${input.title} - ${input.description}`;

      const result = await MatchmakerAIService.suggestPrice(
        taskDescription,
        input.category,
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});

export type MatchmakerRouter = typeof matchmakerRouter;
