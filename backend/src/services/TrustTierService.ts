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
import { randomUUID } from 'node:crypto';
import { issueDeactivationAppealRight } from './WorkerStandingDecisionService.js';

const log = logger.child({ service: 'TrustTierService' });

// ============================================================================
// TRUST TIER ENUM (Authoritative)
// ============================================================================

/**
 * Canonical provider trust tiers from the Local Work Network blueprint.
 *
 * Tier 5 (Enterprise Crew) is intentionally absent. It belongs to the later
 * business-provider phase and must not be approximated by an individual
 * worker tier.
 */
export enum TrustTier {
  EXPLORER = 0,
  VERIFIED = 1,
  HOME_READY = 2,
  PRO = 3,
  LICENSED_SPECIALIST = 4,
  BANNED = 9,
}

export const TRUST_TIER_POLICY_VERSION = 'hustler-trust-progression-v1';

export function trustTierName(tier: TrustTier | number): string {
  switch (tier) {
    case TrustTier.EXPLORER: return 'Explorer';
    case TrustTier.VERIFIED: return 'Verified';
    case TrustTier.HOME_READY: return 'Home Ready';
    case TrustTier.PRO: return 'Pro';
    case TrustTier.LICENSED_SPECIALIST: return 'Licensed Specialist';
    case TrustTier.BANNED: return 'Deactivated';
    default: return 'Unknown';
  }
}

// ============================================================================
// TYPES
// ============================================================================

export type PromotionEligibility = {
  eligible: boolean;
  targetTier?: TrustTier;
  reasons: string[]; // empty if eligible
};

function trustTierFromRow(tier: number, isBanned: boolean): TrustTier {
  if (isBanned || tier === TrustTier.BANNED) return TrustTier.BANNED;
  if (tier === TrustTier.LICENSED_SPECIALIST) return TrustTier.LICENSED_SPECIALIST;
  if (tier === TrustTier.PRO) return TrustTier.PRO;
  if (tier === TrustTier.HOME_READY) return TrustTier.HOME_READY;
  if (tier === TrustTier.VERIFIED) return TrustTier.VERIFIED;
  if (tier === TrustTier.EXPLORER) return TrustTier.EXPLORER;
  throw new Error(`Invalid persisted trust tier ${tier}`);
}

// ============================================================================
// TRUST TIER SERVICE
// ============================================================================

