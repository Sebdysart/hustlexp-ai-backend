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
import { invalidateAuthCacheForUser } from '../auth-cache.js';
import { getStreakStatus } from '../services/StreakService.js';
import { z } from 'zod';
import { firebaseAuth } from '../auth/firebase.js';

const log = logger.child({ router: 'user' });

// --------------------------------------------------------------------------
// Avatar URL allowlist — mirrors isApprovedPhotoHost in messaging.ts
// Only R2-hosted URLs are accepted to prevent SSRF / tracking-pixel attacks.
// R2_PUBLIC_URL is read lazily inside the function so test environments can
// set the env var without relying on module-load-time evaluation.
// --------------------------------------------------------------------------
function isApprovedAvatarHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    // Custom R2 public domain (configured via R2_PUBLIC_URL env var)
    const r2Raw = process.env.R2_PUBLIC_URL || '';
    if (r2Raw) {
      try {
        const r2Hostname = new URL(r2Raw).hostname;
        if (hostname === r2Hostname) return true;
      } catch { /* ignore malformed env var */ }
    }
    // Default Cloudflare R2 public URL pattern: pub-<hash>.r2.dev
    if (/^pub-[a-f0-9]+\.r2\.dev$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

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
        // A-07 FIX: Log the real error server-side; return a generic message to the client
        // to prevent DB column names or internal details from leaking.
        log.error({ err: result.error, userId: ctx.user!.id }, '[user.getStreakStatus] service error');
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.code === 'NOT_FOUND' ? 'User not found' : 'Unable to fetch data. Please try again.',
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
             FROM users WHERE id = $1 AND is_banned = false AND account_status NOT IN ('DELETED', 'SUSPENDED')`,
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
   * Get XP history (paginated)
   * Default limit=50, max=100 to prevent DoS/OOM from unbounded queries.
   */
  xpHistory: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().nonnegative().default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;
      const result = await XPService.getHistory(ctx.user.id, limit, offset);

      if (!result.success) {
        // A-07 FIX: Log the real error server-side; return a generic message to the client
        // to prevent DB column names or internal details from leaking.
        log.error({ err: result.error, userId: ctx.user.id }, '[user.xpHistory] service error');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to fetch data. Please try again.',
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
        `SELECT * FROM badges WHERE user_id = $1 ORDER BY awarded_at DESC LIMIT 200`,
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
      // Firebase ID token — caller must prove ownership of firebaseUid.
      // The register endpoint is intentionally public (no auth middleware), so we
      // do inline token verification here instead of relying on protectedProcedure.
      idToken: z.string().min(1),
      firebaseUid: z.string().max(128),
      email: z.string().email().max(254),
      fullName: z.string().trim().min(1).max(255),
      // Accept "hustler", "worker", or "poster" from frontend
      defaultMode: z.string().max(20).default('worker'),
      // COPPA compliance: date of birth for age verification (AUDIT FIX)
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD format'),
      // Optional phone for ban-evasion cross-reference
      phone: z.string().max(20).optional(),
    }))
    .mutation(async ({ input }) => {
      // --------------------------------------------------------------------------
      // FIREBASE TOKEN OWNERSHIP VERIFICATION (SEC FIX)
      // The caller must prove they own the Firebase UID by supplying a valid
      // Firebase ID token. This prevents an attacker who knows a victim's UID
      // from registering as them or retrieving their profile via this endpoint.
      // --------------------------------------------------------------------------
      let decodedToken;
      try {
        decodedToken = await firebaseAuth.verifyIdToken(input.idToken, true); // checkRevoked = true (explicit, not relying on default)
      } catch {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired Firebase ID token.',
        });
      }
      if (decodedToken.uid !== input.firebaseUid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Firebase ID token does not match the provided firebaseUid.',
        });
      }
      // --------------------------------------------------------------------------
      // R48-1 IDOR FIX: Cross-check input.email against Firebase token email.
      // Without this, an attacker can supply their own valid Firebase token (for
      // their UID) but a victim's email address, causing the OR-based SELECT below
      // to return the victim's profile row and leak it to the attacker.
      // Sign-in-with-Apple and some OAuth providers omit email from the token —
      // fail-open for those cases (decodedToken.email is undefined/null).
      // --------------------------------------------------------------------------
      if (decodedToken.email && decodedToken.email.toLowerCase() !== input.email.toLowerCase()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Email address does not match the provided Firebase ID token.',
        });
      }

      // --------------------------------------------------------------------------
      // COPPA AGE VERIFICATION (AUDIT FIX)
      // Users under 13 are blocked per Children's Online Privacy Protection Act.
      // Users 13-17 are allowed but flagged as minors for consent tracking.
      // --------------------------------------------------------------------------
      const dob = new Date(input.dateOfBirth);
      if (isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== input.dateOfBirth) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid date of birth — date does not exist in calendar',
        });
      }
      const now = new Date();
      const ageDiff = now.getFullYear() - dob.getFullYear();
      const monthDiff = now.getMonth() - dob.getMonth();
      const dayDiff = now.getDate() - dob.getDate();
      const age = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? ageDiff - 1 : ageDiff;

      if (age < 0 || age > 150) {
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

      // FIX 3: Ban evasion via new Firebase account — phone number cross-reference.
      // A banned user with phone A registering with email B is detected here.
      // NOTE: Phone ban check only runs when phone is provided. A banned user can evade by
      // re-registering without a phone number. Accepted mitigation: phone-less accounts
      // receive trust_tier=0 which restricts access to high-value task categories.
      // Product decision: phone requirement deferred post-beta.
      if (input.phone) {
        const bannedPhone = await db.query<{ id: string }>(
          `SELECT id FROM users WHERE phone = $1 AND is_banned = true`,
          [input.phone]
        );
        if (bannedPhone.rows.length > 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account registration not permitted.' });
        }
      }

      // FIX 4: Ban evasion via fresh Firebase UID — check if this Firebase UID
      // has a prior record in the DB that is banned or deleted. A banned user
      // who deletes their Firebase account and creates a new one will present a
      // new UID, but the email cross-reference below catches most of those cases.
      // Also guard against the case where phone is omitted entirely (no phone check
      // above), by assigning trust_tier=0 (UNVERIFIED) so the account is restricted
      // until phone verification is completed.
      // A58-2 FIX: The old condition `AND account_status != 'DELETED'` excluded ALL
      // DELETED rows, which allowed a user who was banned AND GDPR-deleted to
      // re-register with the same email. The corrected logic only excludes a DELETED
      // row when it is NOT banned — a legitimately erased non-banned user. A row that
      // is DELETED AND banned still triggers the FORBIDDEN guard.
      const bannedByEmail = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1
          AND (is_banned = true OR account_status = 'SUSPENDED')
          AND NOT (account_status = 'DELETED' AND is_banned = false)`,
        [input.email]
      );
      if (bannedByEmail.rows.length > 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Account registration not permitted.' });
      }

      // Normalize role: iOS sends "hustler" but DB stores "worker"
      const dbMode = normalizeRole(input.defaultMode);

      // A64-1 FIX: When decodedToken.email is absent (anonymous, phone, or
      // Sign-in-with-Apple auth), the email guard above was skipped. To prevent
      // IDOR — an attacker supplying a victim's email with their own valid token —
      // we only match by firebase_uid when the token has no email. Matching by
      // email without a token-verified email would allow any anonymous-auth user
      // to claim another user's profile just by knowing their email address.
      // Check if user already exists
      const existing = decodedToken.email
        ? await db.query<User>(
            'SELECT * FROM users WHERE firebase_uid = $1 OR email = $2',
            [input.firebaseUid, input.email]
          )
        : await db.query<User>(
            'SELECT * FROM users WHERE firebase_uid = $1',
            [input.firebaseUid]
          );

      if (existing.rows.length > 0) {
        let existingUser: User | null = existing.rows[0];

        // BUG 3 FIX: A banned user who changes their Firebase email and
        // re-registers is matched here by firebase_uid. Without this check,
        // the router would return their banned profile via toMobileUser,
        // effectively re-admitting the banned account.
        if (existingUser.is_banned) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account is banned' });
        }

        // A56-2: A suspended user must not be re-admitted via re-registration.
        if (existingUser.account_status === 'SUSPENDED') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account is suspended' });
        }

        // FIX 4: If the matched row is a GDPR-deleted account, delete it so
        // the INSERT below can proceed with a fresh account. Without this
        // deletion the ON CONFLICT (firebase_uid) DO NOTHING clause would
        // still hit the constraint (same firebase_uid on the DELETED row) and
        // return 0 rows — permanently blocking re-registration and leaking the
        // anonymized profile back to the caller via the fallback SELECT.
        if (existingUser.account_status === 'DELETED') {
          await db.query('DELETE FROM users WHERE id = $1', [existingUser.id]);
          existingUser = null;
        }

        if (existingUser) {
          // Return existing user instead of error (handles re-registration from social auth)
          return await toMobileUser(existingUser);
        }
      }

      // Phone-less registrations start at trust_tier=0 (UNVERIFIED) to restrict
      // account capabilities until phone verification is completed. This limits
      // the usefulness of burner-email ban evasion without a phone number.
      const initialTrustTier = input.phone ? 1 : 0;

      const result = await db.query<User>(
        `INSERT INTO users (firebase_uid, email, full_name, default_mode, date_of_birth, is_minor, trust_tier)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (firebase_uid) DO NOTHING
         RETURNING *`,
        [input.firebaseUid, input.email, input.fullName, dbMode, input.dateOfBirth, age < 18, initialTrustTier]
      );

      if (result.rows.length === 0) {
        // Concurrent registration — another request inserted the same firebase_uid first.
        // Fetch the row that won the race and return it.
        const existing = await db.query<User>(
          'SELECT * FROM users WHERE firebase_uid = $1',
          [input.firebaseUid]
        );
        if (!existing.rows[0]) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Registration conflict — please retry' });
        }
        // A56-1: The winning concurrent request may have been a banned or suspended
        // account. Guard against re-admitting such accounts via the conflict path.
        // A63-1 FIX: Also guard against DELETED accounts — the concurrent winner
        // may be a GDPR-deleted row. Returning a DELETED profile would expose
        // anonymized data and block the caller from ever re-registering.
        const winner = existing.rows[0];
        if (winner.is_banned) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account is banned' });
        }
        if (winner.account_status === 'SUSPENDED') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account is suspended' });
        }
        if (winner.account_status === 'DELETED') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account has been deleted' });
        }
        return await toMobileUser(winner);
      }

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
      fullName: z.string().trim().min(1).max(255).optional(),
      bio: z.string().trim().max(500).optional(),
      avatarUrl: z.string().url().max(2048).refine(isApprovedAvatarHost, { message: 'Avatar must be hosted on approved storage (R2 only)' }).optional(),
      phone: z.string().trim().max(20).regex(/^[+\d\s\-().]{7,20}$/, 'Invalid phone number format').optional(),
      // Accept "hustler", "worker", or "poster" from frontend
      defaultMode: z.string().trim().max(20).optional(),
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
      const isRoleSwitch = input.defaultMode !== undefined && normalizeRole(input.defaultMode) !== ctx.user.default_mode;

      if (input.defaultMode !== undefined) {
        const newMode = normalizeRole(input.defaultMode);
        updates.push(`default_mode = $${paramIndex++}`);
        // Normalize: iOS sends "hustler" but DB stores "worker"
        values.push(newMode);
      }

      if (updates.length === 0) {
        return await toMobileUser(ctx.user!);
      }

      updates.push(`updated_at = NOW()`);
      values.push(ctx.user.id);

      // T53-2 FIX: When switching roles, wrap the open-task COUNT check and
      // the user UPDATE in a single SERIALIZABLE transaction so that no new task
      // assignment can sneak in between the check and the write (TOCTOU race).
      // Non-role-switch updates use a plain query — no locking needed.
      let updatedUser: User;
      if (isRoleSwitch) {
        updatedUser = await db.serializableTransaction(async (txQuery) => {
          // REG-11 FIX: EXPIRED is terminal — include it so expired tasks don't
          // block role switching. Terminal TaskStates: COMPLETED, CANCELLED, EXPIRED.
          const countResult = await txQuery<{ count: string }>(
            `SELECT COUNT(*) FROM tasks
             WHERE (poster_id = $1 OR worker_id = $1)
             AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
            [ctx.user.id]
          );
          const openTasksCount = parseInt(countResult.rows[0].count, 10);
          if (openTasksCount > 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Cannot switch role while you have active tasks. Complete or cancel all tasks first.',
            });
          }
          const result = await txQuery<User>(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
            values
          );
          return result.rows[0];
        });
      } else {
        const result = await db.query<User>(
          `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
          values
        );
        updatedUser = result.rows[0];
      }

      await invalidateUser(ctx.user.id);
      // SEC-FIX: Evict the in-process auth token cache so the new default_mode
      // is enforced immediately rather than after the 5-minute TTL expires.
      // This matches the pattern used by ban, GDPR deletion, and trust-tier changes.
      // BUG GG3 FIX: await the call (was fire-and-forget) so Redis errors surface.
      // A58-1 FIX: Pass writeRevocationMarker=false so a normal profile update does
      // NOT write a Redis auth:revoked:<uid> key (which would force 12 minutes of
      // Firebase re-verification for ordinary users).
      await invalidateAuthCacheForUser(ctx.user.id, undefined, false);
      return await toMobileUser(updatedUser);
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
      inconsistencyFlags: z.array(z.string().trim().max(100)).max(20).optional(),
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
      const { XPService } = await import('../services/XPService.js');
      const result = await XPService.getDailyLeaderboard(input?.limit ?? 25);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error?.message || 'Failed to get leaderboard' });
      }
      return result.data;
    }),

  requestErasure: protectedProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const { GDPRService } = await import('../services/GDPRService.js');
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
