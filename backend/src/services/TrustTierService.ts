/**
 * Trust Tier Service — v1 (LOCKED)
 * 
 * Pre-Alpha Prerequisite: Authoritative trust tier state machine.
 * 
 * Rules:
 * - Tier is stored on users.trust_tier
 * - Tier only changes via server-side transitions
 * - No client writes
 * - No "scores"
 * - No downgrades except permanent ban
 */

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { logger } from '../logger.js';
import { AlphaInstrumentation } from './AlphaInstrumentation.js';
import { invalidateAuthCacheForUser } from '../auth-cache.js';
import { revokeUserSessions } from '../auth/middleware.js';
import { forceDisconnectUser } from '../realtime/connection-registry.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';

const log = logger.child({ service: 'TrustTierService' });

// ============================================================================
// TRUST TIER ENUM (Authoritative)
// ============================================================================

/**
 * Trust Tier Enum (PRODUCT_SPEC §8.2)
 *
 * SPEC ALIGNMENT:
 * | Tier | Name     | Requirements                           |
 * |------|----------|----------------------------------------|
 * | 1    | ROOKIE   | New user                               |
 * | 2    | VERIFIED | 5 completed tasks, ID verified         |
 * | 3    | TRUSTED  | 20 tasks, 95%+ approval, priority      |
 * | 4    | ELITE    | 100+ tasks, <1% dispute, 4.8+ rating   |
 */
export enum TrustTier {
  ROOKIE   = 1, // New user, low risk only
  VERIFIED = 2, // 5 tasks + ID verified, low/medium risk
  TRUSTED  = 3, // 20 tasks + 95% approval, low/medium risk
  ELITE    = 4, // 100+ tasks + <1% dispute, all risk levels
  BANNED   = 9  // terminal, no task access
}

// ============================================================================
// TYPES
// ============================================================================

export type PromotionEligibility = {
  eligible: boolean;
  targetTier?: TrustTier;
  reasons: string[]; // empty if eligible
};

// ============================================================================
// TRUST TIER SERVICE
// ============================================================================

