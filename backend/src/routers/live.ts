/**
 * Live Router v1.0.0
 * 
 * CONSTITUTIONAL: Live Mode endpoints
 * 
 * @see PRODUCT_SPEC.md §3.5-3.6
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';
import { z } from 'zod';

export const liveRouter = router({
  // --------------------------------------------------------------------------
  // LIVE MODE SESSION MANAGEMENT
  // --------------------------------------------------------------------------
  
  /**
   * Toggle Live Mode on/off
   * Enforces cooldown (HX904) and ban checks (HX905)
   */
  toggle: protectedProcedure
    .input(z.object({
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user;
      
      // Check if banned
      if (user.live_mode_banned_until && new Date(user.live_mode_banned_until) > new Date()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Live Mode is banned until ${user.live_mode_banned_until}`,
        });
      }
      
      // Check cooldown (HX904)
      if (user.live_mode_state === 'COOLDOWN') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Live Mode is in cooldown. Please wait before toggling again.',
        });
      }
      
      const newState = input.enabled ? 'ACTIVE' : 'OFF';
      const sessionStartedAt = input.enabled ? new Date() : null;
      
      try {
        const result = await db.query(
          `UPDATE users
           SET live_mode_state = $1,
               live_mode_session_started_at = $2
           WHERE id = $3
           RETURNING *`,
          [newState, sessionStartedAt, user.id]
        );
        
        return result.rows[0];
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to toggle Live Mode',
        });
      }
    }),
  
  /**
   * Get Live Mode status
   */
  getStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const user = ctx.user;
      
      return {
        state: user.live_mode_state,
        sessionStartedAt: user.live_mode_session_started_at,
        bannedUntil: user.live_mode_banned_until,
        totalTasks: user.live_mode_total_tasks,
        completionRate: user.live_mode_completion_rate,
      };
    }),
  
  /**
   * Get active Live Mode broadcasts (for hustlers)
   * 
   * PRODUCT_SPEC §3.5: Returns active live broadcasts within geo radius
   * 
   * Note: Currently returns all active broadcasts. Geo-bounded filtering
   * requires latitude/longitude columns on tasks table (future enhancement).
   */
  listBroadcasts: protectedProcedure
    .input(z.object({
      latitude: z.number(),
      longitude: z.number(),
      radiusMiles: z.number().default(5),
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      try {
        // Query active live broadcasts (not expired, not accepted)
        // Join with tasks to get task details
        // Note: Geo-bounded filtering requires latitude/longitude columns on tasks table
        // For now, return all active broadcasts within the provided radius
        const result = await db.query<{
          id: string;
          task_id: string;
          started_at: Date;
          expired_at: Date | null;
          initial_radius_miles: number;
          final_radius_miles: number | null;
          hustlers_notified: number;
          hustlers_viewed: number;
          // Task fields
          task_title: string;
          task_price: number;
          task_location: string | null;
          task_category: string | null;
          task_deadline: Date | null;
        }>(
          `SELECT 
            lb.id,
            lb.task_id,
            lb.started_at,
            lb.expired_at,
            lb.initial_radius_miles,
            lb.final_radius_miles,
            lb.hustlers_notified,
            lb.hustlers_viewed,
            t.title as task_title,
            t.price as task_price,
            t.location as task_location,
            t.category as task_category,
            t.deadline as task_deadline
          FROM live_broadcasts lb
          INNER JOIN tasks t ON t.id = lb.task_id
          WHERE lb.expired_at IS NULL
            AND lb.accepted_at IS NULL
            AND t.state = 'OPEN'
            AND t.mode = 'LIVE'
            AND (
              lb.final_radius_miles IS NULL 
              OR lb.final_radius_miles >= $1
            )
          ORDER BY lb.started_at DESC
          LIMIT 50`,
          [input.radiusMiles]
        );
        
        // TODO: Add geo-bounded filtering once tasks table has latitude/longitude columns
        // For now, filter by initial_radius_miles which is stored on broadcast
        // Full implementation would use Haversine formula or PostgreSQL earthdistance extension
        
        return result.rows.map(broadcast => ({
          id: broadcast.id,
          taskId: broadcast.task_id,
          startedAt: broadcast.started_at.toISOString(),
          expiredAt: broadcast.expired_at?.toISOString() || null,
          initialRadiusMiles: Number(broadcast.initial_radius_miles),
          finalRadiusMiles: broadcast.final_radius_miles ? Number(broadcast.final_radius_miles) : null,
          hustlersNotified: broadcast.hustlers_notified,
          hustlersViewed: broadcast.hustlers_viewed,
          task: {
            id: broadcast.task_id,
            title: broadcast.task_title,
            price: broadcast.task_price,
            location: broadcast.task_location,
            category: broadcast.task_category,
            deadline: broadcast.task_deadline?.toISOString() || null,
          },
        }));
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to fetch live broadcasts',
        });
      }
    }),
});

export type LiveRouter = typeof liveRouter;
