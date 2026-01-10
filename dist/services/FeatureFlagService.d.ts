/**
 * Feature Flag Service - Phase E
 *
 * Controlled feature rollout:
 * - Global flags
 * - City-specific overrides
 * - User-specific overrides
 */
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
declare class FeatureFlagServiceClass {
    /**
     * Check if a feature is enabled
     * Order of precedence:
     * 1. User override
     * 2. City override
     * 3. Global flag
     * 4. Default: false
     */
    isEnabled(key: string, context?: {
        cityId?: string;
        userId?: string;
    }): boolean;
    /**
     * Get all enabled flags for a context
     */
    getEnabledFlags(context?: {
        cityId?: string;
        userId?: string;
    }): string[];
    /**
     * Get all flags
     */
    getAllFlags(): FeatureFlag[];
    /**
     * Get a specific flag
     */
    getFlag(key: string): FeatureFlag | undefined;
    /**
     * Create or update a flag
     */
    setFlag(key: string, enabledGlobal: boolean, description?: string): FeatureFlag;
    /**
     * Toggle a flag globally
     */
    toggleFlag(key: string): boolean;
    /**
     * Add a city override
     */
    setCityOverride(key: string, cityId: string, enabled: boolean): FlagOverride | null;
    /**
     * Add a user override
     */
    setUserOverride(key: string, userId: string, enabled: boolean): FlagOverride | null;
    /**
     * Remove a city override
     */
    removeCityOverride(key: string, cityId: string): boolean;
    /**
     * Remove a user override
     */
    removeUserOverride(key: string, userId: string): boolean;
    /**
     * Get all overrides for a flag
     */
    getOverrides(key: string): FlagOverride[];
}
export declare const FeatureFlagService: FeatureFlagServiceClass;
export {};
//# sourceMappingURL=FeatureFlagService.d.ts.map