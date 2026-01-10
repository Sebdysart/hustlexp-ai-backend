/**
 * Rules Service - Phase E
 *
 * Config-driven marketplace rules per city:
 * - Pricing (base fees, platform take rate)
 * - Golden hours
 * - Boost tiers
 * - Search radius
 */
export interface RuleValue {
    value: unknown;
    description?: string;
}
export interface GoldenHoursConfig {
    enabled: boolean;
    startLocal: string;
    endLocal: string;
    boostMultiplier: number;
}
export interface BoostTierConfig {
    tiers: {
        name: string;
        feeMultiplier: number;
        priorityScore: number;
    }[];
}
declare class RulesServiceClass {
    /**
     * Get a number value from rules
     */
    getNumber(cityId: string | null, key: string, defaultValue?: number): number;
    /**
     * Get a string value from rules
     */
    getString(cityId: string | null, key: string, defaultValue?: string): string;
    /**
     * Get a boolean value from rules
     */
    getBoolean(cityId: string | null, key: string, defaultValue?: boolean): boolean;
    /**
     * Get a JSON value from rules
     */
    getJson<T>(cityId: string | null, key: string, fallback: T): T;
    /**
     * Get raw value with fallback chain: cityId -> global -> default
     */
    private getRawValue;
    /**
     * Get golden hours config for a city
     */
    getGoldenHours(cityId: string | null): GoldenHoursConfig;
    /**
     * Check if current time is golden hour
     */
    isGoldenHour(cityId: string | null, now?: Date): boolean;
    /**
     * Get boost tier config for a city
     */
    getBoostTierConfig(cityId: string | null): BoostTierConfig;
    /**
     * Get platform fee percent
     */
    getPlatformFeePercent(cityId: string | null): number;
    /**
     * Get min task price
     */
    getMinTaskPrice(cityId: string | null): number;
    /**
     * Set a rule value for a city
     */
    setRule(cityId: string, key: string, value: unknown): void;
    /**
     * Get all rules for a city
     */
    getAllRules(cityId: string): Record<string, unknown>;
    /**
     * Sample marketplace_rules row for documentation
     */
    getSampleRuleRow(): {
        cityId: string;
        key: string;
        value: unknown;
        description: string;
    };
}
export declare const RulesService: RulesServiceClass;
export {};
//# sourceMappingURL=RulesService.d.ts.map