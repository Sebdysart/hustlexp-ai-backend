/**
 * DynamicPricingService v1.0.0
 *
 * CONSTITUTIONAL: Dynamic pricing engine (Gap 4 fix)
 *
 * Handles surge pricing based on demand/supply, ASAP urgency premiums,
 * and worker price modifiers for IC compliance (Gap 7).
 *
 * Worker Price Modifier: Workers can adjust suggested rates ±25-50%.
 * This is CRITICAL for Independent Contractor classification — it proves
 * "Opportunity for Profit/Loss" which is the #1 legal indicator.
 *
 * @see PRODUCT_SPEC §3.5 (Live Mode pricing)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface PricingResult {
  base_price_cents: number;
  surge_multiplier: number;
  surge_reason: string | null;
  urgency_premium_cents: number;
  worker_modifier_cents: number;
  final_price_cents: number;
  breakdown: PriceBreakdown;
}

interface PriceBreakdown {
  base: number;
  surge: number;
  urgency: number;
  worker_modifier: number;
  total: number;
}

interface SurgeFactors {
  demand_score: number; // 0-1 (ratio of open tasks to available workers in area)
  time_of_day_multiplier: number;
  day_of_week_multiplier: number;
  weather_multiplier: number; // future: integrate weather API
  category_demand: number; // category-specific demand
}

interface WorkerPriceModifier {
  user_id: string;
  modifier_percent: number; // -25 to +50
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SURGE_MULTIPLIER = 3.0;
const MIN_SURGE_MULTIPLIER = 1.0;
const ASAP_URGENCY_PREMIUM_PERCENT = 30; // 30% premium for ASAP
const ASAP_NO_ACCEPT_BUMP_CENTS = 300; // $3 bump if no one accepts in 60s
const ASAP_MAX_BUMPS = 3; // max 3 price bumps

// Time-of-day multipliers (UTC offsets should be converted to local)
const TIME_MULTIPLIERS: Record<string, number> = {
  early_morning: 1.1,  // 5-7 AM
  morning: 1.0,        // 7-10 AM
  midday: 0.95,        // 10 AM-2 PM (low demand)
  afternoon: 1.0,      // 2-5 PM
  evening: 1.15,       // 5-8 PM (peak)
  night: 1.25,         // 8-11 PM
  late_night: 1.3,     // 11 PM-5 AM
};

// Day-of-week multipliers
const DAY_MULTIPLIERS: Record<number, number> = {
  0: 1.15, // Sunday
  1: 0.95, // Monday
  2: 0.95, // Tuesday
  3: 1.0,  // Wednesday
  4: 1.0,  // Thursday
  5: 1.1,  // Friday
  6: 1.2,  // Saturday
};

// ============================================================================
// SERVICE
// ============================================================================

export const DynamicPricingService = {
  /**
   * Calculate dynamic price for a task
   */
  calculatePrice: async (params: {
    basePriceCents: number;
    mode: 'STANDARD' | 'LIVE';
    category?: string;
    locationLat?: number;
    locationLng?: number;
    isASAP?: boolean;
    workerId?: string; // if worker modifier should be applied
  }): Promise<ServiceResult<PricingResult>> => {
    try {
      const {
        basePriceCents,
        mode,
        category,
        locationLat,
        locationLng,
        isASAP = false,
        workerId,
      } = params;

      // 1. Calculate surge multiplier
      let surgeMultiplier = MIN_SURGE_MULTIPLIER;
      let surgeReason: string | null = null;

      // Demand/supply ratio in area (5 mile radius)
      if (locationLat && locationLng) {
        const demandResult = await db.query<{ open_tasks: number; active_workers: number }>(
          `SELECT
            (SELECT COUNT(*) FROM tasks
             WHERE state = 'OPEN'
             AND location_lat IS NOT NULL
             AND ST_DWithin(
               ST_MakePoint(location_lng, location_lat)::geography,
               ST_MakePoint($1, $2)::geography,
               8047  -- 5 miles in meters
             )) AS open_tasks,
            (SELECT COUNT(*) FROM users
             WHERE default_mode = 'worker'
             AND last_active_at > NOW() - INTERVAL '30 minutes'
             AND location_lat IS NOT NULL
             AND ST_DWithin(
               ST_MakePoint(location_lng, location_lat)::geography,
               ST_MakePoint($1, $2)::geography,
               8047
             )) AS active_workers`,
          [locationLng, locationLat]
        );

        if (demandResult.rows[0]) {
          const { open_tasks, active_workers } = demandResult.rows[0];
          if (active_workers > 0) {
            const demandRatio = open_tasks / active_workers;
            if (demandRatio > 3) {
              surgeMultiplier = Math.min(1.5, MAX_SURGE_MULTIPLIER);
              surgeReason = 'High demand in your area';
            } else if (demandRatio > 5) {
              surgeMultiplier = Math.min(2.0, MAX_SURGE_MULTIPLIER);
              surgeReason = 'Very high demand in your area';
            }
          }
        }
      }

      // Time-of-day adjustment
      const hour = new Date().getHours();
      let timeKey = 'midday';
      if (hour >= 5 && hour < 7) timeKey = 'early_morning';
      else if (hour >= 7 && hour < 10) timeKey = 'morning';
      else if (hour >= 10 && hour < 14) timeKey = 'midday';
      else if (hour >= 14 && hour < 17) timeKey = 'afternoon';
      else if (hour >= 17 && hour < 20) timeKey = 'evening';
      else if (hour >= 20 && hour < 23) timeKey = 'night';
      else timeKey = 'late_night';

      const timeMult = TIME_MULTIPLIERS[timeKey] || 1.0;
      const dayMult = DAY_MULTIPLIERS[new Date().getDay()] || 1.0;

      surgeMultiplier = Math.min(
        surgeMultiplier * timeMult * dayMult,
        MAX_SURGE_MULTIPLIER
      );

      // Round to 2 decimal places
      surgeMultiplier = Math.round(surgeMultiplier * 100) / 100;

      // 2. ASAP urgency premium (Gap 15 fix)
      let urgencyPremiumCents = 0;
      if (isASAP || mode === 'LIVE') {
        urgencyPremiumCents = Math.round(basePriceCents * (ASAP_URGENCY_PREMIUM_PERCENT / 100));
      }

      // 3. Worker price modifier (Gap 7 - IC Compliance)
      let workerModifierCents = 0;
      if (workerId) {
        const workerResult = await db.query<{ price_modifier_percent: number }>(
          `SELECT price_modifier_percent FROM users WHERE id = $1`,
          [workerId]
        );
        if (workerResult.rows[0]) {
          const modifierPercent = workerResult.rows[0].price_modifier_percent;
          workerModifierCents = Math.round(basePriceCents * (modifierPercent / 100));
        }
      }

      // 4. Calculate final price
      const surgedPrice = Math.round(basePriceCents * surgeMultiplier);
      const finalPrice = surgedPrice + urgencyPremiumCents + workerModifierCents;

      return {
        success: true,
        data: {
          base_price_cents: basePriceCents,
          surge_multiplier: surgeMultiplier,
          surge_reason: surgeReason,
          urgency_premium_cents: urgencyPremiumCents,
          worker_modifier_cents: workerModifierCents,
          final_price_cents: Math.max(finalPrice, 500), // min $5
          breakdown: {
            base: basePriceCents,
            surge: surgedPrice - basePriceCents,
            urgency: urgencyPremiumCents,
            worker_modifier: workerModifierCents,
            total: finalPrice,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'PRICING_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Update worker's price modifier (IC Compliance - Gap 7)
   * Workers control their own rates = Independent Contractor proof
   */
  updateWorkerModifier: async (
    userId: string,
    modifierPercent: number
  ): Promise<ServiceResult<void>> => {
    if (modifierPercent < -25 || modifierPercent > 50) {
      return {
        success: false,
        error: {
          code: 'INVALID_MODIFIER',
          message: 'Price modifier must be between -25% and +50%',
        },
      };
    }

    try {
      await db.query(
        `UPDATE users SET price_modifier_percent = $1 WHERE id = $2`,
        [modifierPercent, userId]
      );
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Auto-bump ASAP task price when no one accepts (Gap 15)
   * Called by cron after 60-second timeout
   */
  bumpASAPPrice: async (taskId: string): Promise<ServiceResult<{ new_price_cents: number; bump_count: number }>> => {
    try {
      // Get current task
      const taskResult = await db.query<{ price: number; surge_multiplier: number; asap_bump_count: number }>(
        `SELECT price, surge_multiplier, COALESCE(asap_bump_count, 0) AS asap_bump_count
         FROM tasks WHERE id = $1 AND state = 'OPEN' AND mode = 'LIVE'`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'ASAP task not found or not open' } };
      }

      const task = taskResult.rows[0];

      if (task.asap_bump_count >= ASAP_MAX_BUMPS) {
        return {
          success: false,
          error: { code: 'MAX_BUMPS_REACHED', message: 'Maximum price bumps reached' },
        };
      }

      const newPrice = task.price + ASAP_NO_ACCEPT_BUMP_CENTS;
      const newBumpCount = task.asap_bump_count + 1;

      await db.query(
        `UPDATE tasks
         SET price = $1, asap_bump_count = $2
         WHERE id = $3`,
        [newPrice, newBumpCount, taskId]
      );

      return {
        success: true,
        data: { new_price_cents: newPrice, bump_count: newBumpCount },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

export default DynamicPricingService;