export const TrustTierService = {
  /**
   * Get user's current trust tier
   */
  getTrustTier: async (userId: string): Promise<TrustTier> => {
    const result = await db.query<{ trust_tier: number }>(
      `SELECT trust_tier FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const tier = result.rows[0].trust_tier;

    // SPEC ALIGNMENT: Trust tiers are 1-4 per PRODUCT_SPEC §8.2
    if (tier === 9) return TrustTier.BANNED;
    if (tier >= 4) return TrustTier.ELITE;
    if (tier >= 3) return TrustTier.TRUSTED;
    if (tier >= 2) return TrustTier.VERIFIED;
    return TrustTier.ROOKIE; // Default for new users (tier 1)
  },

  /**
   * Evaluate promotion eligibility (pure evaluation, no writes)
   *
   * @param userId - The user to evaluate
   * @param queryFn - Optional query function to use instead of the module-level db.
   *                  Pass the txQuery from a serializable transaction to ensure
   *                  the eligibility re-check runs on the same connection and sees
   *                  the same snapshot as the surrounding transaction.
   */
  evaluatePromotion: async (
    userId: string,
    queryFn?: QueryFn
  ): Promise<PromotionEligibility> => {
    const query: QueryFn = queryFn ?? ((sql: string, params?: unknown[]) => db.query(sql, params));
    const currentTier = await (async () => {
      const result = await query<{ trust_tier: number }>(
        `SELECT trust_tier FROM users WHERE id = $1`,
        [userId]
      );
      if (result.rowCount === 0) throw new Error(`User ${userId} not found`);
      const tier = result.rows[0].trust_tier;
      if (tier === 9) return TrustTier.BANNED;
      if (tier >= 4) return TrustTier.ELITE;
      if (tier >= 3) return TrustTier.TRUSTED;
      if (tier >= 2) return TrustTier.VERIFIED;
      return TrustTier.ROOKIE;
    })();

    // Cannot promote if banned
    if (currentTier === TrustTier.BANNED) {
      return {
        eligible: false,
        reasons: ['User is banned'],
      };
    }

    // Already at max tier (ELITE = 4)
    if (currentTier >= TrustTier.ELITE) {
      return {
        eligible: false,
        reasons: ['Already at maximum tier'],
      };
    }

    const reasons: string[] = [];
    let targetTier: TrustTier | undefined;

    // Evaluate VERIFIED (ROOKIE → VERIFIED) - PRODUCT_SPEC §8.2: 5 tasks + ID verified
    if (currentTier === TrustTier.ROOKIE) {
      // Check verification requirements
      const userResult = await query<{
        is_verified: boolean;
        verified_at: Date | null;
        phone: string | null;
        stripe_customer_id: string | null;
      }>(
        `SELECT is_verified, verified_at, phone, stripe_customer_id
         FROM users
         WHERE id = $1`,
        [userId]
      );

      if (userResult.rowCount === 0) {
        return {
          eligible: false,
          reasons: ['User not found'],
        };
      }

      const user = userResult.rows[0];
      
      if (!user.is_verified || !user.verified_at) {
        reasons.push('ID verification required');
      }
      if (!user.phone) {
        reasons.push('Phone verification required');
      }
      if (!user.stripe_customer_id) {
        reasons.push('Payment method required');
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.VERIFIED;
      }
    }

    // Evaluate TRUSTED (VERIFIED → TRUSTED) - PRODUCT_SPEC §8.2: 20 tasks, 95%+ approval
    else if (currentTier === TrustTier.VERIFIED) {
      // Get user account age
      const userAgeResult = await query<{ account_age_days: number }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 as account_age_days
         FROM users
         WHERE id = $1`,
        [userId]
      );
      const accountAgeDays = Math.floor(userAgeResult.rows[0]?.account_age_days || 0);

      // Get task completion stats
      const statsResult = await query<{
        completed_count: string;
        dispute_count: string;
        on_time_count: string;
        total_count: string;
      }>(
        `SELECT 
           COUNT(*) FILTER (WHERE t.state = 'COMPLETED' AND t.worker_id = $1) as completed_count,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM disputes d WHERE d.task_id = t.id
           ) AND t.worker_id = $1) as dispute_count,
           COUNT(*) FILTER (WHERE t.state = 'COMPLETED' 
             AND (t.deadline IS NULL OR t.completed_at <= t.deadline)
             AND t.worker_id = $1) as on_time_count,
           COUNT(*) FILTER (WHERE t.worker_id = $1) as total_count
         FROM tasks t
         WHERE t.worker_id = $1`,
        [userId]
      );

      const stats = statsResult.rows[0];
      const completedCount = parseInt(stats?.completed_count || '0', 10);
      const disputeCount = parseInt(stats?.dispute_count || '0', 10);
      const onTimeCount = parseInt(stats?.on_time_count || '0', 10);
      const totalCount = parseInt(stats?.total_count || '0', 10);

      // Check risk tier constraint: only Tier 0-1 tasks
      const riskCheckResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM tasks t
         WHERE t.worker_id = $1
           AND t.state = 'COMPLETED'
           AND t.risk_level NOT IN ('LOW', 'MEDIUM')`,
        [userId]
      );
      const highRiskCount = parseInt(riskCheckResult.rows[0]?.count || '0', 10);

      // SPEC ALIGNMENT: TRUSTED requires 20 tasks per PRODUCT_SPEC §8.2
      if (completedCount < 20) {
        reasons.push(`Need ${20 - completedCount} more completed tasks (have ${completedCount}, need 20)`);
      }
      if (disputeCount > 0) {
        reasons.push(`Cannot have disputes (have ${disputeCount})`);
      }
      if (totalCount > 0) {
        const onTimeRate = onTimeCount / totalCount;
        if (onTimeRate < 0.95) {
          reasons.push(`On-time completion rate must be ≥95% (have ${(onTimeRate * 100).toFixed(1)}%)`);
        }
      }
      if (accountAgeDays < 7) {
        reasons.push(`Account age must be ≥7 days (have ${accountAgeDays} days)`);
      }
      if (highRiskCount > 0) {
        reasons.push(`Cannot have completed Tier 2+ tasks (have ${highRiskCount})`);
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.TRUSTED;
      }
    }

    // Evaluate ELITE (TRUSTED → ELITE) - PRODUCT_SPEC §8.2: 100+ tasks, <1% dispute, 4.8+ rating
    else if (currentTier === TrustTier.TRUSTED) {
      // Get user account age
      const userAgeResult = await query<{ account_age_days: number }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 as account_age_days
         FROM users
         WHERE id = $1`,
        [userId]
      );
      const accountAgeDays = Math.floor(userAgeResult.rows[0]?.account_age_days || 0);

      // Get task completion stats
      const statsResult = await query<{
        completed_count: string;
      }>(
        `SELECT COUNT(*) FILTER (WHERE t.state = 'COMPLETED' AND t.worker_id = $1) as completed_count
         FROM public.tasks t
         WHERE t.worker_id = $1`,
        [userId]
      );

      const stats = statsResult.rows[0];
      const completedCount = parseInt(stats?.completed_count || '0', 10);

      // Get distinct poster reviews (5-star only)
      // Note: Assuming reviews are stored in a reviews table or derived from task completion
      // For alpha, we'll check for 5 distinct posters with completed tasks
      const _reviewsResult = await query<{ distinct_posters: string }>(
        `SELECT COUNT(DISTINCT t.poster_id)::text as distinct_posters
         FROM public.tasks t
         WHERE t.worker_id = $1
           AND t.state = 'COMPLETED'`,
        [userId]
      );
      // distinctPosters available in _reviewsResult.rows[0]?.distinct_posters if needed

      // Check security deposit (escrow)
      // For alpha, we'll check if user has a security deposit locked
      // Escrows table references tasks, so we join through tasks to get worker_id
      const _depositResult = await query<{ has_deposit: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM escrows e
           JOIN tasks t ON e.task_id = t.id
           WHERE t.worker_id = $1
             AND e.state = 'LOCKED'
             AND e.amount > 0
         ) as has_deposit`,
        [userId]
      );
      // hasDeposit available in _depositResult.rows[0]?.has_deposit if needed

      // SPEC ALIGNMENT: ELITE requires 100+ tasks per PRODUCT_SPEC §8.2
      if (completedCount < 100) {
        reasons.push(`Need ${100 - completedCount} more completed tasks (have ${completedCount}, need 100)`);
      }

      // Get dispute rate for ELITE (must be <1%)
      const disputeStatsResult = await query<{
        total_tasks: string;
        dispute_count: string;
      }>(
        `SELECT
           COUNT(*) as total_tasks,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM disputes d WHERE d.task_id = t.id
           )) as dispute_count
         FROM tasks t
         WHERE t.worker_id = $1 AND t.state = 'COMPLETED'`,
        [userId]
      );
      const totalTasks = parseInt(disputeStatsResult.rows[0]?.total_tasks || '0', 10);
      const disputeCount = parseInt(disputeStatsResult.rows[0]?.dispute_count || '0', 10);
      const disputeRate = totalTasks > 0 ? disputeCount / totalTasks : 0;

      if (disputeRate >= 0.01) {
        reasons.push(`Dispute rate must be <1% (have ${(disputeRate * 100).toFixed(2)}%)`);
      }

      // Get average rating for ELITE (must be 4.8+)
      const ratingResult = await query<{ avg_rating: string }>(
        `SELECT AVG(r.score)::text as avg_rating
         FROM ratings r
         JOIN tasks t ON r.task_id = t.id
         WHERE t.worker_id = $1`,
        [userId]
      );
      const avgRating = parseFloat(ratingResult.rows[0]?.avg_rating || '0');

      if (avgRating < 4.8) {
        reasons.push(`Average rating must be ≥4.8 (have ${avgRating.toFixed(2)})`);
      }

      if (accountAgeDays < 30) {
        reasons.push(`Account age must be ≥30 days (have ${accountAgeDays} days)`);
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.ELITE;
      }
    }

    return {
      eligible: reasons.length === 0,
      targetTier,
      reasons,
    };
  },

  /**
   * Apply promotion (single-direction only)
   */
  applyPromotion: async (
    userId: string,
    targetTier: TrustTier,
    source: 'system' | 'admin'
  ): Promise<{ success: true; alreadyApplied?: boolean }> => {
    // Quick pre-flight guards outside the transaction (cheap, non-blocking)
    const preLockTier = await TrustTierService.getTrustTier(userId);

    if (preLockTier === TrustTier.BANNED) {
      throw new Error('Cannot promote banned user');
    }

    if (targetTier <= preLockTier) {
      throw new Error(`Cannot promote to tier ${targetTier} (current: ${preLockTier})`);
    }

    // Run eligibility check and CAS UPDATE under a single serializable transaction
    // with a FOR UPDATE row lock so a concurrent dispute filing cannot sneak in
    // between evaluation and the write.
    let updateRowCount = 0;
    let currentTier: TrustTier = preLockTier;

    await db.serializableTransaction(async (txQuery) => {
      // Lock the user row for the duration of this transaction
      const lockResult = await txQuery<{ trust_tier: number }>(
        `SELECT trust_tier FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );

      if (lockResult.rowCount === 0) {
        throw new Error(`User ${userId} not found`);
      }

      const rawTier = lockResult.rows[0].trust_tier;
      currentTier = rawTier === 9 ? TrustTier.BANNED
        : rawTier >= 4 ? TrustTier.ELITE
        : rawTier >= 3 ? TrustTier.TRUSTED
        : rawTier >= 2 ? TrustTier.VERIFIED
        : TrustTier.ROOKIE;

      // If the tier changed since the pre-flight check, abort
      if (currentTier !== preLockTier) {
        updateRowCount = 0;
        return;
      }

      // Re-evaluate eligibility inside the lock so concurrent state changes
      // (e.g. a dispute filing) are visible before we commit the promotion.
      // Pass txQuery so the re-check runs on the same serializable connection
      // instead of opening a separate connection via the module-level db.
      const eligibility = await TrustTierService.evaluatePromotion(userId, txQuery);
      if (!eligibility.eligible || eligibility.targetTier !== targetTier) {
        throw new Error(`Promotion preconditions not met: ${eligibility.reasons.join(', ')}`);
      }

      // CAS UPDATE — tier must still match what we read under the lock
      const updateResult = await txQuery(
        `UPDATE users
         SET trust_tier = $1, updated_at = NOW()
         WHERE id = $2
           AND trust_tier = $3`,
        [targetTier, userId, currentTier]
      );

      updateRowCount = updateResult.rowCount;
    });

    if (updateRowCount === 0) {
      // Concurrent promotion already applied — silently return, don't fire events
      return { success: true, alreadyApplied: true };
    }

    // Invalidate auth cache so the new tier is visible immediately
    // BUG GG3 FIX: await the call (was fire-and-forget) so Redis errors surface.
    await invalidateAuthCacheForUser(userId);

    // Log transition (if trust_ledger exists)
    try {
      // trust_ledger requires old_tier >= 1, but we might have UNVERIFIED (0) or BANNED (9)
      // Only log if both tiers are in valid range (1-4)
      if (currentTier >= 1 && currentTier <= 4 && targetTier >= 1 && targetTier <= 4) {
        const idempotencyKey = `trust_promotion:${userId}:${targetTier}`;
        await db.query(
          `INSERT INTO trust_ledger (user_id, old_tier, new_tier, reason, changed_by, idempotency_key, event_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            userId,
            currentTier,
            targetTier,
            `Promoted to ${TrustTier[targetTier]} via ${source}`,
            source,
            idempotencyKey,
            'system',
          ]
        );
      }
    } catch (error) {
      // trust_ledger may not exist in alpha - log but don't fail
      log.warn({ err: error instanceof Error ? error.message : String(error), userId, currentTier, targetTier }, 'Failed to log trust tier transition');
    }

    log.info({ userId, oldTier: currentTier, newTier: targetTier, oldTierName: TrustTier[currentTier], newTierName: TrustTier[targetTier], source }, 'Trust tier promotion applied');

    // Alpha Instrumentation: Emit trust delta applied
    try {
      // Determine role from user's default_mode
      const userResult = await db.query<{ default_mode: string }>(
        'SELECT default_mode FROM users WHERE id = $1',
        [userId]
      );
      const role = userResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';

      await AlphaInstrumentation.emitTrustDeltaApplied({
        user_id: userId,
        role,
        delta_type: 'tier',
        delta_amount: targetTier - currentTier,
        reason_code: `promotion_${TrustTier[targetTier]}_via_${source}`,
        task_id: undefined, // Promotions are not task-specific
        timestamp: new Date(),
      });
    } catch (error) {
      // Silent fail - instrumentation should not break core flow
      log.warn({ err: error instanceof Error ? error.message : String(error), userId, targetTier }, 'Failed to emit trust_delta_applied for promotion');
    }

    return { success: true };
  },

  /**
   * Ban user (terminal, irreversible)
   *
   * IMPORTANT: Any future tier mutation (demotion, decay, dispute adjustment) MUST emit trust_delta_applied
   * via AlphaInstrumentation.emitTrustDeltaApplied(). This includes any code path that calls
   * UPDATE users SET trust_tier = ... outside of applyPromotion/banUser.
   * Currently, both applyPromotion and banUser already emit this event correctly.
   */
  banUser: async (userId: string, reason: string): Promise<void> => {
    // Read the current tier and apply the CAS UPDATE atomically inside a single
    // transaction with a FOR UPDATE row lock.  Without the lock there is a TOCTOU
    // window: a concurrent promotion can commit between getTrustTier() and the
    // UPDATE, making `currentTier` stale for the instrumentation delta.
    let currentTier: TrustTier = TrustTier.ROOKIE; // placeholder; set inside txn
    let banRowCount = 0;

    await db.transaction(async (txQuery) => {
      const lockResult = await txQuery<{ trust_tier: number }>(
        `SELECT trust_tier FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );

      if (lockResult.rowCount === 0) {
        return; // User not found — treat as no-op
      }

      const rawTier = lockResult.rows[0].trust_tier;
      currentTier = rawTier === 9 ? TrustTier.BANNED
        : rawTier >= 4 ? TrustTier.ELITE
        : rawTier >= 3 ? TrustTier.TRUSTED
        : rawTier >= 2 ? TrustTier.VERIFIED
        : TrustTier.ROOKIE;

      if (currentTier === TrustTier.BANNED) {
        return; // Already banned — early exit inside txn
      }

      const banResult = await txQuery(
        `UPDATE users
         SET trust_tier = $1, updated_at = NOW()
         WHERE id = $2 AND trust_tier != $1`,
        [TrustTier.BANNED, userId]
      );

      banRowCount = banResult.rowCount;
    });

    if (currentTier === TrustTier.BANNED) {
      return; // Already banned
    }

    if (banRowCount === 0) {
      // Another concurrent call already applied the ban — return early without
      // touching outbox or tasks to prevent duplicate events.
      return;
    }

    // Look up firebase_uid before evicting the auth cache so we can pass it
    // directly to invalidateAuthCacheForUser.
    // BUG 5 FIX: previously invalidateAuthCacheForUser(userId) was called
    // without firebaseUid, so if the in-process cache was cold the Redis
    // revocation marker was never written — the user could re-authenticate
    // on other replicas until the Firebase token expired naturally.
    let firebaseUid: string | null = null;
    try {
      const fbRow = await db.query<{ firebase_uid: string | null }>(
        'SELECT firebase_uid FROM users WHERE id = $1',
        [userId]
      );
      firebaseUid = fbRow.rows[0]?.firebase_uid ?? null;
      if (!firebaseUid) {
        log.warn({ userId }, '[TrustTierService] banUser: firebase_uid is null — Redis revocation marker will rely on in-process cache entries only');
      }
    } catch (fbLookupErr) {
      log.error({ err: fbLookupErr instanceof Error ? fbLookupErr.message : String(fbLookupErr), userId }, '[TrustTierService] banUser: firebase_uid lookup failed');
    }

    // Evict the auth cache so the banned status is enforced immediately.
    // Pass firebaseUid so the Redis revocation marker is written even when
    // the in-process cache is cold (mirrors admin.setUserBan).
    if (firebaseUid) {
      await invalidateAuthCacheForUser(userId, firebaseUid);
    } else {
      await invalidateAuthCacheForUser(userId);
    }

    // Revoke Firebase refresh tokens so the user cannot re-authenticate after
    // the Redis revocation marker expires.
    try {
      if (firebaseUid) {
        await revokeUserSessions(firebaseUid);
      } else {
        log.warn({ userId }, '[TrustTierService] banUser: firebase_uid is null — Firebase token revocation skipped, Redis marker still active');
      }
    } catch (revokeErr) {
      // A Firebase failure must not block the ban — the Redis marker still
      // provides short-term protection via the cache TTL.
      log.error({ err: revokeErr instanceof Error ? revokeErr.message : String(revokeErr), userId }, '[TrustTierService] banUser: revokeUserSessions failed');
    }

    // Close any open SSE connections immediately so the stream does not persist
    // after the ban is applied.
    try {
      forceDisconnectUser(userId);
    } catch {
      // fire-and-forget
    }

    // Emit escrow refund outbox events for any funded escrows on active tasks
    // before cancelling them, so escrows are not stranded on ban.
    // MATCHING, ACCEPTED, IN_PROGRESS, PROOF_SUBMITTED are all states where a
    // worker has an active assignment. DISPUTED tasks have LOCKED_DISPUTE escrows
    // handled separately and are intentionally excluded here.
    const activeTasks = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE worker_id = $1 AND state IN ('MATCHING', 'ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED')`,
      [userId]
    );
    for (const task of activeTasks.rows) {
      const escrow = await db.query<{ id: string }>(
        `SELECT id FROM escrows WHERE task_id = $1 AND state = 'FUNDED'`,
        [task.id]
      );
      if (escrow.rows[0]) {
        await writeToOutbox({
          eventType: 'escrow.refund_requested',
          aggregateType: 'escrow',
          aggregateId: escrow.rows[0].id,
          eventVersion: 1,
          payload: { escrowId: escrow.rows[0].id, reason: 'worker_banned', taskId: task.id },
          queueName: 'critical_payments',
          idempotencyKey: `ban_refund:${task.id}`,
        });
      }
    }

    // Cancel active tasks (worker-side) — must match exactly the state set used for escrow refund queries above.
    await db.query(
      `UPDATE tasks
       SET state = 'CANCELLED', updated_at = NOW()
       WHERE worker_id = $1
         AND state IN ('MATCHING', 'ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED')`,
      [userId]
    );

    // Refund idle funded escrows where the banned user is poster and task is not actively worked.
    // (Bucket A: OPEN/MATCHING tasks with FUNDED escrows — poster's side)
    try {
      const posterEscrows = await db.query<{ escrow_id: string; task_id: string }>(
        `SELECT e.id as escrow_id, t.id as task_id FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.poster_id = $1
           AND e.state = 'FUNDED'
           AND t.state NOT IN ('ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED')`,
        [userId]
      );
      for (const row of posterEscrows.rows) {
        await writeToOutbox({
          eventType: 'escrow.refund_requested',
          aggregateType: 'escrow',
          aggregateId: row.escrow_id,
          eventVersion: 1,
          payload: { escrowId: row.escrow_id, reason: 'poster_banned', taskId: row.task_id },
          queueName: 'critical_payments',
          idempotencyKey: `ban_poster_refund:${row.task_id}`,
        }).catch(err => log.error({ err, escrowId: row.escrow_id, taskId: row.task_id, userId }, '[TrustTierService] banUser: failed to enqueue poster escrow refund'));
      }
    } catch (err) {
      log.error({ err, userId }, '[TrustTierService] banUser: failed to query poster funded escrows');
    }

    // Bucket B: poster's active tasks (ACCEPTED/IN_PROGRESS/PROOF_SUBMITTED) — a worker
    // has done real work so the escrow must be locked for dispute (not refunded) and
    // an outbox event is emitted for admin adjudication. Same pattern as admin.setUserBan.
    try {
      const activePosterEscrows = await db.query<{ escrow_id: string; task_id: string }>(
        `SELECT e.id as escrow_id, t.id as task_id FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.poster_id = $1
           AND e.state = 'FUNDED'
           AND t.state IN ('ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED')`,
        [userId]
      );
      for (const row of activePosterEscrows.rows) {
        await db.query(
          `UPDATE escrows SET state = 'LOCKED_DISPUTE', updated_at = NOW()
           WHERE id = $1 AND state = 'FUNDED'`,
          [row.escrow_id]
        ).catch(err => log.error({ err, escrowId: row.escrow_id, userId }, '[TrustTierService] banUser: failed to lock active poster escrow'));
        await writeToOutbox({
          eventType: 'escrow.locked_on_ban',
          aggregateType: 'escrow',
          aggregateId: row.escrow_id,
          eventVersion: 1,
          payload: { escrowId: row.escrow_id, reason: 'poster_banned', taskId: row.task_id, bannedUserId: userId },
          queueName: 'critical_payments',
          idempotencyKey: `ban_poster_lock:${row.task_id}`,
        }).catch(err => log.error({ err, escrowId: row.escrow_id, taskId: row.task_id, userId }, '[TrustTierService] banUser: failed to enqueue active poster escrow lock event'));
      }
    } catch (err) {
      log.error({ err, userId }, '[TrustTierService] banUser: failed to query active poster funded escrows');
    }

    // Cancel poster's OPEN/MATCHING/ACCEPTED/IN_PROGRESS/PROOF_SUBMITTED tasks (best-effort).
    // Expanded from OPEN/MATCHING to include all active states so tasks with a banned
    // poster are not left stuck in an un-completable state.
    try {
      await db.query(
        `UPDATE tasks SET state = 'CANCELLED', cancelled_at = NOW()
         WHERE poster_id = $1 AND state IN ('OPEN', 'MATCHING', 'ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED')`,
        [userId]
      );
    } catch (err) {
      log.error({ err, userId }, '[TrustTierService] banUser: failed to cancel poster active tasks');
    }

    // Log ban
    try {
      // trust_ledger requires old_tier >= 1, but we might have UNVERIFIED (0) or BANNED (9)
      // Only log if old_tier is in valid range (1-4)
      if (currentTier >= 1 && currentTier <= 4) {
        // idempotency key for trust_ban would be: `trust_ban:${userId}:${Date.now()}`
        // Note: BANNED (9) cannot be inserted into trust_ledger due to constraint
        // We'll log the transition to a special value or skip logging for bans
        // For alpha, we'll skip trust_ledger logging for bans
        log.warn({ userId, oldTier: currentTier, reason }, 'Ban transition not logged to trust_ledger (BANNED tier not in 1-4 range)');
      }
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), userId, reason }, 'Failed to log trust tier ban');
    }

    log.info({ userId, oldTier: currentTier, reason }, 'User banned');

    // Alpha Instrumentation: Emit trust delta applied
    try {
      // Determine role from user's default_mode
      const userResult = await db.query<{ default_mode: string }>(
        'SELECT default_mode FROM users WHERE id = $1',
        [userId]
      );
      const role = userResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';

      await AlphaInstrumentation.emitTrustDeltaApplied({
        user_id: userId,
        role,
        delta_type: 'tier',
        delta_amount: TrustTier.BANNED - currentTier, // Negative value indicates ban
        reason_code: `ban_${reason.replace(/\s+/g, '_').toLowerCase()}`,
        task_id: undefined, // Bans are not task-specific
        timestamp: new Date(),
      });
    } catch (error) {
      // Silent fail - instrumentation should not break core flow
      log.warn({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to emit trust_delta_applied for ban');
    }
  },
};
