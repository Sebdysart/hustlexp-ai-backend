/**
 * XPService v1.0.0 (AtomicXPService)
 * 
 * CONSTITUTIONAL: Enforces INV-1, INV-5
 * 
 * INV-1: XP can only be awarded if escrow is RELEASED
 * INV-5: XP issuance is idempotent per escrow_id (one award per escrow)
 * 
 * The database triggers enforce these invariants. This service
 * catches the violations and returns appropriate errors.
 * 
 * @see backend/database/constitutional-schema.sql §2.1 (xp_ledger table)
 * @see PRODUCT_SPEC.md §5
 */

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db.js';
import type { QueryFn } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { AlphaInstrumentation } from './AlphaInstrumentation.js';
import { updateStreakOnTaskCompletion } from './StreakService.js';

const log = logger.child({ service: 'XPService' });

const DAILY_XP_CAP = 10000;

async function getDailyXPTotal(query: QueryFn, userId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(effective_xp), 0)::TEXT as total
     FROM xp_ledger
     WHERE user_id = $1
       AND awarded_at AT TIME ZONE 'UTC' >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
       AND awarded_at AT TIME ZONE 'UTC' <  DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'`,
    [userId]
  );
  const total = Number(result.rows[0]?.total ?? '0');
  if (!Number.isSafeInteger(total)) {
    throw new Error('Invalid daily XP total returned by PostgreSQL');
  }
  return total;
}

function isValidAwardAmount(baseXP: number): boolean {
  return Number.isSafeInteger(baseXP) && baseXP > 0;
}

function invalidAwardAmount(): ServiceResult<never> {
  return {
    success: false,
    error: {
      code: 'INVALID_XP_AMOUNT',
      message: 'XP award amount must be a positive integer.',
    },
  };
}

// ============================================================================
// TYPES
// ============================================================================

export interface XPLedgerEntry {
  id: string;
  user_id: string;
  task_id: string;
  escrow_id: string;
  base_xp: number;
  streak_multiplier: number;
  trust_multiplier: number;      // SPEC ALIGNMENT: replaced decay_factor
  live_mode_multiplier: number;  // SPEC ALIGNMENT: 1.25× for Live tasks
  surge_multiplier: number;      // M5 FIX: stored for full audit trail
  effective_xp: number;
  reason: string;
  user_xp_before: number;
  user_xp_after: number;
  user_level_before: number;
  user_level_after: number;
  user_streak_at_award: number;
  awarded_at: Date;
}

interface AwardXPParams {
  userId: string;
  taskId: string;
  escrowId: string;
  baseXP: number;
}

interface XPCalculation {
  baseXP: number;
  streakMultiplier: number;
  trustMultiplier: number;       // SPEC ALIGNMENT: replaced decayFactor
  liveModeMultiplier: number;    // SPEC ALIGNMENT: 1.25× for Live tasks
  surgeMultiplier: number;       // Bug 3b fix: Instant Surge Level 2+ bonus (up to 2.0×)
  effectiveXP: number;
}

// ============================================================================
// XP MATH (PRODUCT_SPEC §5.2, §5.3)
// ============================================================================

/**
 * Level thresholds (PRODUCT_SPEC §5.1)
 */
const LEVEL_THRESHOLDS = [
  0,      // Level 1: 0 XP
  100,    // Level 2: 100 XP
  300,    // Level 3: 300 XP (100 + 200)
  700,    // Level 4: 700 XP (300 + 400)
  1500,   // Level 5: 1500 XP (700 + 800)
  2700,   // Level 6: 2700 XP (1500 + 1200)
  4500,   // Level 7: 4500 XP (2700 + 1800)
  7000,   // Level 8: 7000 XP (4500 + 2500)
  10500,  // Level 9: 10500 XP (7000 + 3500)
  16500,  // Level 10: 16500 XP (10500 + 6000)
];

/**
 * Streak multipliers (PRODUCT_SPEC §5.2)
 *
 * SPEC FORMULA: 1.0 + (streak_days × 0.05) capped at 2.0
 */
function getStreakMultiplier(streak: number): number {
  const multiplier = 1.0 + (streak * 0.05);
  return Math.min(multiplier, 2.0); // Cap at 2.0
}