export const TrustTierService = {
  /**
   * Get user's current trust tier
   */
  getTrustTier: async (userId: string): Promise<TrustTier> => {
    const result = await db.query<{ trust_tier: number; is_banned: boolean }>(
      `SELECT trust_tier, is_banned FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const row = result.rows[0];
    return trustTierFromRow(row.trust_tier, row.is_banned);
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
      const result = await query<{ trust_tier: number; is_banned: boolean }>(
        `SELECT trust_tier, is_banned FROM users WHERE id = $1`,
        [userId]
      );
      if (result.rowCount === 0) throw new Error(`User ${userId} not found`);
      const row = result.rows[0];
      return trustTierFromRow(row.trust_tier, row.is_banned);
    })();

    // Cannot promote if banned
    if (currentTier === TrustTier.BANNED) {
      return {
        eligible: false,
        reasons: ['User is banned'],
      };
    }

    // Enterprise Crew is not an individual-worker tier. Licensed Specialist
    // is the maximum tier represented in this release.
    if (currentTier >= TrustTier.LICENSED_SPECIALIST) {
      return {
        eligible: false,
        reasons: ['Already at maximum tier'],
      };
    }

    const reasons: string[] = [];
    let targetTier: TrustTier | undefined;

    // Explorer → Verified: identity, phone, and payout onboarding are all
    // required. A phone claim by itself never raises trust.
    if (currentTier === TrustTier.EXPLORER) {
      const userResult = await query<{
        is_verified: boolean;
        verified_at: Date | null;
        identity_verification_status: string | null;
        identity_verification_environment: string | null;
        identity_verification_expires_at: Date | null;
        phone: string | null;
        stripe_connect_id: string | null;
        payouts_enabled: boolean;
      }>(
        `SELECT is_verified, verified_at,
                identity_verification_status,identity_verification_environment,
                identity_verification_expires_at,
                phone, stripe_connect_id, payouts_enabled
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

      if (!user.is_verified || !user.verified_at
        || user.identity_verification_status !== 'VERIFIED'
        || user.identity_verification_environment !== 'PRODUCTION'
        || !user.identity_verification_expires_at
        || new Date(user.identity_verification_expires_at).getTime() <= Date.now()) {
        reasons.push('ID verification required');
      }
      if (!user.phone) {
        reasons.push('Phone verification required');
      }
      if (!user.stripe_connect_id || !user.payouts_enabled) {
        reasons.push('Payout onboarding required');
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.VERIFIED;
      }
    }

    // Verified → Home Ready: a current, non-test production screening and
    // actual production completion history are mandatory. A filed dispute is
    // not treated as guilt; only an active unresolved dispute pauses access.
    else if (currentTier === TrustTier.VERIFIED) {
      const screeningResult = await query<{ current_screening: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM background_checks screening
           WHERE screening.user_id = $1
             AND upper(screening.status) = 'CLEAR'
             AND screening.provider_environment = 'PRODUCTION'
             AND screening.is_test = FALSE
             AND (screening.expires_at IS NULL OR screening.expires_at > NOW())
         ) AS current_screening`,
        [userId]
      );
      const statsResult = await query<{
        completed_count: string;
        active_dispute_count: string;
      }>(
        `SELECT
           COUNT(*) FILTER (
             WHERE task.state = 'COMPLETED'
               AND task.automation_classification = 'PRODUCTION'
           )::text AS completed_count,
           (
             SELECT COUNT(*)::text FROM disputes dispute
             WHERE dispute.worker_id = $1
               AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED')
           ) AS active_dispute_count
         FROM tasks task
         WHERE task.worker_id = $1`,
        [userId]
      );

      const stats = statsResult.rows[0];
      const completedCount = parseInt(stats?.completed_count || '0', 10);
      const activeDisputeCount = parseInt(stats?.active_dispute_count || '0', 10);

      if (!screeningResult.rows[0]?.current_screening) {
        reasons.push('Current production enhanced screening required');
      }
      if (completedCount < 5) {
        reasons.push(`Need ${5 - completedCount} more verified production completions (have ${completedCount}, need 5)`);
      }
      if (activeDisputeCount > 0) {
        reasons.push('Active dispute review must be resolved before Home Ready progression');
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.HOME_READY;
      }
    }

    // Business-provider onboarding is Phase 2. Do not infer business identity,
    // insurance, or commercial credentials from task counts or XP.
    else if (currentTier === TrustTier.HOME_READY) {
      reasons.push(
        'Pro progression is not enabled in the Build-Now release; production business verification, insurance, and applicable credentials are required',
      );
    }

    // Regulated categories are outside the launch-cell green lanes. Numeric
    // tier alone never substitutes for jurisdiction-specific license evidence.
    else if (currentTier === TrustTier.PRO) {
      reasons.push(
        'Licensed Specialist progression is not enabled in the Build-Now release; current jurisdiction-specific license verification is required',
      );
    }

    return {
      eligible: reasons.length === 0 && targetTier !== undefined,
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
    if (targetTier < TrustTier.VERIFIED || targetTier > TrustTier.LICENSED_SPECIALIST) {
      throw new Error(`Unsupported promotion target ${targetTier}`);
    }

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
    const transitionId = randomUUID();

    await db.serializableTransaction(async (txQuery) => {
      // Lock the user row for the duration of this transaction
      const lockResult = await txQuery<{ trust_tier: number; is_banned: boolean }>(
        `SELECT trust_tier, is_banned FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );

      if (lockResult.rowCount === 0) {
        throw new Error(`User ${userId} not found`);
      }

      const lockedUser = lockResult.rows[0];
      currentTier = trustTierFromRow(lockedUser.trust_tier, lockedUser.is_banned);

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

      await txQuery(
        `SELECT set_config('hustlexp.trust_promotion_authority', $1, TRUE)`,
        [`${TRUST_TIER_POLICY_VERSION}:${transitionId}`],
      );

      // CAS UPDATE — tier must still match what we read under the lock
      const updateResult = await txQuery(
        `UPDATE users
         SET trust_tier = $1, updated_at = NOW()
         WHERE id = $2
           AND trust_tier = $3`,
        [targetTier, userId, currentTier]
      );

      updateRowCount = updateResult.rowCount;
      if (updateRowCount === 0) return;

      // Keep the derived dispatch profile synchronized in the same transaction.
      // Missing profiles remain safely ineligible until onboarding creates one.
      await txQuery(
        `UPDATE capability_profiles
         SET trust_tier = $1,
             risk_clearance = CASE $1::integer
               WHEN 0 THEN ARRAY['low']::text[]
               WHEN 1 THEN ARRAY['low']::text[]
               WHEN 2 THEN ARRAY['low','medium']::text[]
               ELSE ARRAY['low','medium','high']::text[]
             END,
             updated_at = NOW()
         WHERE user_id = $2`,
        [targetTier, userId],
      );

      // The Tier 0 → 1 transition is material trust evidence and must not be
      // omitted from the append-only ledger.
      await txQuery(
        `INSERT INTO trust_ledger (
           user_id,old_tier,new_tier,reason,reason_details,changed_by,
           idempotency_key,event_source,source_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'system',$8)`,
        [
          userId,
          currentTier,
          targetTier,
          `Promoted to ${trustTierName(targetTier)} via ${source}`,
          JSON.stringify({ policyVersion: TRUST_TIER_POLICY_VERSION, source }),
          source,
          `trust_promotion:${transitionId}`,
          transitionId,
        ],
      );
    });

    if (updateRowCount === 0) {
      // Concurrent promotion already applied — silently return, don't fire events
      return { success: true, alreadyApplied: true };
    }

    // Invalidate auth cache so the new tier is visible immediately
    // BUG GG3 FIX: await the call (was fire-and-forget) so Redis errors surface.
    // A59-2 FIX: Pre-fetch firebase_uid so the Redis revocation marker is written
    // correctly even when the in-process cache is cold (user not yet cached on
    // this replica). Without this, invalidateAuthCacheForUser(userId) falls back
    // to a DB lookup internally which may fail silently.
    const firebaseUidResult = await db.query<{ firebase_uid: string }>(
      'SELECT firebase_uid FROM users WHERE id = $1',
      [userId]
    );
    const firebaseUid = firebaseUidResult.rows[0]?.firebase_uid;
    await invalidateAuthCacheForUser(userId, firebaseUid);

    log.info({
      userId,
      oldTier: currentTier,
      newTier: targetTier,
      oldTierName: trustTierName(currentTier),
      newTierName: trustTierName(targetTier),
      policyVersion: TRUST_TIER_POLICY_VERSION,
      source,
    }, 'Trust tier promotion applied');

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
        reason_code: `promotion_${trustTierName(targetTier).toLowerCase().replace(/\s+/g, '_')}_via_${source}`,
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
    let currentTier: TrustTier = TrustTier.EXPLORER; // placeholder; set inside txn
    let banRowCount = 0;
    let alreadyBanned = false;
    const standingDecisionKey = `trust-ban:${randomUUID()}`;

    await db.transaction(async (txQuery) => {
      const lockResult = await txQuery<{ trust_tier: number; is_banned: boolean; default_mode: string }>(
        `SELECT trust_tier, is_banned, default_mode FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );

      if (lockResult.rowCount === 0) {
        return; // User not found — treat as no-op
      }

      const lockedUser = lockResult.rows[0];
      currentTier = trustTierFromRow(lockedUser.trust_tier, false);

      if (lockedUser.is_banned) {
        alreadyBanned = true;
        return; // Already banned — early exit inside txn
      }

      const banResult = await txQuery(
        `UPDATE users
         SET is_banned = TRUE, updated_at = NOW()
         WHERE id = $1 AND is_banned = FALSE`,
        [userId]
      );

      banRowCount = banResult.rowCount;
      if (banRowCount > 0 && lockedUser.default_mode === 'worker') {
        await issueDeactivationAppealRight({
          query: txQuery,
          workerId: userId,
          currentTier,
          decidedBy: null,
          decisionSource: 'SYSTEM',
          reason,
          sourceIdempotencyKey: standingDecisionKey,
        });
      }
    });

    if (alreadyBanned) {
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
        delta_amount: 0,
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
