/**
 * Feature Flag Service - Phase E
 * 
 * Controlled feature rollout:
 * - Global flags
 * - City-specific overrides
 * - User-specific overrides
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';

// ============================================
// Types
// ============================================

export interface FeatureFlag {
    id: string;
    key: string;
    description: string;
    enabledGlobal: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface FlagOverride {
    id: string;
    flagId: string;
    cityId?: string;
    userId?: string;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
}

// ============================================
// Default Flags
// ============================================

const DEFAULT_FLAGS: Omit<FeatureFlag, 'id' | 'createdAt' | 'updatedAt'>[] = [
    { key: 'ai_next_best_action', description: 'Show AI-generated next best action CTAs', enabledGlobal: true },
    { key: 'golden_hour_banner', description: 'Show golden hour earnings boost banner', enabledGlobal: true },
    { key: 'streak_protection', description: 'Allow streak protection purchases', enabledGlobal: false },
    { key: 'earnings_projection', description: 'Show AI earnings projections', enabledGlobal: true },
    { key: 'auto_quest_generation', description: 'AI auto-generates personalized quests', enabledGlobal: false },
    { key: 'profile_ai_suggestions', description: 'AI suggests profile improvements', enabledGlobal: true },
    { key: 'instant_payout', description: 'Allow instant payout option', enabledGlobal: true },
    { key: 'smart_matching', description: 'Use AI-powered task matching', enabledGlobal: true },
    { key: 'proof_ai_validation', description: 'AI validates proof photos', enabledGlobal: true },
    { key: 'dispute_ai_analysis', description: 'AI analyzes disputes for resolution hints', enabledGlobal: false },
];

// ============================================
// In-memory store
// ============================================

const flags = new Map<string, FeatureFlag>();
const overrides: FlagOverride[] = [];

// Initialize default flags
for (const flagData of DEFAULT_FLAGS) {
    const flag: FeatureFlag = {
        id: `flag_${uuidv4()}`,
        ...flagData,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    flags.set(flag.key, flag);
}

// ============================================
// Service Class
// ============================================

class FeatureFlagServiceClass {
    // ============================================
    // Check Flags
    // ============================================

    /**
     * Check if a feature is enabled
     * Order of precedence:
     * 1. User override
     * 2. City override
     * 3. Global flag
     * 4. Default: false
     */
    isEnabled(
        key: string,
        context?: { cityId?: string; userId?: string }
    ): boolean {
        const flag = flags.get(key);

        if (!flag) {
            serviceLogger.debug({ key }, 'Feature flag not found, defaulting to false');
            return false;
        }

        // Check user override first
        if (context?.userId) {
            const userOverride = overrides.find(
                o => o.flagId === flag.id && o.userId === context.userId
            );
            if (userOverride) {
                return userOverride.enabled;
            }
        }

        // Check city override
        if (context?.cityId) {
            const cityOverride = overrides.find(
                o => o.flagId === flag.id && o.cityId === context.cityId && !o.userId
            );
            if (cityOverride) {
                return cityOverride.enabled;
            }
        }

        // Fallback to global
        return flag.enabledGlobal;
    }

    /**
     * Get all enabled flags for a context
     */
    getEnabledFlags(context?: { cityId?: string; userId?: string }): string[] {
        const result: string[] = [];

        for (const [key] of flags) {
            if (this.isEnabled(key, context)) {
                result.push(key);
            }
        }

        return result;
    }

    // ============================================
    // Flag Management
    // ============================================

    /**
     * Get all flags
     */
    getAllFlags(): FeatureFlag[] {
        return Array.from(flags.values());
    }

    /**
     * Get a specific flag
     */
    getFlag(key: string): FeatureFlag | undefined {
        return flags.get(key);
    }

    /**
     * Create or update a flag
     */
    setFlag(key: string, enabledGlobal: boolean, description?: string): FeatureFlag {
        const existing = flags.get(key);

        if (existing) {
            existing.enabledGlobal = enabledGlobal;
            if (description) existing.description = description;
            existing.updatedAt = new Date();
            return existing;
        }

        const flag: FeatureFlag = {
            id: `flag_${uuidv4()}`,
            key,
            description: description || '',
            enabledGlobal,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        flags.set(key, flag);
        serviceLogger.info({ key, enabledGlobal }, 'Feature flag created');
        return flag;
    }

    /**
     * Toggle a flag globally
     */
    toggleFlag(key: string): boolean {
        const flag = flags.get(key);
        if (!flag) return false;

        flag.enabledGlobal = !flag.enabledGlobal;
        flag.updatedAt = new Date();

        serviceLogger.info({ key, enabled: flag.enabledGlobal }, 'Feature flag toggled');
        return flag.enabledGlobal;
    }

    // ============================================
    // Override Management
    // ============================================

    /**
     * Add a city override
     */
    setCityOverride(key: string, cityId: string, enabled: boolean): FlagOverride | null {
        const flag = flags.get(key);
        if (!flag) return null;

        // Remove existing city override
        const existingIdx = overrides.findIndex(
            o => o.flagId === flag.id && o.cityId === cityId && !o.userId
        );
        if (existingIdx !== -1) {
            overrides.splice(existingIdx, 1);
        }

        const override: FlagOverride = {
            id: `override_${uuidv4()}`,
            flagId: flag.id,
            cityId,
            enabled,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        overrides.push(override);
        serviceLogger.info({ key, cityId, enabled }, 'City override set');
        return override;
    }

    /**
     * Add a user override
     */
    setUserOverride(key: string, userId: string, enabled: boolean): FlagOverride | null {
        const flag = flags.get(key);
        if (!flag) return null;

        // Remove existing user override
        const existingIdx = overrides.findIndex(
            o => o.flagId === flag.id && o.userId === userId
        );
        if (existingIdx !== -1) {
            overrides.splice(existingIdx, 1);
        }

        const override: FlagOverride = {
            id: `override_${uuidv4()}`,
            flagId: flag.id,
            userId,
            enabled,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        overrides.push(override);
        serviceLogger.info({ key, userId, enabled }, 'User override set');
        return override;
    }

    /**
     * Remove a city override
     */
    removeCityOverride(key: string, cityId: string): boolean {
        const flag = flags.get(key);
        if (!flag) return false;

        const idx = overrides.findIndex(
            o => o.flagId === flag.id && o.cityId === cityId && !o.userId
        );
        if (idx !== -1) {
            overrides.splice(idx, 1);
            return true;
        }
        return false;
    }

    /**
     * Remove a user override
     */
    removeUserOverride(key: string, userId: string): boolean {
        const flag = flags.get(key);
        if (!flag) return false;

        const idx = overrides.findIndex(
            o => o.flagId === flag.id && o.userId === userId
        );
        if (idx !== -1) {
            overrides.splice(idx, 1);
            return true;
        }
        return false;
    }

    /**
     * Get all overrides for a flag
     */
    getOverrides(key: string): FlagOverride[] {
        const flag = flags.get(key);
        if (!flag) return [];

        return overrides.filter(o => o.flagId === flag.id);
    }
}

export const FeatureFlagService = new FeatureFlagServiceClass();
