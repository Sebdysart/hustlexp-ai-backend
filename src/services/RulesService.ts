/**
 * Rules Service - Phase E
 * 
 * Config-driven marketplace rules per city:
 * - Pricing (base fees, platform take rate)
 * - Golden hours
 * - Boost tiers
 * - Search radius
 */

import { serviceLogger } from '../utils/logger.js';

// ============================================
// Types
// ============================================

export interface RuleValue {
    value: unknown;
    description?: string;
}

export interface GoldenHoursConfig {
    enabled: boolean;
    startLocal: string;  // '17:00'
    endLocal: string;    // '20:00'
    boostMultiplier: number;
}

export interface BoostTierConfig {
    tiers: {
        name: string;
        feeMultiplier: number;
        priorityScore: number;
    }[];
}

// ============================================
// Default Rules (Seattle baseline)
// ============================================

const DEFAULT_RULES: Record<string, unknown> = {
    // Pricing
    base_fee_percent: 15,
    max_platform_take_rate_percent: 20,
    min_task_price_usd: 15,
    instant_payout_fee_percent: 1.5,

    // Golden hours
    golden_hour_enabled: true,
    golden_hour_start_local: '17:00',
    golden_hour_end_local: '20:00',
    golden_hour_boost_multiplier: 1.3,

    // Search & matching
    default_search_radius_km: 8,
    max_search_radius_km: 25,
    matching_score_threshold: 0.6,

    // Boost tiers
    boost_tiers_config: {
        tiers: [
            { name: 'standard', feeMultiplier: 1.0, priorityScore: 1 },
            { name: 'priority', feeMultiplier: 1.25, priorityScore: 2 },
            { name: 'urgent', feeMultiplier: 1.5, priorityScore: 3 },
        ],
    },

    // Task limits
    max_active_tasks_per_hustler: 3,
    max_pending_tasks_per_poster: 10,
    task_expiry_hours: 48,

    // Streaks
    streak_bonus_multiplier_per_day: 0.05,
    max_streak_bonus: 0.25,

    // XP
    xp_per_task_base: 100,
    xp_per_dollar_earned: 10,
    xp_for_5_star_review: 50,

    // Safety
    max_proof_attempts_per_task: 3,
    dispute_auto_resolve_days: 7,
};

// ============================================
// In-memory store (syncs to DB)
// ============================================

// cityId -> { key -> value }
const rulesStore = new Map<string, Map<string, unknown>>();

// Initialize with default rules for 'global' and 'seattle'
rulesStore.set('global', new Map(Object.entries(DEFAULT_RULES)));
rulesStore.set('city_seattle', new Map(Object.entries(DEFAULT_RULES)));

// ============================================
// Service Class
// ============================================

class RulesServiceClass {
    // ============================================
    // Read Rules
    // ============================================

    /**
     * Get a number value from rules
     */
    getNumber(cityId: string | null, key: string, defaultValue: number = 0): number {
        const value = this.getRawValue(cityId, key);
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return parseFloat(value) || defaultValue;
        return defaultValue;
    }

    /**
     * Get a string value from rules
     */
    getString(cityId: string | null, key: string, defaultValue: string = ''): string {
        const value = this.getRawValue(cityId, key);
        if (typeof value === 'string') return value;
        return defaultValue;
    }

    /**
     * Get a boolean value from rules
     */
    getBoolean(cityId: string | null, key: string, defaultValue: boolean = false): boolean {
        const value = this.getRawValue(cityId, key);
        if (typeof value === 'boolean') return value;
        return defaultValue;
    }

    /**
     * Get a JSON value from rules
     */
    getJson<T>(cityId: string | null, key: string, fallback: T): T {
        const value = this.getRawValue(cityId, key);
        if (value !== undefined && value !== null) {
            return value as T;
        }
        return fallback;
    }

    /**
     * Get raw value with fallback chain: cityId -> global -> default
     */
    private getRawValue(cityId: string | null, key: string): unknown {
        // Try city-specific first
        if (cityId) {
            const cityRules = rulesStore.get(cityId);
            if (cityRules?.has(key)) {
                return cityRules.get(key);
            }
        }

        // Fallback to global
        const globalRules = rulesStore.get('global');
        if (globalRules?.has(key)) {
            return globalRules.get(key);
        }

        // Fallback to hardcoded defaults
        return DEFAULT_RULES[key];
    }

    // ============================================
    // Convenience Methods
    // ============================================

    /**
     * Get golden hours config for a city
     */
    getGoldenHours(cityId: string | null): GoldenHoursConfig {
        return {
            enabled: this.getBoolean(cityId, 'golden_hour_enabled', true),
            startLocal: this.getString(cityId, 'golden_hour_start_local', '17:00'),
            endLocal: this.getString(cityId, 'golden_hour_end_local', '20:00'),
            boostMultiplier: this.getNumber(cityId, 'golden_hour_boost_multiplier', 1.3),
        };
    }

    /**
     * Check if current time is golden hour
     */
    isGoldenHour(cityId: string | null, now: Date = new Date()): boolean {
        const config = this.getGoldenHours(cityId);
        if (!config.enabled) return false;

        const hours = now.getHours();
        const minutes = now.getMinutes();
        const currentTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

        return currentTime >= config.startLocal && currentTime <= config.endLocal;
    }

    /**
     * Get boost tier config for a city
     */
    getBoostTierConfig(cityId: string | null): BoostTierConfig {
        return this.getJson(cityId, 'boost_tiers_config', {
            tiers: [
                { name: 'standard', feeMultiplier: 1.0, priorityScore: 1 },
            ],
        });
    }

    /**
     * Get platform fee percent
     */
    getPlatformFeePercent(cityId: string | null): number {
        return this.getNumber(cityId, 'base_fee_percent', 15);
    }

    /**
     * Get min task price
     */
    getMinTaskPrice(cityId: string | null): number {
        return this.getNumber(cityId, 'min_task_price_usd', 15);
    }

    // ============================================
    // Rule Management
    // ============================================

    /**
     * Set a rule value for a city
     */
    setRule(cityId: string, key: string, value: unknown): void {
        if (!rulesStore.has(cityId)) {
            rulesStore.set(cityId, new Map());
        }
        rulesStore.get(cityId)!.set(key, value);
        serviceLogger.info({ cityId, key }, 'Rule updated');
    }

    /**
     * Get all rules for a city
     */
    getAllRules(cityId: string): Record<string, unknown> {
        const cityRules = rulesStore.get(cityId) || new Map();
        const globalRules = rulesStore.get('global') || new Map();

        const result: Record<string, unknown> = { ...DEFAULT_RULES };

        // Apply global
        for (const [k, v] of globalRules) {
            result[k] = v;
        }

        // Apply city-specific (overrides global)
        for (const [k, v] of cityRules) {
            result[k] = v;
        }

        return result;
    }

    /**
     * Sample marketplace_rules row for documentation
     */
    getSampleRuleRow(): { cityId: string; key: string; value: unknown; description: string } {
        return {
            cityId: 'city_seattle',
            key: 'base_fee_percent',
            value: 15,
            description: 'Platform fee percentage taken from each task',
        };
    }
}

export const RulesService = new RulesServiceClass();