/**
 * Trust multipliers (PRODUCT_SPEC §5.2)
 *
 * SPEC ALIGNMENT:
 * | Trust Tier | Multiplier |
 * |------------|------------|
 * | EXPLORER (0) | 1.0×     |
 * | VERIFIED (1) | 1.0×     |
 * | HOME READY (2) | 1.5×   |
 * | PRO (3) | 2.0×          |
 * | LICENSED SPECIALIST (4) | 2.0× |
 */
function getTrustMultiplier(trustTier: number): number {
  switch (trustTier) {
    case 0: return 1.0;  // EXPLORER
    case 1: return 1.0;  // VERIFIED
    case 2: return 1.5;  // HOME READY
    case 3: return 2.0;  // PRO
    case 4: return 2.0;  // LICENSED SPECIALIST (same as PRO)
    default: return 1.0; // Fail closed to the baseline multiplier
  }
}

/**
 * Live Mode XP multiplier (PRODUCT_SPEC §3.6)
 *
 * SPEC: Live tasks award 1.25× XP
 */
function getLiveModeMultiplier(isLiveMode: boolean): number {
  return isLiveMode ? 1.25 : 1.0;
}

/**
 * Instant Surge XP multiplier (Instant Surge Incentives v1)
 *
 * Bug 3b fix: Surge Level 2 awards 2.0× XP as the XP boost incentive for hustlers
 * who accept a task that has been waiting 120+ seconds for a match.
 * Surge Level 1 and 0 award no bonus (1.0×).
 * Surge Level 3 is a graceful-fail transition to OPEN — no XP bonus needed.
 *
 * @see instant-surge-worker.ts — surge_level 2 comment: "XP boost increase to 2.0x cap"
 */
function getSurgeMultiplier(surgeLevel: number): number {
  if (surgeLevel >= 2) return 2.0;
  return 1.0;
}

/**
 * Calculate effective XP (PRODUCT_SPEC §5.2)
 *
 * SPEC FORMULA: effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier × surge_multiplier
 * Rounding: truncate toward zero
 *
 * MM11: Combined multiplier is capped at 5.0× to prevent runaway XP awards from
 * fully-stacked params (streak 2.0 × trust 2.0 × live 1.25 × surge 2.0 = 10.0×).
 */
function calculateEffectiveXP(
  baseXP: number,
  streakMultiplier: number,
  trustMultiplier: number,
  liveModeMultiplier: number = 1.0,
  surgeMultiplier: number = 1.0
): number {
  const MAX_COMBINED_MULTIPLIER = 5.0; // max 5× regardless of stacking
  const rawMultiplier = streakMultiplier * trustMultiplier * liveModeMultiplier * surgeMultiplier;
  const effectiveMultiplier = Math.min(rawMultiplier, MAX_COMBINED_MULTIPLIER);
  return Math.floor(baseXP * effectiveMultiplier);
}

/**
 * Calculate level from total XP
 */
function calculateLevel(totalXP: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalXP >= LEVEL_THRESHOLDS[i]) {
      return i + 1;
    }
  }
  return 1;
}

// ============================================================================
// SERVICE
// ============================================================================

