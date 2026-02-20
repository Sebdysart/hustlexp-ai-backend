/**
 * ExpertiseSupplyService v1.0.0
 *
 * SUPPLY CONTROL ENGINE — Prevents supply/demand imbalance in the marketplace.
 *
 * Core Concept: Weighted Slot Allocation with Ratio-Based Gating
 *   - Each hustler has max_skill_weight = 1.0
 *   - Primary skill = 0.7 weight, Secondary = 0.3 weight
 *   - Max 2 expertise per hustler (in beta)
 *   - Capacity per expertise per zone enforced by dual gates:
 *     1. Hard Cap: absolute max weighted supply
 *     2. Dynamic Ratio Gate: liquidity_ratio = completed_tasks_7d / effective_supply_weight
 *        (Primary = completed throughput. Secondary = open_tasks_7d for responsiveness.)
 *        If ratio < min_task_to_supply_ratio → block new hustlers
 *
 * Activity Decay:
 *   - 14d inactive → effective_weight * 0.5
 *   - 30d+ inactive → effective_weight = 0
 *   - Recalculated daily via cron
 *
 * Auto-Expansion:
 *   - If P95 acceptance time > 6 hours → temporarily expand cap +10%
 *   - Expires after 7 days (resets if threshold still exceeded)
 *
 * @see expertise_supply_control.sql
 * @see BetaService.ts
 */

import { db } from '../db';
import { logger } from '../logger';
import type { QueryFn } from '../db';
import type { ServiceResult } from '../types';
import { NotificationService } from './NotificationService';

const log = logger.child({ service: 'ExpertiseSupplyService' });

// ============================================================================
// TYPES
// ============================================================================

interface ExpertiseInfo {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  riskTier: string;
  active: boolean;
}

interface CapacityStatus {
  expertiseId: string;
  expertiseSlug: string;
  expertiseDisplayName: string;
  geoZone: string;
  // Capacity
  maxWeightCapacity: number;
  effectiveMaxCapacity: number; // After auto-expansion
  currentWeight: number;
  remainingCapacity: number;
  capacityPct: number;
  // Ratio gating (dual signal)
  minTaskToSupplyRatio: number;
  liquidityRatio: number;    // PRIMARY: completed_tasks_7d / effective_weight
  openRatio: number;         // SECONDARY: open_tasks_7d / effective_weight
  completedTasks7d: number;
  openTasks7d: number;
  activeHustlers: number;
  // Gate result
  isAcceptingNew: boolean;
  blockReason: string | null;
  // Auto-expansion
  autoExpandPct: number;
  autoExpandExpiresAt: string | null;
  // Waitlist
  waitlistLength: number;
}

interface UserExpertise {
  id: string;
  expertiseId: string;
  expertiseSlug: string;
  expertiseDisplayName: string;
  geoZone: string;
  slotWeight: number;
  isPrimary: boolean;
  effectiveWeight: number;
  status: string;
  lockedUntil: string | null;
  lastTaskAcceptedAt: string | null;
  tasksAccepted14d: number;
  tasksCompleted14d: number;
  createdAt: string;
}

interface WaitlistEntry {
  id: string;
  expertiseSlug: string;
  expertiseDisplayName: string;
  geoZone: string;
  position: number;
  requestedWeight: number;
  status: string;
  invitedAt: string | null;
  inviteExpiresAt: string | null;
  createdAt: string;
}

