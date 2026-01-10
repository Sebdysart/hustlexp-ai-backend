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
   */
  listBroadcasts: protectedProcedure
    .input(z.object({
      latitude: z.number(),
      longitude: z.number(),
      radiusMiles: z.number().default(5),
    }))
    .query(async ({ ctx, input }) => {
      // TODO: Implement geo-bounded broadcast query
      // For now, return empty array
      return [];
    }),
});

export type LiveRouter = typeof liveRouter;