export const XPService = {
  /**
   * Calculate XP award (without saving)
   *
   * SPEC ALIGNMENT (PRODUCT_SPEC §5.2):
   * effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier
   */
  calculateAward: async (
    userId: string,
    baseXP: number,
    taskId?: string
  ): Promise<ServiceResult<XPCalculation>> => {
    if (!isValidAwardAmount(baseXP)) return invalidAwardAmount();
    try {
      // Get user's current streak and trust tier
      const userResult = await db.query<{
        current_streak: number;
        trust_tier: number;
      }>(
        'SELECT current_streak, trust_tier FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }

      const user = userResult.rows[0];

      // Check if task is Live Mode (for 1.25× multiplier) and surge_level (for surge bonus)
      let isLiveMode = false;
      let surgeLevel = 0;
      if (taskId) {
        const taskResult = await db.query<{ mode: string; surge_level: number }>(
          'SELECT mode, COALESCE(surge_level, 0) AS surge_level FROM tasks WHERE id = $1',
          [taskId]
        );
        isLiveMode = taskResult.rows[0]?.mode === 'LIVE';
        surgeLevel = taskResult.rows[0]?.surge_level ?? 0;
      }

      // SPEC FORMULA: effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier × surge_multiplier
      const streakMultiplier = getStreakMultiplier(user.current_streak);
      const trustMultiplier = getTrustMultiplier(user.trust_tier);
      const liveModeMultiplier = getLiveModeMultiplier(isLiveMode);
      const surgeMultiplier = getSurgeMultiplier(surgeLevel);
      const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier, surgeMultiplier);

      return {
        success: true,
        data: {
          baseXP,
          streakMultiplier,
          trustMultiplier,
          liveModeMultiplier,
          surgeMultiplier,
          effectiveXP,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'CALCULATION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Award XP for task completion
   *
   * SPEC ALIGNMENT (PRODUCT_SPEC §5.2):
   * effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier
   *
   * INV-1: Will fail if escrow is not RELEASED (HX101)
   * INV-5: Will fail if XP already awarded for this escrow (23505)
   */
  awardXP: async (params: AwardXPParams): Promise<ServiceResult<XPLedgerEntry>> => {
    const { userId, taskId, escrowId, baseXP } = params;

    if (!isValidAwardAmount(baseXP)) return invalidAwardAmount();

    // Anti-farming: Check velocity (cap check moved inside transaction — see below)
    // FIX 2: Hard-block large awards when velocity is suspicious
    // REG-9 FIX: Raised from 1000 to 3000 — a $150 task (1500 XP) must not be blocked.
    const VELOCITY_BLOCK_THRESHOLD = 3000;
    const velocityCheck = await XPService.checkVelocity(userId);
    if (velocityCheck.suspicious && baseXP > VELOCITY_BLOCK_THRESHOLD) {
      log.warn({ userId, baseXP, velocityData: velocityCheck }, 'XP velocity block triggered');
      return {
        success: false,
        error: {
          code: 'XP_VELOCITY_EXCEEDED',
          message: 'XP_VELOCITY_EXCEEDED: Award blocked due to suspicious velocity pattern',
        },
      };
    }
    if (velocityCheck.suspicious) {
      log.warn({ userId, baseXP, recentEvents: velocityCheck.recentEvents }, 'XP velocity suspicious (below block threshold) - allowing but flagging');
    }

    try {
      const runAwardTransaction = () => db.serializableTransaction(async (query) => {
        // Get user's current state including trust tier
        const userResult = await query<{
          xp_total: number;
          current_level: number;
          current_streak: number;
          trust_tier: number;
          account_status: string;
        }>(
          'SELECT xp_total, current_level, current_streak, trust_tier, account_status FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );

        if (userResult.rows.length === 0) {
          return {
            success: false as const,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `User ${userId} not found`,
            },
          };
        }

        const user = userResult.rows[0];
        if (user.account_status === 'SUSPENDED' || user.account_status === 'DELETED') {
          return {
            success: false as const,
            error: {
              code: 'XP_ACCOUNT_INELIGIBLE',
              message: `XP cannot be awarded to an account in ${user.account_status} state.`,
            },
          };
        }

        // Check if task is Live Mode (for 1.25× multiplier) and surge_level (for surge bonus)
        const taskResult = await query<{ mode: string; surge_level: number }>(
          'SELECT mode, COALESCE(surge_level, 0) AS surge_level FROM tasks WHERE id = $1',
          [taskId]
        );
        const isLiveMode = taskResult.rows[0]?.mode === 'LIVE';
        const surgeLevel = taskResult.rows[0]?.surge_level ?? 0;

        // SPEC FORMULA: effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier × surge_multiplier
        const streakMultiplier = getStreakMultiplier(user.current_streak);
        const trustMultiplier = getTrustMultiplier(user.trust_tier);
        const liveModeMultiplier = getLiveModeMultiplier(isLiveMode);
        const surgeMultiplier = getSurgeMultiplier(surgeLevel);
        const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier, surgeMultiplier);

        // MM3: Re-check velocity INSIDE the serializable transaction so that concurrent
        // requests cannot all see the pre-commit count and all proceed. The FOR UPDATE
        // row lock above ensures serialized user access; this COUNT sees committed rows
        // under the same SERIALIZABLE isolation, making the velocity gate race-free.
        const VELOCITY_BLOCK_THRESHOLD = 3000;
        const inTxVelocityResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM xp_ledger
           WHERE user_id = $1 AND awarded_at > NOW() - INTERVAL '1 hour'`,
          [userId]
        );
        const inTxRecentEvents = parseInt(inTxVelocityResult.rows[0]?.count ?? '0', 10);
        if (inTxRecentEvents > 5 && baseXP > VELOCITY_BLOCK_THRESHOLD) {
          return {
            success: false as const,
            error: {
              code: 'XP_VELOCITY_EXCEEDED',
              message: 'XP_VELOCITY_EXCEEDED: Award blocked due to suspicious velocity pattern',
            },
          };
        }

        // Anti-farming: Check daily XP cap using effectiveXP (post-multiplier) so cap
        // cannot be exceeded when streak/trust/live multipliers inflate the award.
        // FIX: was checking baseXP pre-multiplier — cap could be bypassed up to 5×.
        //
        // PostgreSQL is the cap authority. The user row lock above serializes
        // every award for this recipient, so this ledger-backed probe observes
        // the prior committed award before a concurrent request can continue.
        // Redis may cache XP displays elsewhere, but it cannot authorize issuance.
        const earnedToday = await getDailyXPTotal(query, userId);
        const wouldExceedCap = earnedToday + effectiveXP > DAILY_XP_CAP;
        if (wouldExceedCap) {
          return {
            success: false as const,
            error: {
              code: 'XP_DAILY_CAP',
              message: `Daily XP cap reached (${DAILY_XP_CAP} XP). Try again tomorrow.`,
            },
          };
        }

        const newXPTotal = user.xp_total + effectiveXP;
        const newLevel = calculateLevel(newXPTotal);

        // Insert XP ledger entry
        // INV-1: Trigger will check escrow is RELEASED
        // INV-5: UNIQUE constraint will prevent duplicates
        // M5 FIX: surge_multiplier is now stored so every award is fully auditable.
        const ledgerResult = await query<XPLedgerEntry>(
          `INSERT INTO xp_ledger (
            user_id, task_id, escrow_id,
            base_xp, streak_multiplier, trust_multiplier, live_mode_multiplier, surge_multiplier, effective_xp,
            reason,
            user_xp_before, user_xp_after,
            user_level_before, user_level_after,
            user_streak_at_award
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING *`,
          [
            userId, taskId, escrowId,
            baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier, surgeMultiplier, effectiveXP,
            'task_completion',
            user.xp_total, newXPTotal,
            user.current_level, newLevel,
            user.current_streak,
          ]
        );

        // Update user's XP total and level
        await query(
          `UPDATE users
           SET xp_total = $1, current_level = $2, updated_at = NOW()
           WHERE id = $3`,
          [newXPTotal, newLevel, userId]
        );

        // INSERT...RETURNING should always return a row, but verify for safety
        if (!ledgerResult.rows[0]) {
          throw new Error('Failed to create XP ledger entry - no row returned');
        }

        return { success: true as const, data: ledgerResult.rows[0] };
      });
      type AwardTransactionResult = Awaited<ReturnType<typeof runAwardTransaction>>;
      let result: AwardTransactionResult | undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          result = await runAwardTransaction();
          break;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== '40001' || attempt === 3) throw error;
          log.warn({ userId, attempt }, 'Retrying XP award after PostgreSQL serialization conflict');
        }
      }
      if (!result) throw new Error('XP award transaction exhausted without a result');

      // Alpha Instrumentation: Emit trust delta applied for XP
      // Note: This happens outside the transaction to avoid blocking XP award
      // The try-catch ensures silent failure
      if (result.success && result.data.effective_xp > 0) {
        try {
          // Determine role from user's default_mode (worker = hustler, poster = poster)
          const userRoleResult = await db.query<{ default_mode: string }>(
            'SELECT default_mode FROM users WHERE id = $1',
            [userId]
          );
          const role = userRoleResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';

          await AlphaInstrumentation.emitTrustDeltaApplied({
            user_id: userId,
            role,
            delta_type: 'xp',
            delta_amount: result.data.effective_xp,
            reason_code: 'task_completion',
            task_id: taskId,
            timestamp: new Date(),
          });

          // If streak changed, emit separate streak delta (outside transaction for consistency)
          // Note: We don't track streak changes in XPService currently, but we can add this later
        } catch (error) {
          // Silent fail - instrumentation should not break core flow
          log.warn({ err: error instanceof Error ? error.message : String(error), userId, taskId }, 'Failed to emit trust_delta_applied for XP award');
        }
      }

      // No post-commit cap mutation is needed: today's immutable PostgreSQL
      // ledger rows are the cap record and the user lock serialized issuance.

      // Gamified streaks: update streak on task completion (after XP award)
      if (result.success) {
        try {
          const taskRow = await db.query<{ completed_at: Date | null }>(
            'SELECT completed_at FROM tasks WHERE id = $1',
            [taskId]
          );
          const completedAt = taskRow.rows[0]?.completed_at ? new Date(taskRow.rows[0].completed_at) : new Date();
          const streakResult = await updateStreakOnTaskCompletion(userId, completedAt);
          if (streakResult.success && streakResult.data.streakChanged) {
            const userRoleResult = await db.query<{ default_mode: string }>(
              'SELECT default_mode FROM users WHERE id = $1',
              [userId]
            );
            const role = userRoleResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';
            await AlphaInstrumentation.emitTrustDeltaApplied({
              user_id: userId,
              role,
              delta_type: 'streak',
              delta_amount: streakResult.data.newStreak,
              reason_code: 'task_completion',
              task_id: taskId,
              timestamp: new Date(),
            });
          }
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err), userId, taskId }, 'Streak update failed');
        }
      }

      return result;
    } catch (error) {
      // Check for INV-1 violation
      if (isInvariantViolation(error)) {
        const dbError = error as { code?: string };
        return {
          success: false,
          error: {
            code: ErrorCodes.INV_1_VIOLATION,
            message: getErrorMessage(dbError.code || 'HX101'),
          },
        };
      }
      
      // Check for INV-5 violation (duplicate)
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INV_5_VIOLATION,
            message: `XP already awarded for escrow ${escrowId}`,
          },
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get XP history for user (paginated)
   *
   * Returns { items, total, offset } to prevent DoS/OOM from fetching unbounded
   * ledger history. Default limit=50, max=100 enforced at the router layer.
   */
  getHistory: async (
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ServiceResult<{ items: XPLedgerEntry[]; total: number; offset: number }>> => {
    try {
      const totalResult = await db.query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM xp_ledger WHERE user_id = $1',
        [userId]
      );
      const total = parseInt(totalResult.rows[0]?.count ?? '0', 10);

      const result = await db.query<XPLedgerEntry>(
        'SELECT * FROM xp_ledger WHERE user_id = $1 ORDER BY awarded_at DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset]
      );

      return { success: true, data: { items: result.rows, total, offset } };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get total XP awarded for a task
   */
  getByTask: async (taskId: string): Promise<ServiceResult<XPLedgerEntry | null>> => {
    try {
      const result = await db.query<XPLedgerEntry>(
        'SELECT * FROM xp_ledger WHERE task_id = $1',
        [taskId]
      );

      return { success: true, data: result.rows[0] || null };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Check daily XP cap for anti-farming.
   *
   * PostgreSQL's immutable XP ledger is the sole authority. awardXP performs the
   * same ledger query on its transaction connection after locking the recipient
   * user row. This public helper is read-only and must not be treated as a
   * reservation by other callers.
   */
  checkDailyXPCap: async (userId: string, xpAmount: number = 0): Promise<{ allowed: boolean; earned: number; cap: number; remaining: number }> => {
    try {
      // Explicit UTC boundaries avoid dependence on the database session timezone.
      const earned = await getDailyXPTotal(db.query, userId);
      return {
        allowed: earned + xpAmount <= DAILY_XP_CAP,
        earned,
        cap: DAILY_XP_CAP,
        remaining: Math.max(0, DAILY_XP_CAP - earned),
      };
    } catch {
      // Fail closed if ledger authority cannot be read.
      return { allowed: false, earned: 0, cap: DAILY_XP_CAP, remaining: 0 };
    }
  },

  /**
   * Track daily XP earned (no-op: tracking is derived from the immutable ledger.
   * This stub is preserved so any callers outside
   * the normal awardXP flow (e.g. manual test tooling) continue to compile.
   *
   * @deprecated Accepted awards are tracked by their PostgreSQL ledger rows. Do not call directly.
   */
  trackDailyXP: async (_userId: string, _xpAmount: number): Promise<void> => {
    // No-op: accepted awards are already represented by immutable ledger rows.
  },

  /**
   * Check XP velocity (anti-farming: flag if >5 events in 1 hour)
   */
  checkVelocity: async (userId: string): Promise<{ suspicious: boolean; recentEvents: number }> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM xp_ledger
         WHERE user_id = $1 AND awarded_at > NOW() - INTERVAL '1 hour'`,
        [userId]
      );
      const recentEvents = parseInt(result.rows[0]?.count || '0', 10);
      return { suspicious: recentEvents > 5, recentEvents };
    } catch (err) {
      // MM5: Fail CLOSED — returning suspicious:false on DB error would disable velocity
      // enforcement during DB stress, allowing unlimited XP farming. Return suspicious:true
      // so the caller blocks large awards until the DB recovers.
      logger.error('checkVelocity DB error — failing closed', { err, userId });
      return { suspicious: true, recentEvents: 999 };
    }
  },

  /**
   * Clawback XP awarded for an escrow that was subsequently refunded or lost in dispute.
   *
   * INV-4 compliance: The xp_ledger is immutable (no UPDATE/DELETE). We insert a
   * debit entry with negative effective_xp to offset the original credit, then
   * update the user's running xp_total.
   *
   * FIX 3: Closes the dispute-then-refund free-XP exploit.
   */
  clawbackXP: async (userId: string, escrowId: string, reason: string, fraction = 1.0): Promise<void> => {
    // YY-04 FIX: Move the award SELECT inside the transaction so it is protected by the
    // FOR UPDATE lock on the user row. Previously the SELECT ran outside the transaction,
    // allowing a concurrent awardXP() to slip in between the SELECT and the transaction
    // start, producing a stale base_xp/effective_xp in the clawback ledger entry.
    //
    // Both awardXP() and clawbackXP() now acquire FOR UPDATE on the user row first,
    // so they serialize correctly — neither can see a partially-applied peer operation.
    await db.transaction(async (txQuery) => {
      // Lock the user row FIRST so no concurrent awardXP() can slip in.
      const lockResult = await txQuery<{ xp_total: number; current_level: number }>(
        `SELECT xp_total, current_level FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      if (lockResult.rows.length === 0) {
        log.warn({ userId, escrowId, reason }, 'XP clawback: user row not found inside transaction, skipping');
        return;
      }

      // Now read the original award inside the transaction (consistent with the lock).
      const award = await txQuery<{ id: string; base_xp: number; effective_xp: number; task_id: string; surge_multiplier: number }>(
        `SELECT id, base_xp, effective_xp, task_id, surge_multiplier FROM xp_ledger
         WHERE user_id = $1 AND escrow_id = $2
         ORDER BY awarded_at DESC LIMIT 1`,
        [userId, escrowId]
      );
      if (award.rows.length === 0) {
        // No XP was ever awarded for this escrow — nothing to clawback.
        log.info({ userId, escrowId, reason }, 'XP clawback: no award found for escrow, skipping');
        return;
      }

      // REG-10 FIX: Apply fraction to support partial clawback (e.g. 60% for partial dispute).
      // Clamp to [0, 1] to guard against bad callers.
      const clampedFraction = Math.min(1, Math.max(0, fraction));
      const xpToDeduct = Math.round(award.rows[0].effective_xp * clampedFraction);
      if (xpToDeduct === 0) return;
      const taskId = award.rows[0].task_id;

      // BUG FIX: Compute fraction-adjusted base_xp for the ledger debit entry.
      // Previously the INSERT used -base_xp (full amount) even for partial clawbacks,
      // causing the ledger to record -1000 XP when only 600 XP was actually deducted.
      const adjustedBaseXP = -Math.round(award.rows[0].base_xp * clampedFraction);
      const adjustedEffectiveXP = -xpToDeduct;

      // Insert a debit entry (negative effective_xp) to preserve ledger immutability (INV-4).
      // SECURITY FIX: ON CONFLICT DO NOTHING RETURNING makes this idempotent — if the
      // (user_id, escrow_id, reason) clawback row already exists (e.g. on retry), the
      // INSERT silently no-ops and rowCount=0 signals "already applied" rather than
      // swallowing a real unique-constraint error as a false success.
      const clawbackInsert = await txQuery<{ id: string }>(
        `INSERT INTO xp_ledger (
          user_id, task_id, escrow_id,
          base_xp, streak_multiplier, trust_multiplier, live_mode_multiplier, surge_multiplier, effective_xp,
          reason,
          user_xp_before, user_xp_after,
          user_level_before, user_level_after,
          user_streak_at_award
        )
        SELECT
          $1, $3, $2,
          $5, streak_multiplier, trust_multiplier, live_mode_multiplier, surge_multiplier, $6,
          $4,
          user_xp_after, GREATEST(0, user_xp_after - $7),
          user_level_after, user_level_before,
          user_streak_at_award
        FROM xp_ledger
        WHERE user_id = $1 AND escrow_id = $2
        ORDER BY awarded_at DESC LIMIT 1
        ON CONFLICT ON CONSTRAINT xp_ledger_escrow_reason_unique DO NOTHING
        RETURNING id`,
        [userId, escrowId, taskId, reason, adjustedBaseXP, adjustedEffectiveXP, xpToDeduct]
      );

      if (clawbackInsert.rowCount === 0) {
        // Clawback row already exists — idempotent success, no XP deducted again.
        log.info({ userId, escrowId, reason }, 'XP clawback: already applied (idempotent), skipping deduction');
        return;
      }

      // Update the user's running XP total (floor at 0) and recalculate current_level.
      // Both updates are inside this transaction so no concurrent write can interleave.
      const afterResult = await txQuery<{ xp_total: number; current_level: number }>(
        `UPDATE users SET xp_total = GREATEST(0, xp_total - $1), updated_at = NOW() WHERE id = $2
         RETURNING xp_total, current_level`,
        [xpToDeduct, userId]
      );

      if (afterResult.rows.length > 0) {
        const newXPTotal = afterResult.rows[0].xp_total;
        const newLevel = calculateLevel(newXPTotal);
        if (newLevel !== afterResult.rows[0].current_level) {
          await txQuery(
            `UPDATE users SET current_level = $1, updated_at = NOW() WHERE id = $2`,
            [newLevel, userId]
          );
        }
      }

      log.info({ userId, xpDeducted: xpToDeduct, reason, escrowId }, 'XP clawback applied');
    });
  },

  /**
   * Get daily XP leaderboard
   */
  getDailyLeaderboard: async (limit: number = 25): Promise<ServiceResult<Array<{ userId: string; name: string; xpEarned: number; rank: number }>>> => {
    try {
      const result = await db.query<{ user_id: string; name: string; xp_earned: string }>(
        `SELECT xl.user_id, u.full_name as name, SUM(xl.effective_xp)::INTEGER as xp_earned
         FROM xp_ledger xl
         JOIN users u ON u.id = xl.user_id
         WHERE xl.awarded_at AT TIME ZONE 'UTC' >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
           AND xl.awarded_at AT TIME ZONE 'UTC' < DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'
           AND u.is_banned = false
           AND u.account_status NOT IN ('DELETED', 'SUSPENDED')
         GROUP BY xl.user_id, u.full_name
         ORDER BY xp_earned DESC
         LIMIT $1`,
        [limit]
      );

      return {
        success: true,
        data: result.rows.map((row, idx) => ({
          userId: row.user_id,
          name: row.name || 'Anonymous',
          xpEarned: parseInt(row.xp_earned, 10),
          rank: idx + 1,
        })),
      };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },
};

export default XPService;