interface SupplyDashboard {
  expertise: Array<CapacityStatus>;
  totals: {
    totalActiveHustlers: number;
    totalEffectiveWeight: number;
    totalOpenTasks7d: number;
    overallLiquidityRatio: number;
    totalWaitlisted: number;
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PRIMARY_WEIGHT = 0.7;
const SECONDARY_WEIGHT = 0.3;
const MAX_EXPERTISE_PER_USER = 2;
const SKILL_CHANGE_LOCK_DAYS = 30;
const DECAY_THRESHOLD_DAYS = 14;
const DECAY_ZERO_THRESHOLD_DAYS = 30;
const DECAY_MULTIPLIER = 0.5;
const AUTO_EXPAND_PCT = 10;
const AUTO_EXPAND_DURATION_DAYS = 7;
const P95_ACCEPTANCE_THRESHOLD_HOURS = 6;
const P95_MIN_SAMPLE_SIZE = 10; // Don't auto-expand from noise — need ≥10 accepted tasks
const WAITLIST_INVITE_EXPIRY_HOURS = 48;
const DECAY_COOLDOWN_DAYS = 7; // After weight decays to 0, must wait 7 days before re-joining same expertise

// ============================================================================
// SERVICE
// ============================================================================

export const ExpertiseSupplyService = {
  // ==========================================================================
  // EXPERTISE REGISTRY
  // ==========================================================================

  /**
   * List all active expertise categories.
   */
  listExpertise: async (): Promise<ServiceResult<ExpertiseInfo[]>> => {
    try {
      const result = await db.query<{
        id: string;
        slug: string;
        display_name: string;
        description: string | null;
        risk_tier: string;
        active: boolean;
      }>(
        `SELECT id, slug, display_name, description, risk_tier, active
         FROM expertise_registry
         WHERE active = TRUE
         ORDER BY sort_order ASC`
      );

      return {
        success: true,
        data: result.rows.map(r => ({
          id: r.id,
          slug: r.slug,
          displayName: r.display_name,
          description: r.description,
          riskTier: r.risk_tier,
          active: r.active,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EXPERTISE_LIST_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // ==========================================================================
  // CAPACITY CHECK (The Gate)
  // ==========================================================================

  /**
   * Check whether a specific expertise in a zone is accepting new hustlers.
   *
   * Two-gate system:
   *   Gate 1: Hard cap — effective_max (capacity + auto_expand) vs current_weight
   *   Gate 2: Ratio — liquidity_ratio >= min_task_to_supply_ratio
   *
   * Both must pass for admission.
   */
  checkCapacity: async (
    expertiseId: string,
    geoZone: string = 'seattle_metro'
  ): Promise<ServiceResult<CapacityStatus>> => {
    try {
      // Get capacity record
      const capResult = await db.query<{
        id: string;
        expertise_id: string;
        geo_zone: string;
        max_weight_capacity: string;
        min_task_to_supply_ratio: string;
        current_weight: string;
        active_hustlers: string;
        open_tasks_7d: string;
        completed_tasks_7d: string;
        liquidity_ratio: string;
        open_ratio: string;
        auto_expand_pct: string;
        auto_expand_expires_at: string | null;
      }>(
        `SELECT ec.*, er.slug, er.display_name
         FROM expertise_capacity ec
         JOIN expertise_registry er ON er.id = ec.expertise_id
         WHERE ec.expertise_id = $1 AND ec.geo_zone = $2`,
        [expertiseId, geoZone]
      );

      if (capResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'CAPACITY_NOT_FOUND',
            message: `No capacity record for expertise ${expertiseId} in zone ${geoZone}`,
          },
        };
      }

      const cap = capResult.rows[0];

      // Get expertise info
      const expResult = await db.query<{ slug: string; display_name: string }>(
        `SELECT slug, display_name FROM expertise_registry WHERE id = $1`,
        [expertiseId]
      );
      const slug = expResult.rows[0]?.slug || '';
      const displayName = expResult.rows[0]?.display_name || '';

      // Calculate effective max (with auto-expansion)
      const maxWeight = parseFloat(cap.max_weight_capacity);
      const autoExpandPct = parseInt(cap.auto_expand_pct, 10);
      const autoExpandExpiresAt = cap.auto_expand_expires_at;
      const isExpansionActive = autoExpandExpiresAt
        ? new Date(autoExpandExpiresAt) > new Date()
        : false;
      const effectiveExpand = isExpansionActive ? autoExpandPct : 0;
      const effectiveMax = maxWeight * (1 + effectiveExpand / 100);

      const currentWeight = parseFloat(cap.current_weight);
      const minRatio = parseFloat(cap.min_task_to_supply_ratio);
      const liquidityRatio = parseFloat(cap.liquidity_ratio);  // completed-based (primary)
      const openRatioVal = parseFloat(cap.open_ratio || '0');   // open-based (secondary)
      const openTasks = parseInt(cap.open_tasks_7d, 10);
      const completedTasks = parseInt(cap.completed_tasks_7d || '0', 10);
      const activeHustlers = parseInt(cap.active_hustlers, 10);

      // Gate 1: Hard cap
      const hasCapacity = currentWeight < effectiveMax;

      // Gate 2: Ratio — uses completed_tasks_7d (real throughput), not open_tasks_7d
      // Skip if no hustlers yet — allow first entrants
      const ratioOk = activeHustlers === 0 || liquidityRatio >= minRatio;

      // Block reason
      let blockReason: string | null = null;
      if (!hasCapacity && !ratioOk) {
        blockReason = `${displayName} is at capacity AND has insufficient task throughput. Supply: ${currentWeight.toFixed(1)}/${effectiveMax.toFixed(1)}, completed ratio: ${liquidityRatio.toFixed(2)} (min: ${minRatio})`;
      } else if (!hasCapacity) {
        blockReason = `${displayName} has reached maximum capacity (${currentWeight.toFixed(1)}/${effectiveMax.toFixed(1)} weighted slots). Join the waitlist!`;
      } else if (!ratioOk) {
        blockReason = `Not enough completed ${displayName} tasks to support more hustlers. Throughput ratio: ${liquidityRatio.toFixed(2)} (min: ${minRatio}). You'll be invited when demand increases.`;
      }

      // Waitlist count
      const waitlistResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM expertise_waitlist
         WHERE expertise_id = $1 AND geo_zone = $2 AND status = 'waiting'`,
        [expertiseId, geoZone]
      );

      return {
        success: true,
        data: {
          expertiseId,
          expertiseSlug: slug,
          expertiseDisplayName: displayName,
          geoZone,
          maxWeightCapacity: maxWeight,
          effectiveMaxCapacity: effectiveMax,
          currentWeight,
          remainingCapacity: Math.max(0, effectiveMax - currentWeight),
          capacityPct: Math.round((currentWeight / effectiveMax) * 100),
          minTaskToSupplyRatio: minRatio,
          liquidityRatio,
          openRatio: openRatioVal,
          completedTasks7d: completedTasks,
          openTasks7d: openTasks,
          activeHustlers,
          isAcceptingNew: hasCapacity && ratioOk,
          blockReason,
          autoExpandPct: effectiveExpand,
          autoExpandExpiresAt: isExpansionActive ? autoExpandExpiresAt : null,
          waitlistLength: parseInt(waitlistResult.rows[0].count, 10),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'CAPACITY_CHECK_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // ==========================================================================
  // USER EXPERTISE MANAGEMENT
  // ==========================================================================

  /**
   * Get a user's current expertise selections.
   */
  getUserExpertise: async (userId: string): Promise<ServiceResult<UserExpertise[]>> => {
    try {
      const result = await db.query<{
        id: string;
        expertise_id: string;
        slug: string;
        display_name: string;
        geo_zone: string;
        slot_weight: string;
        is_primary: boolean;
        effective_weight: string;
        status: string;
        locked_until: string | null;
        last_task_accepted_at: string | null;
        tasks_accepted_14d: string;
        tasks_completed_14d: string;
        created_at: string;
      }>(
        `SELECT ue.*, er.slug, er.display_name
         FROM user_expertise ue
         JOIN expertise_registry er ON er.id = ue.expertise_id
         WHERE ue.user_id = $1
         ORDER BY ue.is_primary DESC, ue.created_at ASC`,
        [userId]
      );

      return {
        success: true,
        data: result.rows.map(r => ({
          id: r.id,
          expertiseId: r.expertise_id,
          expertiseSlug: r.slug,
          expertiseDisplayName: r.display_name,
          geoZone: r.geo_zone,
          slotWeight: parseFloat(r.slot_weight),
          isPrimary: r.is_primary,
          effectiveWeight: parseFloat(r.effective_weight),
          status: r.status,
          lockedUntil: r.locked_until,
          lastTaskAcceptedAt: r.last_task_accepted_at,
          tasksAccepted14d: parseInt(r.tasks_accepted_14d, 10),
          tasksCompleted14d: parseInt(r.tasks_completed_14d, 10),
          createdAt: r.created_at,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GET_USER_EXPERTISE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Add an expertise to a user's profile.
   *
   * TRANSACTIONALLY SAFE:
   *   1. Check 30-day lock
   *   2. Check max 2 expertise limit
   *   3. Check capacity gates (hard cap + ratio)
   *   4. Insert user_expertise
   *   5. Update capacity.current_weight
   *   6. Log change
   *
   * If gates fail → auto-enqueue to waitlist.
   */
  addUserExpertise: async (
    userId: string,
    expertiseId: string,
    isPrimary: boolean = true,
    geoZone: string = 'seattle_metro'
  ): Promise<ServiceResult<{ added: boolean; waitlisted: boolean; detail: string }>> => {
    try {
      const result = await db.serializableTransaction(async (query) => {
        // 1. Check 30-day lock on any existing expertise
        const lockCheck = await query<{ locked_until: string }>(
          `SELECT locked_until FROM user_expertise
           WHERE user_id = $1 AND status = 'active'
             AND locked_until IS NOT NULL AND locked_until > NOW()
           LIMIT 1`,
          [userId]
        );
        if (lockCheck.rows.length > 0) {
          const lockedUntil = new Date(lockCheck.rows[0].locked_until).toLocaleDateString();
          return {
            success: true as const,
            data: {
              added: false,
              waitlisted: false,
              detail: `Your expertise selections are locked until ${lockedUntil}. Changes can be made after this date.`,
            },
          };
        }

        // 2. Check existing expertise count
        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM user_expertise
           WHERE user_id = $1 AND status = 'active'`,
          [userId]
        );
        const currentCount = parseInt(countResult.rows[0].count, 10);
        if (currentCount >= MAX_EXPERTISE_PER_USER) {
          return {
            success: true as const,
            data: {
              added: false,
              waitlisted: false,
              detail: `Maximum ${MAX_EXPERTISE_PER_USER} expertise categories allowed. Remove one before adding another.`,
            },
          };
        }

        // 3. Check for duplicate (active entry)
        const dupCheck = await query<{ id: string; status: string }>(
          `SELECT id, status FROM user_expertise
           WHERE user_id = $1 AND expertise_id = $2`,
          [userId, expertiseId]
        );
        if (dupCheck.rows.length > 0 && dupCheck.rows[0].status === 'active') {
          return {
            success: true as const,
            data: {
              added: false,
              waitlisted: false,
              detail: 'You already have this expertise selected.',
            },
          };
        }

        // 3b. Decay re-entry cooldown — prevent oscillation
        // If a hustler was removed (decayed or self-removed) recently,
        // enforce a cooldown before they can re-join the same expertise.
        if (dupCheck.rows.length > 0 && dupCheck.rows[0].status === 'inactive') {
          const cooldownCheck = await query<{ updated_at: string }>(
            `SELECT updated_at FROM user_expertise
             WHERE id = $1 AND status = 'inactive'`,
            [dupCheck.rows[0].id]
          );
          if (cooldownCheck.rows.length > 0) {
            const removedAt = new Date(cooldownCheck.rows[0].updated_at);
            const cooldownEnd = new Date(removedAt);
            cooldownEnd.setDate(cooldownEnd.getDate() + DECAY_COOLDOWN_DAYS);
            if (new Date() < cooldownEnd) {
              return {
                success: true as const,
                data: {
                  added: false,
                  waitlisted: false,
                  detail: `Re-entry cooldown active. You can re-select this expertise after ${cooldownEnd.toLocaleDateString()}.`,
                },
              };
            }
          }
          // Cooldown passed — delete the inactive record so we can re-insert fresh
          await query(
            `DELETE FROM user_expertise WHERE id = $1`,
            [dupCheck.rows[0].id]
          );
        }

        // 4. Determine weight
        const weight = isPrimary ? PRIMARY_WEIGHT : SECONDARY_WEIGHT;

        // 5. Check capacity gates
        const capResult = await query<{
          max_weight_capacity: string;
          current_weight: string;
          min_task_to_supply_ratio: string;
          liquidity_ratio: string;
          active_hustlers: string;
          auto_expand_pct: string;
          auto_expand_expires_at: string | null;
        }>(
          `SELECT max_weight_capacity, current_weight, min_task_to_supply_ratio,
                  liquidity_ratio, active_hustlers, auto_expand_pct, auto_expand_expires_at
           FROM expertise_capacity
           WHERE expertise_id = $1 AND geo_zone = $2
           FOR UPDATE`, // Lock the row for concurrent safety
          [expertiseId, geoZone]
        );

        if (capResult.rows.length === 0) {
          return {
            success: false as const,
            error: {
              code: 'NO_CAPACITY_RECORD',
              message: 'This expertise is not available in your zone.',
            },
          };
        }

        const cap = capResult.rows[0];
        const maxWeight = parseFloat(cap.max_weight_capacity);
        const autoExpandPct = parseInt(cap.auto_expand_pct, 10);
        const isExpansionActive = cap.auto_expand_expires_at
          ? new Date(cap.auto_expand_expires_at) > new Date()
          : false;
        const effectiveMax = maxWeight * (1 + (isExpansionActive ? autoExpandPct : 0) / 100);
        const currentWeight = parseFloat(cap.current_weight);
        const activeHustlers = parseInt(cap.active_hustlers, 10);
        const liquidityRatio = parseFloat(cap.liquidity_ratio);
        const minRatio = parseFloat(cap.min_task_to_supply_ratio);

        // Gate 1: Hard cap
        const hasCapacity = (currentWeight + weight) <= effectiveMax;

        // Gate 2: Ratio (skip for first entrants)
        const ratioOk = activeHustlers === 0 || liquidityRatio >= minRatio;

        if (!hasCapacity || !ratioOk) {
          // AUTO-ENQUEUE TO WAITLIST
          await query(
            `INSERT INTO expertise_waitlist (user_id, expertise_id, geo_zone, requested_weight, position, status)
             VALUES ($1, $2, $3, $4,
               COALESCE((SELECT MAX(position) + 1 FROM expertise_waitlist
                         WHERE expertise_id = $2 AND geo_zone = $3), 1),
               'waiting')
             ON CONFLICT (user_id, expertise_id, geo_zone) DO NOTHING`,
            [userId, expertiseId, geoZone, weight]
          );

          const reason = !hasCapacity
            ? 'This expertise has reached capacity.'
            : 'Not enough task demand in this category right now.';

          return {
            success: true as const,
            data: {
              added: false,
              waitlisted: true,
              detail: `${reason} You've been added to the waitlist and will be invited when a slot opens.`,
            },
          };
        }

        // 6. ALL GATES PASSED — Insert user_expertise
        const lockUntil = new Date();
        lockUntil.setDate(lockUntil.getDate() + SKILL_CHANGE_LOCK_DAYS);

        await query(
          `INSERT INTO user_expertise
             (user_id, expertise_id, geo_zone, slot_weight, is_primary, effective_weight, locked_until, status)
           VALUES ($1, $2, $3, $4, $5, $4, $6, 'active')`,
          [userId, expertiseId, geoZone, weight, isPrimary, lockUntil.toISOString()]
        );

        // 7. Update capacity
        await query(
          `UPDATE expertise_capacity
           SET current_weight = current_weight + $3,
               active_hustlers = active_hustlers + 1
           WHERE expertise_id = $1 AND geo_zone = $2`,
          [expertiseId, geoZone, weight]
        );

        // 8. Log change
        await query(
          `INSERT INTO expertise_change_log (user_id, action, expertise_id, old_weight, new_weight, reason)
           VALUES ($1, 'added', $2, 0, $3, 'User selected expertise')`,
          [userId, expertiseId, weight]
        );

        return {
          success: true as const,
          data: {
            added: true,
            waitlisted: false,
            detail: `${isPrimary ? 'Primary' : 'Secondary'} expertise added (weight: ${weight}). Locked for ${SKILL_CHANGE_LOCK_DAYS} days.`,
          },
        };
      });

      // POST-TRANSACTION: Log gate event (non-blocking)
      if (result.success) {
        const d = result.data;
        if (d.added) {
          ExpertiseSupplyService._logGateEvent(userId, expertiseId, geoZone, 'admitted', { isPrimary });
        } else if (d.waitlisted) {
          ExpertiseSupplyService._logGateEvent(userId, expertiseId, geoZone, 'waitlisted_capacity', { detail: d.detail });
        } else {
          // Determine rejection type from detail string
          const event = d.detail.includes('locked') ? 'rejected_locked' as const
            : d.detail.includes('Maximum') ? 'rejected_max_expertise' as const
            : d.detail.includes('already') ? 'rejected_duplicate' as const
            : d.detail.includes('cooldown') ? 'rejected_cooldown' as const
            : 'rejected_locked' as const;
          ExpertiseSupplyService._logGateEvent(userId, expertiseId, geoZone, event, { detail: d.detail });
        }
      }

      return result;
    } catch (error) {
      // Handle trigger violation HX901 (max 2 expertise)
      if (error instanceof Error && error.message.includes('HX901')) {
        ExpertiseSupplyService._logGateEvent(userId, expertiseId, geoZone, 'rejected_max_expertise', { trigger: 'HX901' });
        return {
          success: true,
          data: {
            added: false,
            waitlisted: false,
            detail: `Maximum ${MAX_EXPERTISE_PER_USER} expertise categories allowed.`,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'ADD_EXPERTISE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Remove an expertise from a user's profile.
   * Enforces 30-day lock. Frees capacity and processes waitlist.
   */
  removeUserExpertise: async (
    userId: string,
    expertiseId: string,
    geoZone: string = 'seattle_metro'
  ): Promise<ServiceResult<{ removed: boolean; detail: string }>> => {
    try {
      return await db.serializableTransaction(async (query) => {
        // Check lock
        const existing = await query<{
          id: string;
          slot_weight: string;
          effective_weight: string;
          locked_until: string | null;
          status: string;
        }>(
          `SELECT id, slot_weight, effective_weight, locked_until, status
           FROM user_expertise
           WHERE user_id = $1 AND expertise_id = $2 AND status = 'active'
           FOR UPDATE`,
          [userId, expertiseId]
        );

        if (existing.rows.length === 0) {
          return {
            success: true as const,
            data: { removed: false, detail: 'Expertise not found on your profile.' },
          };
        }

        const entry = existing.rows[0];

        // Check 30-day lock
        if (entry.locked_until && new Date(entry.locked_until) > new Date()) {
          const lockedUntil = new Date(entry.locked_until).toLocaleDateString();
          return {
            success: true as const,
            data: {
              removed: false,
              detail: `This expertise is locked until ${lockedUntil}. Changes cannot be made yet.`,
            },
          };
        }

        const weight = parseFloat(entry.slot_weight);
        const effectiveWeight = parseFloat(entry.effective_weight);

        // Remove (soft delete — set inactive)
        await query(
          `UPDATE user_expertise SET status = 'inactive', updated_at = NOW()
           WHERE id = $1`,
          [entry.id]
        );

        // Decrement capacity
        await query(
          `UPDATE expertise_capacity
           SET current_weight = GREATEST(0, current_weight - $3),
               active_hustlers = GREATEST(0, active_hustlers - 1)
           WHERE expertise_id = $1 AND geo_zone = $2`,
          [expertiseId, geoZone, effectiveWeight]
        );

        // Log change
        await query(
          `INSERT INTO expertise_change_log (user_id, action, expertise_id, old_weight, new_weight, reason)
           VALUES ($1, 'removed', $2, $3, 0, 'User removed expertise')`,
          [userId, expertiseId, weight]
        );

        return {
          success: true as const,
          data: {
            removed: true,
            detail: 'Expertise removed. A waitlisted user may be invited to fill this slot.',
          },
        };
      });
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'REMOVE_EXPERTISE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Promote secondary expertise to primary (swap weights).
   * Both expertise entries must exist and be active.
   */
  promoteExpertise: async (
    userId: string,
    expertiseIdToPromote: string
  ): Promise<ServiceResult<{ promoted: boolean; detail: string }>> => {
    try {
      return await db.serializableTransaction(async (query) => {
        // Get both user expertise entries
        const entries = await query<{
          id: string;
          expertise_id: string;
          slot_weight: string;
          is_primary: boolean;
          locked_until: string | null;
        }>(
          `SELECT id, expertise_id, slot_weight, is_primary, locked_until
           FROM user_expertise
           WHERE user_id = $1 AND status = 'active'
           ORDER BY is_primary DESC
           FOR UPDATE`,
          [userId]
        );

        if (entries.rows.length < 2) {
          return {
            success: true as const,
            data: { promoted: false, detail: 'You need two expertise selections to swap priorities.' },
          };
        }

        // Check locks on both
        for (const e of entries.rows) {
          if (e.locked_until && new Date(e.locked_until) > new Date()) {
            return {
              success: true as const,
              data: {
                promoted: false,
                detail: `Expertise changes are locked until ${new Date(e.locked_until).toLocaleDateString()}.`,
              },
            };
          }
        }

        const toPromote = entries.rows.find(e => e.expertise_id === expertiseIdToPromote);
        if (!toPromote) {
          return {
            success: true as const,
            data: { promoted: false, detail: 'Expertise not found in your selections.' },
          };
        }

        if (toPromote.is_primary) {
          return {
            success: true as const,
            data: { promoted: false, detail: 'This is already your primary expertise.' },
          };
        }

        const currentPrimary = entries.rows.find(e => e.is_primary);
        if (!currentPrimary) {
          return {
            success: true as const,
            data: { promoted: false, detail: 'No current primary expertise found.' },
          };
        }

        const newLock = new Date();
        newLock.setDate(newLock.getDate() + SKILL_CHANGE_LOCK_DAYS);

        // Swap: promote secondary → primary (0.3 → 0.7)
        await query(
          `UPDATE user_expertise
           SET is_primary = TRUE, slot_weight = $2, effective_weight = $2,
               locked_until = $3, updated_at = NOW()
           WHERE id = $1`,
          [toPromote.id, PRIMARY_WEIGHT, newLock.toISOString()]
        );

        // Swap: demote primary → secondary (0.7 → 0.3)
        await query(
          `UPDATE user_expertise
           SET is_primary = FALSE, slot_weight = $2, effective_weight = $2,
               locked_until = $3, updated_at = NOW()
           WHERE id = $1`,
          [currentPrimary.id, SECONDARY_WEIGHT, newLock.toISOString()]
        );

        // Update capacity weights (net change: one goes +0.4, other goes -0.4)
        const weightDelta = PRIMARY_WEIGHT - SECONDARY_WEIGHT; // 0.4

        // Promoted expertise gains weight
        await query(
          `UPDATE expertise_capacity
           SET current_weight = current_weight + $3
           WHERE expertise_id = $1 AND geo_zone = (
             SELECT geo_zone FROM user_expertise WHERE id = $4
           )`,
          [expertiseIdToPromote, null, weightDelta, toPromote.id]
        );

        // Demoted expertise loses weight
        await query(
          `UPDATE expertise_capacity
           SET current_weight = GREATEST(0, current_weight - $3)
           WHERE expertise_id = $1 AND geo_zone = (
             SELECT geo_zone FROM user_expertise WHERE id = $4
           )`,
          [currentPrimary.expertise_id, null, weightDelta, currentPrimary.id]
        );

        // Log both changes
        await query(
          `INSERT INTO expertise_change_log (user_id, action, expertise_id, old_weight, new_weight, reason)
           VALUES ($1, 'promoted', $2, $3, $4, 'User swapped primary/secondary')`,
          [userId, expertiseIdToPromote, SECONDARY_WEIGHT, PRIMARY_WEIGHT]
        );
        await query(
          `INSERT INTO expertise_change_log (user_id, action, expertise_id, old_weight, new_weight, reason)
           VALUES ($1, 'demoted', $2, $3, $4, 'User swapped primary/secondary')`,
          [userId, currentPrimary.expertise_id, PRIMARY_WEIGHT, SECONDARY_WEIGHT]
        );

        return {
          success: true as const,
          data: {
            promoted: true,
            detail: `Expertise swapped. Locked for ${SKILL_CHANGE_LOCK_DAYS} days.`,
          },
        };
      });
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PROMOTE_EXPERTISE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // ==========================================================================
  // WAITLIST
  // ==========================================================================

  /**
   * Get a user's waitlist entries.
   */
  getUserWaitlist: async (userId: string): Promise<ServiceResult<WaitlistEntry[]>> => {
    try {
      const result = await db.query<{
        id: string;
        slug: string;
        display_name: string;
        geo_zone: string;
        position: number;
        requested_weight: string;
        status: string;
        invited_at: string | null;
        invite_expires_at: string | null;
        created_at: string;
      }>(
        `SELECT ew.*, er.slug, er.display_name
         FROM expertise_waitlist ew
         JOIN expertise_registry er ON er.id = ew.expertise_id
         WHERE ew.user_id = $1
         ORDER BY ew.status ASC, ew.position ASC`,
        [userId]
      );

      return {
        success: true,
        data: result.rows.map(r => ({
          id: r.id,
          expertiseSlug: r.slug,
          expertiseDisplayName: r.display_name,
          geoZone: r.geo_zone,
          position: r.position,
          requestedWeight: parseFloat(r.requested_weight),
          status: r.status,
          invitedAt: r.invited_at,
          inviteExpiresAt: r.invite_expires_at,
          createdAt: r.created_at,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GET_WAITLIST_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Accept a waitlist invitation.
   * Invitation must be valid (not expired, status = 'invited').
   */
  acceptWaitlistInvite: async (
    userId: string,
    waitlistEntryId: string
  ): Promise<ServiceResult<{ accepted: boolean; detail: string }>> => {
    try {
      return await db.serializableTransaction(async (query) => {
        // Get and lock the waitlist entry
        const entry = await query<{
          id: string;
          expertise_id: string;
          geo_zone: string;
          requested_weight: string;
          status: string;
          invite_expires_at: string | null;
        }>(
          `SELECT id, expertise_id, geo_zone, requested_weight, status, invite_expires_at
           FROM expertise_waitlist
           WHERE id = $1 AND user_id = $2
           FOR UPDATE`,
          [waitlistEntryId, userId]
        );

        if (entry.rows.length === 0) {
          return {
            success: true as const,
            data: { accepted: false, detail: 'Waitlist entry not found.' },
          };
        }

        const e = entry.rows[0];

        if (e.status !== 'invited') {
          return {
            success: true as const,
            data: { accepted: false, detail: `Cannot accept — status is '${e.status}'.` },
          };
        }

        if (e.invite_expires_at && new Date(e.invite_expires_at) < new Date()) {
          // Expire the invitation
          await query(
            `UPDATE expertise_waitlist SET status = 'expired' WHERE id = $1`,
            [e.id]
          );
          return {
            success: true as const,
            data: { accepted: false, detail: 'Invitation has expired. You have been re-queued.' },
          };
        }

        const weight = parseFloat(e.requested_weight);
        const isPrimary = weight === PRIMARY_WEIGHT;

        // Re-check capacity (someone else may have filled the slot)
        const capResult = await query<{
          max_weight_capacity: string;
          current_weight: string;
          auto_expand_pct: string;
          auto_expand_expires_at: string | null;
        }>(
          `SELECT max_weight_capacity, current_weight, auto_expand_pct, auto_expand_expires_at
           FROM expertise_capacity
           WHERE expertise_id = $1 AND geo_zone = $2
           FOR UPDATE`,
          [e.expertise_id, e.geo_zone]
        );

        if (capResult.rows.length === 0) {
          return {
            success: false as const,
            error: { code: 'NO_CAPACITY', message: 'Capacity record not found.' },
          };
        }

        const cap = capResult.rows[0];
        const maxWeight = parseFloat(cap.max_weight_capacity);
        const currentWeight = parseFloat(cap.current_weight);
        const autoExpandPct = parseInt(cap.auto_expand_pct, 10);
        const isExpansionActive = cap.auto_expand_expires_at
          ? new Date(cap.auto_expand_expires_at) > new Date()
          : false;
        const effectiveMax = maxWeight * (1 + (isExpansionActive ? autoExpandPct : 0) / 100);

        if ((currentWeight + weight) > effectiveMax) {
          return {
            success: true as const,
            data: { accepted: false, detail: 'Capacity was filled while your invitation was pending. Remaining on waitlist.' },
          };
        }

        // All clear — add expertise
        const lockUntil = new Date();
        lockUntil.setDate(lockUntil.getDate() + SKILL_CHANGE_LOCK_DAYS);

        await query(
          `INSERT INTO user_expertise
             (user_id, expertise_id, geo_zone, slot_weight, is_primary, effective_weight, locked_until, status)
           VALUES ($1, $2, $3, $4, $5, $4, $6, 'active')
           ON CONFLICT (user_id, expertise_id) DO UPDATE SET
             status = 'active', slot_weight = $4, is_primary = $5,
             effective_weight = $4, locked_until = $6, updated_at = NOW()`,
          [userId, e.expertise_id, e.geo_zone, weight, isPrimary, lockUntil.toISOString()]
        );

        // Update capacity
        await query(
          `UPDATE expertise_capacity
           SET current_weight = current_weight + $3,
               active_hustlers = active_hustlers + 1
           WHERE expertise_id = $1 AND geo_zone = $2`,
          [e.expertise_id, e.geo_zone, weight]
        );

        // Mark waitlist entry accepted
        await query(
          `UPDATE expertise_waitlist SET status = 'accepted' WHERE id = $1`,
          [e.id]
        );

        // Log
        await query(
          `INSERT INTO expertise_change_log (user_id, action, expertise_id, old_weight, new_weight, reason)
           VALUES ($1, 'added', $2, 0, $3, 'Accepted waitlist invitation')`,
          [userId, e.expertise_id, weight]
        );

        return {
          success: true as const,
          data: {
            accepted: true,
            detail: `Welcome! Expertise added (weight: ${weight}). Locked for ${SKILL_CHANGE_LOCK_DAYS} days.`,
          },
        };
      });
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'ACCEPT_WAITLIST_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // ==========================================================================
  // DAILY RECALCULATION (Called by cron worker)
  // ==========================================================================

  /**
   * Recalculate all capacity metrics.
   * Called daily by BullMQ cron worker.
   *
   * For each expertise × zone:
   *   1. Count open tasks in last 7 days
   *   2. Count active hustlers (accepted ≥1 task in 14d, not suspended)
   *   3. Compute effective_weight with decay
   *   4. Compute liquidity_ratio
   *   5. Check P95 acceptance time for auto-expansion
   *   6. Process waitlist invitations if ratio improved
   */
  recalculateAllCapacity: async (): Promise<ServiceResult<{
    processed: number;
    expanded: number;
    invitesSent: number;
  }>> => {
    try {
      let processed = 0;
      let expanded = 0;
      let invitesSent = 0;

      // Get all capacity records
      const capacities = await db.query<{
        id: string;
        expertise_id: string;
        geo_zone: string;
        max_weight_capacity: string;
        min_task_to_supply_ratio: string;
      }>(
        `SELECT id, expertise_id, geo_zone, max_weight_capacity, min_task_to_supply_ratio
         FROM expertise_capacity`
      );

      for (const cap of capacities.rows) {
        const expertiseId = cap.expertise_id;
        const geoZone = cap.geo_zone;

        // 1. Apply activity decay to all user_expertise entries
        // 14d+ inactive → weight * 0.5
        await db.query(
          `UPDATE user_expertise
           SET effective_weight = slot_weight * $3,
               updated_at = NOW()
           WHERE expertise_id = $1 AND geo_zone = $2 AND status = 'active'
             AND (last_task_accepted_at IS NULL OR last_task_accepted_at < NOW() - INTERVAL '${DECAY_THRESHOLD_DAYS} days')
             AND (last_task_accepted_at IS NULL OR last_task_accepted_at >= NOW() - INTERVAL '${DECAY_ZERO_THRESHOLD_DAYS} days')`,
          [expertiseId, geoZone, DECAY_MULTIPLIER]
        );

        // 30d+ inactive → weight = 0
        await db.query(
          `UPDATE user_expertise
           SET effective_weight = 0,
               updated_at = NOW()
           WHERE expertise_id = $1 AND geo_zone = $2 AND status = 'active'
             AND last_task_accepted_at IS NOT NULL
             AND last_task_accepted_at < NOW() - INTERVAL '${DECAY_ZERO_THRESHOLD_DAYS} days'`,
          [expertiseId, geoZone]
        );

        // Users who never accepted → full decay after threshold
        await db.query(
          `UPDATE user_expertise
           SET effective_weight = slot_weight * $3,
               updated_at = NOW()
           WHERE expertise_id = $1 AND geo_zone = $2 AND status = 'active'
             AND last_task_accepted_at IS NULL
             AND created_at < NOW() - INTERVAL '${DECAY_THRESHOLD_DAYS} days'`,
          [expertiseId, geoZone, DECAY_MULTIPLIER]
        );

        // 2. Count open tasks AND completed tasks in last 7 days
        //    Completed tasks = real economic throughput (primary gate metric)
        //    Open tasks = responsiveness signal (secondary)
        const taskCountsResult = await db.query<{ open_count: string; completed_count: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE state = 'OPEN' AND created_at > NOW() - INTERVAL '7 days') as open_count,
             COUNT(*) FILTER (WHERE state = 'COMPLETED' AND completed_at > NOW() - INTERVAL '7 days') as completed_count
           FROM tasks
           WHERE category = (SELECT slug FROM expertise_registry WHERE id = $1)`,
          [expertiseId]
        );
        const openTasks7d = parseInt(taskCountsResult.rows[0].open_count, 10);
        const completedTasks7d = parseInt(taskCountsResult.rows[0].completed_count, 10);

        // 3. Compute effective supply weight + active hustler count
        const supplyResult = await db.query<{ total_weight: string; active_count: string }>(
          `SELECT
             COALESCE(SUM(effective_weight), 0) as total_weight,
             COUNT(*) FILTER (WHERE effective_weight > 0) as active_count
           FROM user_expertise
           WHERE expertise_id = $1 AND geo_zone = $2 AND status = 'active'`,
          [expertiseId, geoZone]
        );
        const totalWeight = parseFloat(supplyResult.rows[0].total_weight);
        const activeCount = parseInt(supplyResult.rows[0].active_count, 10);

        // 4. Compute dual ratios
        //    Primary: completed_tasks_7d / effective_weight (real throughput)
        //    Secondary: open_tasks_7d / effective_weight (responsiveness)
        const liquidityRatio = totalWeight > 0 ? completedTasks7d / totalWeight : 0;
        const openRatio = totalWeight > 0 ? openTasks7d / totalWeight : 0;

        // 5. Update activity tracking (tasks accepted/completed in 14d)
        await db.query(
          `UPDATE user_expertise ue
           SET tasks_accepted_14d = COALESCE(ta.cnt, 0),
               last_task_accepted_at = COALESCE(ta.latest, ue.last_task_accepted_at),
               updated_at = NOW()
           FROM (
             SELECT t.worker_id as user_id, COUNT(*) as cnt, MAX(t.accepted_at) as latest
             FROM tasks t
             WHERE t.accepted_at > NOW() - INTERVAL '14 days'
               AND t.worker_id IS NOT NULL
               AND t.category = (SELECT slug FROM expertise_registry WHERE id = $1)
             GROUP BY t.worker_id
           ) ta
           WHERE ue.user_id = ta.user_id
             AND ue.expertise_id = $1 AND ue.geo_zone = $2 AND ue.status = 'active'`,
          [expertiseId, geoZone]
        );

        // 6. Check P95 acceptance time for auto-expansion
        //    SAMPLE-SIZE GUARD: Only expand when ≥ P95_MIN_SAMPLE_SIZE accepted tasks exist
        //    Prevents noise-based expansion from 3 weird late-night tasks.
        const p95Result = await db.query<{ p95_hours: string; sample_count: string }>(
          `SELECT
             COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (accepted_at - created_at)) / 3600
             ), 0) as p95_hours,
             COUNT(*) as sample_count
           FROM tasks
           WHERE state IN ('COMPLETED', 'IN_PROGRESS', 'PROOF_SUBMITTED')
             AND accepted_at IS NOT NULL
             AND category = (SELECT slug FROM expertise_registry WHERE id = $1)
             AND created_at > NOW() - INTERVAL '14 days'`,
          [expertiseId]
        );
        const p95Hours = parseFloat(p95Result.rows[0].p95_hours);
        const p95SampleCount = parseInt(p95Result.rows[0].sample_count, 10);

        let autoExpandPct = 0;
        let autoExpandExpiresAt: string | null = null;

        if (p95Hours > P95_ACCEPTANCE_THRESHOLD_HOURS && p95SampleCount >= P95_MIN_SAMPLE_SIZE) {
          // Auto-expand capacity by 10% for 7 days
          autoExpandPct = AUTO_EXPAND_PCT;
          const expires = new Date();
          expires.setDate(expires.getDate() + AUTO_EXPAND_DURATION_DAYS);
          autoExpandExpiresAt = expires.toISOString();
          expanded++;
          log.info({ expertiseId, geoZone, p95Hours: Math.round(p95Hours * 10) / 10, sampleCount: p95SampleCount, expandPct: autoExpandPct }, 'expertise_auto_expansion');
        }

        // 7. Write back computed values
        await db.query(
          `UPDATE expertise_capacity
           SET current_weight = $3,
               active_hustlers = $4,
               open_tasks_7d = $5,
               completed_tasks_7d = $6,
               liquidity_ratio = $7,
               open_ratio = $8,
               auto_expand_pct = $9,
               auto_expand_expires_at = $10,
               last_recalc_at = NOW()
           WHERE expertise_id = $1 AND geo_zone = $2`,
          [
            expertiseId,
            geoZone,
            totalWeight,
            activeCount,
            openTasks7d,
            completedTasks7d,
            liquidityRatio,
            openRatio,
            autoExpandPct,
            autoExpandExpiresAt,
          ]
        );

        processed++;

        // 8. Process waitlist invitations if capacity opened
        const maxWeight = parseFloat(cap.max_weight_capacity);
        const effectiveMax = maxWeight * (1 + autoExpandPct / 100);
        const minRatio = parseFloat(cap.min_task_to_supply_ratio);

        if (totalWeight < effectiveMax && (activeCount === 0 || liquidityRatio >= minRatio)) {
          const availableWeight = effectiveMax - totalWeight;
          const sent = await ExpertiseSupplyService._processWaitlistInvites(
            expertiseId,
            geoZone,
            availableWeight
          );
          invitesSent += sent;
        }
      }

      // 9. Expire stale waitlist invitations (>48h)
      await db.query(
        `UPDATE expertise_waitlist
         SET status = 'expired'
         WHERE status = 'invited'
           AND invite_expires_at IS NOT NULL
           AND invite_expires_at < NOW()`
      );

      return {
        success: true,
        data: { processed, expanded, invitesSent },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'RECALCULATE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Internal: Send waitlist invitations in FIFO order.
   * Sends up to as many as available weight allows.
   */
  _processWaitlistInvites: async (
    expertiseId: string,
    geoZone: string,
    availableWeight: number
  ): Promise<number> => {
    let remaining = availableWeight;
    let sent = 0;

    // Get waiting entries in FIFO order
    const waiters = await db.query<{
      id: string;
      user_id: string;
      requested_weight: string;
    }>(
      `SELECT id, user_id, requested_weight
       FROM expertise_waitlist
       WHERE expertise_id = $1 AND geo_zone = $2 AND status = 'waiting'
       ORDER BY position ASC
       LIMIT 10`, // Process max 10 per cycle
      [expertiseId, geoZone]
    );

    for (const waiter of waiters.rows) {
      const requestedWeight = parseFloat(waiter.requested_weight);
      if (requestedWeight > remaining) break; // No more room

      // Check user hasn't hit max expertise count
      const userCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM user_expertise
         WHERE user_id = $1 AND status = 'active'`,
        [waiter.user_id]
      );
      if (parseInt(userCount.rows[0].count, 10) >= MAX_EXPERTISE_PER_USER) {
        // Skip — user already at max, cancel their waitlist entry
        await db.query(
          `UPDATE expertise_waitlist SET status = 'cancelled' WHERE id = $1`,
          [waiter.id]
        );
        continue;
      }

      // Send invitation
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + WAITLIST_INVITE_EXPIRY_HOURS);

      await db.query(
        `UPDATE expertise_waitlist
         SET status = 'invited',
             invited_at = NOW(),
             invite_expires_at = $2
         WHERE id = $1`,
        [waiter.id, expiresAt.toISOString()]
      );

      remaining -= requestedWeight;
      sent++;

      // Send push notification for expertise invitation
      NotificationService.createNotification({
        userId: waiter.user_id,
        category: 'new_matching_task',
        title: '🎯 Expertise Slot Available!',
        body: `A slot has opened up for "${expertiseId}" in your area. Accept within ${WAITLIST_INVITE_EXPIRY_HOURS} hours before it expires.`,
        deepLink: `app://expertise/invite/${waiter.id}`,
        channels: ['in_app', 'push'],
        priority: 'HIGH',
        metadata: {
          waitlistId: waiter.id,
          expertiseId,
          geoZone,
          expiresAt: expiresAt.toISOString(),
        },
      }).catch(err => log.error({ err: err instanceof Error ? err.message : String(err), userId: waiter.user_id, expertiseId, geoZone }, 'Failed to notify user of waitlist invite'));
    }

    return sent;
  },

  // ==========================================================================
  // REJECTION / GATE EVENT LOGGING
  // ==========================================================================

  /**
   * Log every capacity gate event (rejection, waitlist, admission).
   * Non-fatal — failure to log must never block user flow.
   * Used for support diagnostics and supply analytics.
   */
  _logGateEvent: async (
    userId: string,
    expertiseId: string,
    geoZone: string,
    event: 'rejected_locked' | 'rejected_max_expertise' | 'rejected_duplicate' | 'waitlisted_capacity' | 'waitlisted_ratio' | 'admitted' | 'rejected_cooldown',
    details: Record<string, unknown> = {}
  ): Promise<void> => {
    try {
      await db.query(
        `INSERT INTO expertise_change_log (user_id, action, expertise_id, old_weight, new_weight, reason)
         VALUES ($1, $2, $3, 0, 0, $4)`,
        [
          userId,
          `gate_${event}`,
          expertiseId,
          JSON.stringify({ geoZone, event, timestamp: new Date().toISOString(), ...details }),
        ]
      );
    } catch {
      // Non-fatal — log to console but never throw
      log.warn({ userId, expertiseId, geoZone, event }, 'Failed to log gate event');
    }
  },

  // ==========================================================================
  // ADMIN: Supply Dashboard
  // ==========================================================================

  /**
   * Get full supply dashboard for admin oversight.
   */
  getSupplyDashboard: async (
    geoZone: string = 'seattle_metro'
  ): Promise<ServiceResult<SupplyDashboard>> => {
    try {
      const result = await db.query<{
        expertise_id: string;
        slug: string;
        display_name: string;
        geo_zone: string;
        max_weight_capacity: string;
        current_weight: string;
        active_hustlers: string;
        open_tasks_7d: string;
        liquidity_ratio: string;
        min_task_to_supply_ratio: string;
        auto_expand_pct: string;
        auto_expand_expires_at: string | null;
        last_recalc_at: string | null;
        waitlist_count: string;
      }>(
        `SELECT
           ec.expertise_id, er.slug, er.display_name, ec.geo_zone,
           ec.max_weight_capacity, ec.current_weight, ec.active_hustlers,
           ec.open_tasks_7d, ec.completed_tasks_7d, ec.liquidity_ratio, ec.open_ratio, ec.min_task_to_supply_ratio,
           ec.auto_expand_pct, ec.auto_expand_expires_at, ec.last_recalc_at,
           COALESCE(wl.cnt, 0) as waitlist_count
         FROM expertise_capacity ec
         JOIN expertise_registry er ON er.id = ec.expertise_id
         LEFT JOIN (
           SELECT expertise_id, geo_zone, COUNT(*) as cnt
           FROM expertise_waitlist
           WHERE status = 'waiting'
           GROUP BY expertise_id, geo_zone
         ) wl ON wl.expertise_id = ec.expertise_id AND wl.geo_zone = ec.geo_zone
         WHERE ec.geo_zone = $1
         ORDER BY er.sort_order ASC`,
        [geoZone]
      );

      const expertise: CapacityStatus[] = result.rows.map(r => {
        const maxWeight = parseFloat(r.max_weight_capacity);
        const autoExpandPct = parseInt(r.auto_expand_pct, 10);
        const isExpansionActive = r.auto_expand_expires_at
          ? new Date(r.auto_expand_expires_at) > new Date()
          : false;
        const effectiveExpand = isExpansionActive ? autoExpandPct : 0;
        const effectiveMax = maxWeight * (1 + effectiveExpand / 100);
        const currentWeight = parseFloat(r.current_weight);
        const liquidityRatio = parseFloat(r.liquidity_ratio);
        const openRatioVal = parseFloat(r.liquidity_ratio || '0');
        const minRatio = parseFloat(r.min_task_to_supply_ratio);
        const activeHustlers = parseInt(r.active_hustlers, 10);

        const hasCapacity = currentWeight < effectiveMax;
        const ratioOk = activeHustlers === 0 || liquidityRatio >= minRatio;

        let blockReason: string | null = null;
        if (!hasCapacity) blockReason = 'At capacity';
        else if (!ratioOk) blockReason = 'Low task throughput';

        return {
          expertiseId: r.expertise_id,
          expertiseSlug: r.slug,
          expertiseDisplayName: r.display_name,
          geoZone: r.geo_zone,
          maxWeightCapacity: maxWeight,
          effectiveMaxCapacity: effectiveMax,
          currentWeight,
          remainingCapacity: Math.max(0, effectiveMax - currentWeight),
          capacityPct: effectiveMax > 0 ? Math.round((currentWeight / effectiveMax) * 100) : 0,
          minTaskToSupplyRatio: minRatio,
          liquidityRatio,
          openRatio: openRatioVal,
          completedTasks7d: parseInt(r.open_tasks_7d || '0', 10),
          openTasks7d: parseInt(r.open_tasks_7d, 10),
          activeHustlers,
          isAcceptingNew: hasCapacity && ratioOk,
          blockReason,
          autoExpandPct: effectiveExpand,
          autoExpandExpiresAt: isExpansionActive ? r.auto_expand_expires_at : null,
          waitlistLength: parseInt(r.waitlist_count, 10),
        };
      });

      // Totals
      const totalActiveHustlers = expertise.reduce((sum, e) => sum + e.activeHustlers, 0);
      const totalEffectiveWeight = expertise.reduce((sum, e) => sum + e.currentWeight, 0);
      const totalOpenTasks7d = expertise.reduce((sum, e) => sum + e.openTasks7d, 0);
      const totalWaitlisted = expertise.reduce((sum, e) => sum + e.waitlistLength, 0);

      return {
        success: true,
        data: {
          expertise,
          totals: {
            totalActiveHustlers,
            totalEffectiveWeight,
            totalOpenTasks7d,
            overallLiquidityRatio: totalEffectiveWeight > 0
              ? Math.round((totalOpenTasks7d / totalEffectiveWeight) * 100) / 100
              : 0,
            totalWaitlisted,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SUPPLY_DASHBOARD_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Admin: Override capacity for an expertise.
   * Used for manual tuning during beta.
   */
  adminUpdateCapacity: async (
    expertiseId: string,
    geoZone: string,
    updates: {
      maxWeightCapacity?: number;
      minTaskToSupplyRatio?: number;
    },
    adminUserId: string
  ): Promise<ServiceResult<{ updated: boolean }>> => {
    try {
      const setClauses: string[] = [];
      const params: unknown[] = [expertiseId, geoZone];
      let paramIndex = 3;

      if (updates.maxWeightCapacity !== undefined) {
        setClauses.push(`max_weight_capacity = $${paramIndex++}`);
        params.push(updates.maxWeightCapacity);
      }
      if (updates.minTaskToSupplyRatio !== undefined) {
        setClauses.push(`min_task_to_supply_ratio = $${paramIndex++}`);
        params.push(updates.minTaskToSupplyRatio);
      }

      if (setClauses.length === 0) {
        return { success: true, data: { updated: false } };
      }

      await db.query(
        `UPDATE expertise_capacity
         SET ${setClauses.join(', ')}
         WHERE expertise_id = $1 AND geo_zone = $2`,
        params
      );

      // Audit log
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, result)
         VALUES ($1, 'admin', 'EXPERTISE_CAPACITY_UPDATE', $2, 'applied')`,
        [
          adminUserId,
          JSON.stringify({
            expertiseId,
            geoZone,
            updates,
            timestamp: new Date().toISOString(),
          }),
        ]
      );

      return { success: true, data: { updated: true } };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'ADMIN_UPDATE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

export default ExpertiseSupplyService;
