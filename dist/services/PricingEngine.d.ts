import { type BoostTier } from './PriorityBoostService.js';
export interface PricingConfig {
    basePlatformFeePercent: number;
    minimumPlatformFee: number;
    maximumPlatformFee: number;
    paymentProcessingPercent: number;
    paymentProcessingFixed: number;
    instantPayoutFee: number;
    instantPayoutPercent: number;
    newHustlerBonusPercent: number;
    highRatingBonusPercent: number;
    minimumTaskPrice: number;
    minimumHustlerPayout: number;
}
export declare const DEFAULT_PRICING_CONFIG: PricingConfig;
export interface PricingBreakdown {
    basePrice: number;
    boostTier: BoostTier;
    posterSubtotal: number;
    posterProcessingFee: number;
    posterTotal: number;
    platformBaseFee: number;
    platformBoostFee: number;
    platformTotalFee: number;
    paymentProcessingCost: number;
    platformNetRevenue: number;
    platformMarginPercent: number;
    hustlerBasePayout: number;
    instantPayoutFee: number;
    hustlerInstantPayout: number;
    hustlerStandardPayout: number;
    hustlerXPMultiplier: number;
    hustlerBadgeEligible: boolean;
}
export interface PayoutRecord {
    id: string;
    hustlerId: string;
    taskId: string;
    amount: number;
    fee: number;
    netPayout: number;
    type: 'instant' | 'standard';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    createdAt: Date;
    completedAt?: Date;
}
export interface RevenueMetrics {
    period: 'day' | 'week' | 'month' | 'all';
    totalTasks: number;
    totalGMV: number;
    totalPlatformFees: number;
    totalBoostFees: number;
    totalProcessingCosts: number;
    netRevenue: number;
    avgTakeRate: number;
    avgTaskValue: number;
    instantPayoutCount: number;
    instantPayoutRevenue: number;
}
declare class PricingEngineClass {
    private config;
    /**
     * Update pricing configuration
     */
    updateConfig(newConfig: Partial<PricingConfig>): PricingConfig;
    /**
     * Get current pricing configuration
     */
    getConfig(): PricingConfig;
    /**
     * Calculate complete pricing breakdown
     */
    calculatePricing(basePrice: number, boostTier?: BoostTier, options?: {
        isNewHustler?: boolean;
        hustlerRating?: number;
        taskCount?: number;
    }): PricingBreakdown;
    /**
     * Calculate poster price quote (what client sees)
     */
    getPosterQuote(basePrice: number, boostTier?: BoostTier): {
        basePrice: number;
        boostFee: number;
        serviceFee: number;
        total: number;
        breakdown: string[];
    };
    /**
     * Calculate hustler earnings preview
     */
    getHustlerEarnings(basePrice: number, boostTier?: BoostTier, options?: {
        isNewHustler?: boolean;
        hustlerRating?: number;
    }): {
        basePayout: number;
        instantPayout: number;
        standardPayout: number;
        instantFee: number;
        xpMultiplier: number;
        bonusApplied: string | null;
    };
    /**
     * Process instant payout request
     */
    requestInstantPayout(hustlerId: string, taskId: string, amount: number): PayoutRecord;
    /**
     * Get payout history for hustler
     */
    getPayoutHistory(hustlerId: string): PayoutRecord[];
    /**
     * Track revenue for analytics
     */
    private trackRevenue;
    /**
     * Get revenue metrics
     */
    getRevenueMetrics(period?: 'day' | 'week' | 'month' | 'all'): RevenueMetrics;
    /**
     * Get pricing comparison table
     */
    getPricingTable(basePrice: number): {
        tier: BoostTier;
        tierName: string;
        posterPays: number;
        platformEarns: number;
        hustlerGets: number;
        hustlerXP: string;
    }[];
}
export declare const PricingEngine: PricingEngineClass;
export {};
//# sourceMappingURL=PricingEngine.d.ts.map