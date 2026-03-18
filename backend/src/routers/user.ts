/**
 * User Router v1.0.0
 * 
 * User profile and authentication endpoints
 * 
 * @see PRODUCT_SPEC.md §5 (XP), §6 (Trust)
 */

import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure, hustlerProcedure, Schemas } from '../trpc.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { XPService } from '../services/XPService.js';
import { EarnedVerificationUnlockService } from '../services/EarnedVerificationUnlockService.js';
import type { User } from '../types.js';
import { cachedDbQuery, invalidateUser, CACHE_KEYS, CACHE_TTL, CACHE_TAGS } from '../cache/db-cache.js';
import { getStreakStatus } from '../services/StreakService.js';
import { z } from 'zod';

// --------------------------------------------------------------------------
// Helper: Transform DB user row → iOS-compatible JSON
// --------------------------------------------------------------------------
// The iOS app expects camelCase keys and some field name differences.
// This keeps the DB schema canonical while letting the mobile client decode
// directly into its HXUser model.

async function toMobileUser(user: User) {
  // Map backend default_mode to frontend role label
  const roleMap: Record<string, string> = { worker: 'hustler', poster: 'poster' };

  // Compute aggregated stats from DB
  const statsResult = await db.query<{
    avg_rating: string | null;
    total_ratings: string;
    tasks_completed: string;
    tasks_posted: string;
    total_earnings: string;
    total_spent: string;
  }>(
    `SELECT
       COALESCE(AVG(tr.stars), 5.0) as avg_rating,
       COUNT(tr.id)::text as total_ratings,
       (SELECT COUNT(*) FROM tasks WHERE worker_id = $1 AND state = 'COMPLETED')::text as tasks_completed,
       (SELECT COUNT(*) FROM tasks WHERE poster_id = $1)::text as tasks_posted,
       COALESCE((SELECT SUM(e.amount) FROM escrows e JOIN tasks t ON e.task_id = t.id WHERE t.worker_id = $1 AND e.state = 'RELEASED'), 0)::text as total_earnings,
       COALESCE((SELECT SUM(e.amount) FROM escrows e JOIN tasks t ON e.task_id = t.id WHERE t.poster_id = $1 AND e.state IN ('RELEASED', 'FUNDED')), 0)::text as total_spent
     FROM task_ratings tr
     WHERE tr.ratee_id = $1`,
    [user.id]
  );

  const stats = statsResult.rows[0];

  return {
    id: user.id,
    name: user.full_name,
    email: user.email,
    phone: user.phone ?? null,
    bio: user.bio ?? null,
    avatarURL: user.avatar_url ?? null,
    role: roleMap[user.default_mode] ?? user.default_mode,
    trustTier: user.trust_tier,
    rating: stats ? parseFloat(stats.avg_rating || '5.0') : 5.0,
    totalRatings: stats ? parseInt(stats.total_ratings || '0', 10) : 0,
    xp: user.xp_total,
    tasksCompleted: stats ? parseInt(stats.tasks_completed || '0', 10) : 0,
    tasksPosted: stats ? parseInt(stats.tasks_posted || '0', 10) : 0,
    totalEarnings: stats ? parseInt(stats.total_earnings || '0', 10) : 0,
    totalSpent: stats ? parseInt(stats.total_spent || '0', 10) : 0,
    isVerified: user.is_verified,
    createdAt: user.created_at,
    // Extra fields the app may need
    hasCompletedOnboarding: user.onboarding_completed_at != null,
    defaultMode: user.default_mode,
  };
}

// Helper: Normalize iOS role value to DB value
// Frontend sends "hustler" but DB stores "worker"
function normalizeRole(role: string): 'worker' | 'poster' {
  if (role === 'hustler' || role === 'worker') return 'worker';
  if (role === 'poster') return 'poster';
  return 'worker'; // fallback
}

