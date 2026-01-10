/**
 * User Router v1.0.0
 * 
 * User profile and authentication endpoints
 * 
 * @see PRODUCT_SPEC.md §5 (XP), §6 (Trust)
 */

import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure, Schemas } from '../trpc';
import { db } from '../db';
import { XPService } from '../services/XPService';
import type { User } from '../types';
import { z } from 'zod';

export const userRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get current user profile
   */
  me: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.user;
    }),
  
  /**
   * Get user by ID (public profile)
   */
  getById: protectedProcedure
    .input(z.object({ userId: Schemas.uuid }))
    .query(async ({ input }) => {
      const result = await db.query<User>(
        `SELECT id, full_name, avatar_url, trust_tier, xp_total, current_level, 
                current_streak, is_verified, created_at
         FROM users WHERE id = $1`,
        [input.userId]
      );
      
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }
      
      return result.rows[0];
    }),
  
  /**
   * Get XP history
   */
  xpHistory: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await XPService.getHistory(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get user badges
   */
  badges: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await db.query(
        `SELECT * FROM badges WHERE user_id = $1 ORDER BY awarded_at DESC`,
        [ctx.user.id]
      );
      
      return result.rows;
    }),
  
  // --------------------------------------------------------------------------
  // REGISTRATION (Firebase → HustleXP)
  // --------------------------------------------------------------------------
  
  /**
   * Register new user (after Firebase auth)
   */
  register: publicProcedure
    .input(z.object({
      firebaseUid: z.string(),
      email: z.string().email(),
      fullName: z.string().min(1).max(255),
      defaultMode: z.enum(['worker', 'poster']).default('worker'),
    }))
    .mutation(async ({ input }) => {
      // Check if user already exists
      const existing = await db.query<User>(
        'SELECT id FROM users WHERE firebase_uid = $1 OR email = $2',
        [input.firebaseUid, input.email]
      );
      
      if (existing.rows.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'User already exists',
        });
      }
      
      const result = await db.query<User>(
        `INSERT INTO users (firebase_uid, email, full_name, default_mode)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [input.firebaseUid, input.email, input.fullName, input.defaultMode]
      );
      
      return result.rows[0];
    }),
  
  // --------------------------------------------------------------------------
  // PROFILE UPDATES
  // --------------------------------------------------------------------------
  
  /**
   * Update profile
   */
  updateProfile: protectedProcedure
    .input(z.object({
      fullName: z.string().min(1).max(255).optional(),
      avatarUrl: z.string().url().optional(),
      defaultMode: z.enum(['worker', 'poster']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;
      
      if (input.fullName !== undefined) {
        updates.push(`full_name = $${paramIndex++}`);
        values.push(input.fullName);
      }
      if (input.avatarUrl !== undefined) {
        updates.push(`avatar_url = $${paramIndex++}`);
        values.push(input.avatarUrl);
      }
      if (input.defaultMode !== undefined) {
        updates.push(`default_mode = $${paramIndex++}`);
        values.push(input.defaultMode);
      }
      
      if (updates.length === 0) {
        return ctx.user;
      }
      
      updates.push(`updated_at = NOW()`);
      values.push(ctx.user.id);
      
      const result = await db.query<User>(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );
      
      return result.rows[0];
    }),
  
  /**
   * Get onboarding status
   * Returns onboarding completion status and first task completion status
   */
  getOnboardingStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await db.query<{
        onboarding_completed_at: Date | null;
        default_mode: string;
        xp_first_celebration_shown_at: Date | null;
      }>(
        `SELECT onboarding_completed_at, default_mode, xp_first_celebration_shown_at
         FROM users WHERE id = $1`,
        [ctx.user.id]
      );
      
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }
      
      const user = result.rows[0];
      
      return {
        onboardingComplete: user.onboarding_completed_at !== null,
        role: user.default_mode as 'worker' | 'poster',
        xpFirstCelebrationShownAt: user.xp_first_celebration_shown_at?.toISOString() || null,
        hasCompletedFirstTask: user.xp_first_celebration_shown_at !== null,
      };
    }),
  
  /**
   * Complete onboarding
   */
  completeOnboarding: protectedProcedure
    .input(z.object({
      version: z.string(),
      roleConfidenceWorker: z.number().min(0).max(1),
      roleConfidencePoster: z.number().min(0).max(1),
      roleCertaintyTier: z.enum(['STRONG', 'MODERATE', 'WEAK']),
      inconsistencyFlags: z.array(z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<User>(
        `UPDATE users SET
           onboarding_version = $1,
           onboarding_completed_at = NOW(),
           role_confidence_worker = $2,
           role_confidence_poster = $3,
           role_certainty_tier = $4,
           inconsistency_flags = $5,
           updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          input.version,
          input.roleConfidenceWorker,
          input.roleConfidencePoster,
          input.roleCertaintyTier,
          input.inconsistencyFlags || [],
          ctx.user.id,
        ]
      );
      
      return result.rows[0];
    }),
});

export type UserRouter = typeof userRouter;
