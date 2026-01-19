/**
 * UI Router v1.0.0
 * 
 * CONSTITUTIONAL: Frontend UI compliance endpoints
 * 
 * Provides endpoints for:
 * - Animation tracking (first XP celebration, badge animations)
 * - Violation reporting
 * - State confirmation helpers
 * 
 * @see UI_SPEC.md §8.2, §8.4, ONBOARDING_SPEC.md §13.4
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';
import { z } from 'zod';

export const uiRouter = router({
  // --------------------------------------------------------------------------
  // ANIMATION TRACKING (ONBOARDING_SPEC §13.4, UI_SPEC §3.5)
  // --------------------------------------------------------------------------
  
  /**
   * Check if first XP celebration should be shown
   * Returns true if xp_first_celebration_shown_at IS NULL
   */
  getXPCelebrationStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
        `SELECT xp_first_celebration_shown_at FROM users WHERE id = $1`,
        [ctx.user.id]
      );
      
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }
      
      const shouldShow = result.rows[0].xp_first_celebration_shown_at === null;
      
      return {
        shouldShow,
        xpFirstCelebrationShownAt: result.rows[0].xp_first_celebration_shown_at?.toISOString() || null,
      };
    }),
  
  /**
   * Mark first XP celebration as shown
   * Sets xp_first_celebration_shown_at = NOW()
   */
  markXPCelebrationShown: protectedProcedure
    .input(z.object({
      timestamp: z.string().optional(), // Optional, defaults to NOW()
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE users 
         SET xp_first_celebration_shown_at = COALESCE($2::timestamptz, NOW())
         WHERE id = $1 AND xp_first_celebration_shown_at IS NULL
         RETURNING xp_first_celebration_shown_at`,
        [
          ctx.user.id,
          input.timestamp ? new Date(input.timestamp) : null,
        ]
      );
      
      if (result.rows.length === 0) {
        // Already marked as shown, return current value
        const current = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
          `SELECT xp_first_celebration_shown_at FROM users WHERE id = $1`,
          [ctx.user.id]
        );
        
        return {
          success: true,
          xpFirstCelebrationShownAt: current.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
          alreadyShown: true,
        };
      }
      
      return {
        success: true,
        xpFirstCelebrationShownAt: result.rows[0].xp_first_celebration_shown_at.toISOString(),
        alreadyShown: false,
      };
    }),
  
  /**
   * Check if badge animation should be shown
   * Returns true if animation_shown_at IS NULL for the badge
   */
  getBadgeAnimationStatus: protectedProcedure
    .input(z.object({
      badgeId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      const result = await db.query<{ animation_shown_at: Date | null }>(
        `SELECT animation_shown_at FROM badges 
         WHERE id = $1 AND user_id = $2`,
        [input.badgeId, ctx.user.id]
      );
      
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Badge not found',
        });
      }
      
      const shouldShow = result.rows[0].animation_shown_at === null;
      
      return {
        shouldShow,
        animationShownAt: result.rows[0].animation_shown_at?.toISOString() || null,
      };
    }),
  
  /**
   * Mark badge animation as shown
   * Sets animation_shown_at = NOW() for the badge
   */
  markBadgeAnimationShown: protectedProcedure
    .input(z.object({
      badgeId: z.string().uuid(),
      timestamp: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE badges 
         SET animation_shown_at = COALESCE($3::timestamptz, NOW())
         WHERE id = $1 AND user_id = $2 AND animation_shown_at IS NULL
         RETURNING animation_shown_at`,
        [
          input.badgeId,
          ctx.user.id,
          input.timestamp ? new Date(input.timestamp) : null,
        ]
      );
      
      if (result.rows.length === 0) {
        // Already marked as shown or badge doesn't exist
        const current = await db.query<{ animation_shown_at: Date | null }>(
          `SELECT animation_shown_at FROM badges WHERE id = $1 AND user_id = $2`,
          [input.badgeId, ctx.user.id]
        );
        
        if (current.rows.length === 0) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Badge not found',
          });
        }
        
        return {
          success: true,
          animationShownAt: current.rows[0]?.animation_shown_at?.toISOString() || null,
          alreadyShown: true,
        };
      }
      
      return {
        success: true,
        animationShownAt: result.rows[0].animation_shown_at.toISOString(),
        alreadyShown: false,
      };
    }),
  
  // --------------------------------------------------------------------------
  // VIOLATION REPORTING (UI_SPEC §8.4)
  // --------------------------------------------------------------------------
  
  /**
   * Report UI_SPEC violation
   * Logs violation for monitoring and compliance tracking
   * Uses admin_actions table for audit trail (append-only)
   */
  reportViolation: protectedProcedure
    .input(z.object({
      type: z.enum(['COLOR', 'ANIMATION', 'COPY', 'ACCESSIBILITY', 'STATE']),
      rule: z.string(),
      component: z.string(),
      context: z.record(z.any()),
      severity: z.enum(['ERROR', 'WARNING']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Log violation to admin_actions for audit trail (append-only)
      // Using 'UI_VIOLATION' as action type
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, action_type, details, created_at)
         VALUES ($1, 'UI_VIOLATION', $2, NOW())`,
        [
          ctx.user.id,
          JSON.stringify({
            violationType: input.type,
            rule: input.rule,
            component: input.component,
            context: input.context,
            severity: input.severity || 'ERROR',
          }),
        ]
      );
      
      return {
        success: true,
        loggedAt: new Date().toISOString(),
      };
    }),
});