export const userRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Get current user profile
   * Returns mobile-compatible JSON shape (camelCase, mapped field names)
   */
  me: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return await toMobileUser(ctx.user!);
    }),

  /**
   * Get gamified streak status for the current user (PRODUCT_SPEC §5.4, §5.5).
   * Returns current streak, last completion time, grace expiry, and a UI message.
   */
  getStreakStatus: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const result = await getStreakStatus(ctx.user!.id);
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Get user by ID
   * Returns full profile for own user, public profile for others (IDOR protection).
   * Other-user path is cached in Redis; invalidated on profile update.
   */
  getById: protectedProcedure
    .input(z.object({ userId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.id === input.userId) {
        return await toMobileUser(ctx.user!);
      }

      return cachedDbQuery(
        CACHE_KEYS.userProfile(input.userId),
        async () => {
          const result = await db.query<{
            id: string;
            full_name: string;
            avatar_url: string | null;
            bio: string | null;
            trust_tier: string;
            xp_total: number;
            is_verified: boolean;
            default_mode: string;
            created_at: Date;
          }>(
            `SELECT id, full_name, avatar_url, bio, trust_tier, xp_total, is_verified, default_mode, created_at
             FROM users WHERE id = $1`,
            [input.userId]
          );
          if (result.rows.length === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
          }
          const user = result.rows[0];
          const roleMap: Record<string, string> = { worker: 'hustler', poster: 'poster' };
          const statsResult = await db.query<{
            avg_rating: string | null;
            total_ratings: string;
            tasks_completed: string;
          }>(
            `SELECT COALESCE(AVG(tr.stars), 5.0) as avg_rating, COUNT(tr.id)::text as total_ratings,
                    (SELECT COUNT(*) FROM tasks WHERE worker_id = $1 AND state = 'COMPLETED')::text as tasks_completed
             FROM task_ratings tr WHERE tr.ratee_id = $1`,
            [input.userId]
          );
          const stats = statsResult.rows[0];
          return {
            id: user.id,
            name: user.full_name,
            avatarURL: user.avatar_url,
            bio: user.bio,
            role: roleMap[user.default_mode] ?? user.default_mode,
            trustTier: user.trust_tier,
            xp: user.xp_total,
            isVerified: user.is_verified,
            rating: stats ? parseFloat(stats.avg_rating || '5.0') : 5.0,
            totalRatings: stats ? parseInt(stats.total_ratings || '0', 10) : 0,
            tasksCompleted: stats ? parseInt(stats.tasks_completed || '0', 10) : 0,
            createdAt: user.created_at,
          };
        },
        { tags: [CACHE_TAGS.USER(input.userId)], ttl: CACHE_TTL.userProfile }
      );
    }),
  
  /**
   * Get XP history
   */
  xpHistory: protectedProcedure
    .input(z.void())
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
    .input(z.void())
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
      firebaseUid: z.string().max(128),
      email: z.string().email().max(254),
      fullName: z.string().min(1).max(255),
      // Accept "hustler", "worker", or "poster" from frontend
      defaultMode: z.string().max(20).default('worker'),
      // COPPA compliance: date of birth for age verification (AUDIT FIX)
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD format'),
    }))
    .mutation(async ({ input }) => {
      // --------------------------------------------------------------------------
      // COPPA AGE VERIFICATION (AUDIT FIX)
      // Users under 13 are blocked per Children's Online Privacy Protection Act.
      // Users 13-17 are allowed but flagged as minors for consent tracking.
      // --------------------------------------------------------------------------
      const dob = new Date(input.dateOfBirth);
      const now = new Date();
      const ageDiff = now.getFullYear() - dob.getFullYear();
      const monthDiff = now.getMonth() - dob.getMonth();
      const dayDiff = now.getDate() - dob.getDate();
      const age = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? ageDiff - 1 : ageDiff;

      if (isNaN(dob.getTime()) || age < 0 || age > 150) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid date of birth',
        });
      }

      if (age < 13) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'COPPA_AGE_RESTRICTION: Users must be at least 13 years old to create an account. This is required by the Children\'s Online Privacy Protection Act (COPPA).',
        });
      }

      // Normalize role: iOS sends "hustler" but DB stores "worker"
      const dbMode = normalizeRole(input.defaultMode);

      // Check if user already exists
      const existing = await db.query<User>(
        'SELECT id FROM users WHERE firebase_uid = $1 OR email = $2',
        [input.firebaseUid, input.email]
      );

      if (existing.rows.length > 0) {
        // Return existing user instead of error (handles re-registration from social auth)
        const existingUser = await db.query<User>(
          'SELECT * FROM users WHERE firebase_uid = $1 OR email = $2',
          [input.firebaseUid, input.email]
        );
        return await toMobileUser(existingUser.rows[0]);
      }

      const result = await db.query<User>(
        `INSERT INTO users (firebase_uid, email, full_name, default_mode, date_of_birth, is_minor)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [input.firebaseUid, input.email, input.fullName, dbMode, input.dateOfBirth, age < 18]
      );

      return await toMobileUser(result.rows[0]);
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
      bio: z.string().max(500).optional(),
      avatarUrl: z.string().url().max(2048).optional(),
      phone: z.string().max(20).optional(),
      // Accept "hustler", "worker", or "poster" from frontend
      defaultMode: z.string().max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (input.fullName !== undefined) {
        updates.push(`full_name = $${paramIndex++}`);
        values.push(input.fullName);
      }
      if (input.bio !== undefined) {
        updates.push(`bio = $${paramIndex++}`);
        values.push(input.bio);
      }
      if (input.avatarUrl !== undefined) {
        updates.push(`avatar_url = $${paramIndex++}`);
        values.push(input.avatarUrl);
      }
      if (input.phone !== undefined) {
        updates.push(`phone = $${paramIndex++}`);
        values.push(input.phone);
      }
      if (input.defaultMode !== undefined) {
        const newMode = normalizeRole(input.defaultMode);
        if (newMode !== ctx.user.default_mode) {
          // Guard: no open tasks in current role before switching
          // REG-11 FIX: EXPIRED is a terminal TaskState — include it here so expired
          // tasks don't block role switching. REFUNDED is EscrowState, not TaskState —
          // removed. Terminal TaskStates: COMPLETED, CANCELLED, EXPIRED.
          // REG-13 FIX: Wrap in try/catch to sanitize DB errors before surfacing to caller.
          let openTasksCount: number;
          try {
            const result = await db.query(
              `SELECT COUNT(*) FROM tasks
               WHERE (poster_id = $1 OR worker_id = $1)
               AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
              [ctx.user.id]
            );
            openTasksCount = parseInt(result.rows[0].count, 10);
          } catch (err) {
            logger.error({ userId: ctx.user.id, err }, 'Failed to check open tasks for role switch');
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Unable to verify account status. Please try again.',
            });
          }
          if (openTasksCount > 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Cannot switch role while you have active tasks. Complete or cancel all tasks first.',
            });
          }
        }
        updates.push(`default_mode = $${paramIndex++}`);
        // Normalize: iOS sends "hustler" but DB stores "worker"
        values.push(newMode);
      }

      if (updates.length === 0) {
        return await toMobileUser(ctx.user!);
      }

      updates.push(`updated_at = NOW()`);
      values.push(ctx.user.id);

      const result = await db.query<User>(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );
      await invalidateUser(ctx.user.id);
      return await toMobileUser(result.rows[0]);
    }),
  
  /**
   * Get onboarding status
   * Returns onboarding completion status and first task completion status
   */
  getOnboardingStatus: protectedProcedure
    .input(z.void())
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
      
      // Map DB role to frontend role: "worker" → "hustler"
      const roleMap: Record<string, string> = { worker: 'hustler', poster: 'poster' };

      return {
        onboardingComplete: user.onboarding_completed_at !== null,
        role: roleMap[user.default_mode] ?? user.default_mode,
        xpFirstCelebrationShownAt: user.xp_first_celebration_shown_at?.toISOString() || null,
        hasCompletedFirstTask: user.xp_first_celebration_shown_at !== null,
      };
    }),
  
  /**
   * Complete onboarding
   */
  completeOnboarding: protectedProcedure
    .input(z.object({
      version: z.string().max(20),
      roleConfidenceWorker: z.number().min(0).max(1),
      roleConfidencePoster: z.number().min(0).max(1),
      roleCertaintyTier: z.enum(['STRONG', 'MODERATE', 'WEAK']),
      inconsistencyFlags: z.array(z.string().max(100)).max(20).optional(),
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
      await invalidateUser(ctx.user.id);
      return await toMobileUser(result.rows[0]);
    }),

  // --------------------------------------------------------------------------
  // VERIFICATION UNLOCK (v1.8.0)
  // --------------------------------------------------------------------------

  /**
   * Get verification unlock status and progress
   * Shows earnings toward $40 threshold
   */
  getVerificationUnlockStatus: hustlerProcedure.input(z.void()).query(async ({ ctx }) => {
    const result = await EarnedVerificationUnlockService.getUnlockProgress(ctx.user.id);

    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error?.message || 'Failed to get verification status'
      });
    }

    return result.data;
  }),

  /**
   * Check if user has unlocked verification (boolean)
   */
  checkVerificationEligibility: hustlerProcedure.input(z.void()).query(async ({ ctx }) => {
    const result = await EarnedVerificationUnlockService.checkUnlockEligibility(ctx.user.id);

    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error?.message || 'Failed to check eligibility'
      });
    }

    return { unlocked: result.data };
  }),

  /**
   * Get earnings ledger (audit trail)
   */
  getVerificationEarningsLedger: hustlerProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).optional().default(20)
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const result = await EarnedVerificationUnlockService.getEarningsLedger(
        ctx.user.id,
        input?.limit
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error?.message || 'Failed to get earnings ledger'
        });
      }

      return result.data;
    }),

  xpLeaderboard: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).optional().default(25) }).optional())
    .query(async ({ input }) => {
      const { XPService } = await import('../services/XPService');
      const result = await XPService.getDailyLeaderboard(input?.limit ?? 25);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error?.message || 'Failed to get leaderboard' });
      }
      return result.data;
    }),

  requestErasure: protectedProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const { GDPRService } = await import('../services/GDPRService');
      const result = await GDPRService.createRequest({
        userId: ctx.user.id,
        requestType: 'deletion',
      });
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }
      return result.data;
    }),
});

export type UserRouter = typeof userRouter;
