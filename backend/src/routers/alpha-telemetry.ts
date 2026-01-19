/**
 * Alpha Telemetry Router
 * 
 * Endpoints for querying alpha instrumentation data for health dashboard.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';
import { AlphaInstrumentation } from '../services/AlphaInstrumentation';

export const alphaTelemetryRouter = router({
  /**
   * Get edge state distribution
   * Returns count of each edge state type over time period
   */
  getEdgeStateDistribution: protectedProcedure
    .input(z.object({
      start_date: z.date(),
      end_date: z.date().optional(),
      role: z.enum(['hustler', 'poster']).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const endDate = input.end_date || new Date();
      
      const result = await db.query(`
        SELECT 
          state,
          COUNT(*) as count,
          COUNT(DISTINCT user_id) as unique_users
        FROM alpha_telemetry
        WHERE event_group = 'edge_state_impression'
          AND timestamp >= $1
          AND timestamp <= $2
          ${input.role ? 'AND role = $3' : ''}
        GROUP BY state
        ORDER BY count DESC
      `, input.role 
        ? [input.start_date, endDate, input.role]
        : [input.start_date, endDate]
      );

      return result.rows;
    }),

  /**
   * Get average time spent per edge state
   */
  getEdgeStateTimeSpent: protectedProcedure
    .input(z.object({
      start_date: z.date(),
      end_date: z.date().optional(),
      state: z.enum(['E1_NO_TASKS_AVAILABLE', 'E2_ELIGIBILITY_MISMATCH', 'E3_TRUST_TIER_LOCKED']).optional(),
    }))
    .query(async ({ input }) => {
      const endDate = input.end_date || new Date();
      
      // PostgreSQL PERCENTILE_CONT requires window function or subquery
      const result = await db.query(`
        SELECT 
          state,
          AVG(time_on_screen_ms)::integer as avg_time_ms,
          (
            SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_on_screen_ms)
            FROM alpha_telemetry t2
            WHERE t2.state = t1.state
              AND t2.event_group = 'edge_state_exit'
              AND t2.timestamp >= $1
              AND t2.timestamp <= $2
          )::integer as median_time_ms,
          (
            SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY time_on_screen_ms)
            FROM alpha_telemetry t3
            WHERE t3.state = t1.state
              AND t3.event_group = 'edge_state_exit'
              AND t3.timestamp >= $1
              AND t3.timestamp <= $2
          )::integer as p90_time_ms,
          COUNT(*)::integer as exit_count
        FROM alpha_telemetry t1
        WHERE event_group = 'edge_state_exit'
          AND timestamp >= $1
          AND timestamp <= $2
          ${input.state ? 'AND state = $3' : ''}
        GROUP BY state
      `, input.state
        ? [input.start_date, endDate, input.state]
        : [input.start_date, endDate]
      );

      return result.rows;
    }),

  /**
   * Get dispute attempts per 100 tasks
   */
  getDisputeRate: protectedProcedure
    .input(z.object({
      start_date: z.date(),
      end_date: z.date().optional(),
    }))
    .query(async ({ input }) => {
      const endDate = input.end_date || new Date();
      
      // Get total task completions in period
      const taskCount = await db.query(`
        SELECT COUNT(*) as total_tasks
        FROM tasks
        WHERE state = 'COMPLETED'
          AND completed_at >= $1
          AND completed_at <= $2
      `, [input.start_date, endDate]);

      const totalTasks = parseInt(taskCount.rows[0]?.total_tasks || '0');

      // Get dispute attempts in period
      const disputeAttempts = await db.query(`
        SELECT COUNT(*) as total_attempts
        FROM alpha_telemetry
        WHERE event_group = 'dispute_entry_attempt'
          AND timestamp >= $1
          AND timestamp <= $2
      `, [input.start_date, endDate]);

      const totalAttempts = parseInt(disputeAttempts.rows[0]?.total_attempts || '0');

      return {
        total_tasks: totalTasks,
        total_attempts: totalAttempts,
        dispute_rate_per_100: totalTasks > 0 ? (totalAttempts / totalTasks) * 100 : 0,
      };
    }),

  /**
   * Get proof failure → correction success rate
   */
  getProofCorrectionRate: protectedProcedure
    .input(z.object({
      start_date: z.date(),
      end_date: z.date().optional(),
    }))
    .query(async ({ input }) => {
      const endDate = input.end_date || new Date();
      
      // Get proof failures (attempt_number = 2 and verification_result = 'fail')
      const failures = await db.query(`
        SELECT COUNT(*) as total_failures
        FROM alpha_telemetry
        WHERE event_group = 'proof_submission'
          AND attempt_number = 2
          AND verification_result = 'fail'
          AND timestamp >= $1
          AND timestamp <= $2
      `, [input.start_date, endDate]);

      const totalFailures = parseInt(failures.rows[0]?.total_failures || '0');

      // Get corrections that resolved
      const resolved = await db.query(`
        SELECT COUNT(*) as total_resolved
        FROM alpha_telemetry
        WHERE event_group = 'proof_correction_outcome'
          AND resolved = true
          AND timestamp >= $1
          AND timestamp <= $2
      `, [input.start_date, endDate]);

      const totalResolved = parseInt(resolved.rows[0]?.total_resolved || '0');

      return {
        total_failures: totalFailures,
        total_resolved: totalResolved,
        correction_success_rate: totalFailures > 0 ? (totalResolved / totalFailures) * 100 : 0,
      };
    }),

  /**
   * Get trust tier movement histogram
   */
  getTrustTierMovement: protectedProcedure
    .input(z.object({
      start_date: z.date(),
      end_date: z.date().optional(),
      delta_type: z.enum(['xp', 'tier', 'streak']).optional(),
    }))
    .query(async ({ input }) => {
      const endDate = input.end_date || new Date();
      
      const result = await db.query(`
        SELECT 
          delta_type,
          reason_code,
          COUNT(*) as count,
          AVG(delta_amount) as avg_delta,
          SUM(delta_amount) as total_delta
        FROM alpha_telemetry
        WHERE event_group = 'trust_delta_applied'
          AND timestamp >= $1
          AND timestamp <= $2
          ${input.delta_type ? 'AND delta_type = $3' : ''}
        GROUP BY delta_type, reason_code
        ORDER BY count DESC
      `, input.delta_type
        ? [input.start_date, endDate, input.delta_type]
        : [input.start_date, endDate]
      );

      return result.rows;
    }),

  /**
   * Emit edge state impression event
   * Fire once when edge screen becomes primary visible screen
   */
  emitEdgeStateImpression: protectedProcedure
    .input(z.object({
      state: z.enum(['E1_NO_TASKS_AVAILABLE', 'E2_ELIGIBILITY_MISMATCH', 'E3_TRUST_TIER_LOCKED']),
      role: z.enum(['hustler', 'poster']),
      trust_tier: z.number().int(),
      location_radius_miles: z.number().optional(),
      instant_mode_enabled: z.boolean(),
      edge_state_version: z.string().default('v1'),
    }))
    .mutation(async ({ input, ctx }) => {
      await AlphaInstrumentation.emitEdgeStateImpression({
        user_id: ctx.user.id,
        role: input.role,
        state: input.state,
        trust_tier: input.trust_tier,
        location_radius_miles: input.location_radius_miles,
        instant_mode_enabled: input.instant_mode_enabled,
        timestamp: new Date(),
      });
      return { success: true };
    }),

  /**
   * Emit edge state exit event
   * Fire when user leaves the edge screen (navigation or explicit action)
   * Note: App background exits excluded in v1
   */
  emitEdgeStateExit: protectedProcedure
    .input(z.object({
      state: z.enum(['E1_NO_TASKS_AVAILABLE', 'E2_ELIGIBILITY_MISMATCH', 'E3_TRUST_TIER_LOCKED']),
      role: z.enum(['hustler', 'poster']),
      time_on_screen_ms: z.number().int().positive(),
      exit_type: z.enum(['continue', 'back', 'app_background', 'session_end']),
      edge_state_version: z.string().default('v1'),
    }))
    .mutation(async ({ input, ctx }) => {
      // Clamp duration to minimum 250ms to prevent zero-duration noise
      const clampedDuration = Math.max(input.time_on_screen_ms, 250);
      
      await AlphaInstrumentation.emitEdgeStateExit({
        user_id: ctx.user.id,
        role: input.role,
        state: input.state,
        time_on_screen_ms: clampedDuration,
        exit_type: input.exit_type,
        timestamp: new Date(),
      });
      return { success: true };
    }),
});
