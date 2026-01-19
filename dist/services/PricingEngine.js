import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { BOOST_TIERS } from './PriorityBoostService.js';
// Default Seattle beta pricing
export const DEFAULT_PRICING_CONFIG = {
    basePlatformFeePercent: 0.12, // 12% base fee
    minimumPlatformFee: 2, // $2 minimum
    maximumPlatformFee: 50, // $50 cap
    paymentProcessingPercent: 0.029, // 2.9% (Stripe)
    paymentProcessingFixed: 0.30, // $0.30 per transaction
    instantPayoutFee: 1.50, // $1.50 flat
    instantPayoutPercent: 0.01, // 1% additional
    newHustlerBonusPercent: 0.05, // 5% reduced fee for first 10 tasks
    highRatingBonusPercent: 0.02, // 2% reduced fee for 4.8+ rating
    minimumTaskPrice: 15,
    minimumHustlerPayout: 10,
};
// ============================================
// In-memory stores
// ============================================
const payoutRecords = new Map();
const dailyRevenue = [];
// ============================================
// Pricing Engine
// ============================================
class PricingEngineClass {
    config = DEFAULT_PRICING_CONFIG;
    /**
     * Update pricing configuration
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        serviceLogger.info({ config: this.config }, 'Pricing config updated');
        return this.config;
    }
    /**
     * Get current pricing configuration
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Calculate complete pricing breakdown
     */
    calculatePricing(basePrice, boostTier = 'normal', options) {
        const boost = BOOST_TIERS[boostTier];
        // Validate minimum price
        if (basePrice < this.config.minimumTaskPrice) {
            basePrice = this.config.minimumTaskPrice;
        }
        // === POSTER SIDE ===
        // Boost premium (goes 100% to platform)
        const boostMultiplier = boost.feeMultiplier;
        const boostPremium = Math.round((basePrice * (boostMultiplier - 1)) * 100) / 100;
        const posterSubtotal = basePrice + boostPremium;
        // Payment processing on full amount (poster pays this)
        const posterProcessingFee = Math.round((posterSubtotal * this.config.paymentProcessingPercent + this.config.paymentProcessingFixed) * 100) / 100;
        const posterTotal = Math.round((posterSubtotal + posterProcessingFee) * 100) / 100;
        // === PLATFORM FEES ===
        // Base platform fee (% of base price, not boost)
        let platformFeePercent = this.config.basePlatformFeePercent;
        // Apply hustler bonuses (reduces platform fee = higher hustler payout)
        if (options?.isNewHustler && (options?.taskCount || 0) < 10) {
            platformFeePercent -= this.config.newHustlerBonusPercent;
        }
        if (options?.hustlerRating && options.hustlerRating >= 4.8) {
            platformFeePercent -= this.config.highRatingBonusPercent;
        }
        platformFeePercent = Math.max(0.05, platformFeePercent); // Minimum 5% fee
        let platformBaseFee = Math.round(basePrice * platformFeePercent * 100) / 100;
        // Apply min/max caps
        platformBaseFee = Math.max(platformBaseFee, this.config.minimumPlatformFee);
        platformBaseFee = Math.min(platformBaseFee, this.config.maximumPlatformFee);
        // Boost fee (100% to platform)
        const platformBoostFee = boostPremium;
        const platformTotalFee = platformBaseFee + platformBoostFee;
        // === COSTS ===
        // Payment processing cost (on full transaction)
        const paymentProcessingCost = Math.round((posterSubtotal * this.config.paymentProcessingPercent + this.config.paymentProcessingFixed) * 100) / 100;
        // === NET REVENUE ===
        const platformNetRevenue = Math.round((platformTotalFee - paymentProcessingCost) * 100) / 100;
        const platformMarginPercent = Math.round((platformNetRevenue / posterSubtotal) * 100 * 100) / 100;
        // === HUSTLER PAYOUT ===
        const hustlerBasePayout = Math.round((basePrice - platformBaseFee) * 100) / 100;
        // Instant payout fee
        const instantFee = Math.round((this.config.instantPayoutFee + hustlerBasePayout * this.config.instantPayoutPercent) * 100) / 100;
        const hustlerInstantPayout = Math.round((hustlerBasePayout - instantFee) * 100) / 100;
        const hustlerStandardPayout = hustlerBasePayout;
        // === GAMIFICATION ===
        const hustlerXPMultiplier = boost.hustlerXPBoost;
        const hustlerBadgeEligible = boostTier !== 'normal';
        // Track revenue
        this.trackRevenue(posterSubtotal, platformTotalFee, paymentProcessingCost);
        return {
            basePrice,
            boostTier,
            posterSubtotal,
            posterProcessingFee,
            posterTotal,
            platformBaseFee,
            platformBoostFee,
            platformTotalFee,
            paymentProcessingCost,
            platformNetRevenue,
            platformMarginPercent,
            hustlerBasePayout,
            instantPayoutFee: instantFee,
            hustlerInstantPayout,
            hustlerStandardPayout,
            hustlerXPMultiplier,
            hustlerBadgeEligible,
        };
    }
    /**
     * Calculate poster price quote (what client sees)
     */
    getPosterQuote(basePrice, boostTier = 'normal') {
        const pricing = this.calculatePricing(basePrice, boostTier);
        const breakdown = [
            `Task price: $${basePrice.toFixed(2)}`,
        ];
        if (pricing.platformBoostFee > 0) {
            breakdown.push(`${BOOST_TIERS[boostTier].name} boost: $${pricing.platformBoostFee.toFixed(2)}`);
        }
        breakdown.push(`Service fee: $${pricing.posterProcessingFee.toFixed(2)}`);
        breakdown.push(`Total: $${pricing.posterTotal.toFixed(2)}`);
        return {
            basePrice,
            boostFee: pricing.platformBoostFee,
            serviceFee: pricing.posterProcessingFee,
            total: pricing.posterTotal,
            breakdown,
        };
    }
    /**
     * Calculate hustler earnings preview
     */
    getHustlerEarnings(basePrice, boostTier = 'normal', options) {
        const pricing = this.calculatePricing(basePrice, boostTier, options);
        let bonusApplied = null;
        if (options?.isNewHustler) {
            bonusApplied = 'New Hustler Bonus: Lower platform fee!';
        }
        else if (options?.hustlerRating && options.hustlerRating >= 4.8) {
            bonusApplied = 'Top Rated Bonus: Lower platform fee!';
        }
        return {
            basePayout: pricing.hustlerBasePayout,
            instantPayout: pricing.hustlerInstantPayout,
            standardPayout: pricing.hustlerStandardPayout,
            instantFee: pricing.instantPayoutFee,
            xpMultiplier: pricing.hustlerXPMultiplier,
            bonusApplied,
        };
    }
    /**
     * Process instant payout request
     */
    requestInstantPayout(hustlerId, taskId, amount) {
        const fee = Math.round((this.config.instantPayoutFee + amount * this.config.instantPayoutPercent) * 100) / 100;
        const netPayout = Math.round((amount - fee) * 100) / 100;
        const record = {
            id: uuidv4(),
            hustlerId,
            taskId,
            amount,
            fee,
            netPayout,
            type: 'instant',
            status: 'pending',
            createdAt: new Date(),
        };
        payoutRecords.set(record.id, record);
        serviceLogger.info({ payoutId: record.id, hustlerId, netPayout }, 'Instant payout requested');
        // In production, this would trigger Stripe/bank transfer
        // For now, simulate completion
        setTimeout(() => {
            record.status = 'completed';
            record.completedAt = new Date();
            payoutRecords.set(record.id, record);
        }, 1000);
        return record;
    }
    /**
     * Get payout history for hustler
     */
    getPayoutHistory(hustlerId) {
        return Array.from(payoutRecords.values())
            .filter(p => p.hustlerId === hustlerId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    /**
     * Track revenue for analytics
     */
    trackRevenue(gmv, platformFee, processingCost) {
        const today = new Date().toISOString().split('T')[0];
        const existing = dailyRevenue.find(d => d.date === today);
        if (existing) {
            existing.revenue += platformFee - processingCost;
            existing.tasks += 1;
            existing.gmv += gmv;
        }
        else {
            dailyRevenue.push({
                date: today,
                revenue: platformFee - processingCost,
                tasks: 1,
                gmv,
            });
        }
    }
    /**
     * Get revenue metrics
     */
    getRevenueMetrics(period = 'all') {
        const now = new Date();
        let startDate;
        switch (period) {
            case 'day':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                break;
            case 'week':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case 'month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                break;
            default:
                startDate = new Date(0);
        }
        const startDateStr = startDate.toISOString().split('T')[0];
        const filtered = dailyRevenue.filter(d => d.date >= startDateStr);
        const totalTasks = filtered.reduce((sum, d) => sum + d.tasks, 0);
        const totalGMV = filtered.reduce((sum, d) => sum + d.gmv, 0);
        const netRevenue = filtered.reduce((sum, d) => sum + d.revenue, 0);
        // Calculate instant payout metrics
        const instantPayouts = Array.from(payoutRecords.values()).filter(p => p.type === 'instant' && p.createdAt >= startDate);
        return {
            period,
            totalTasks,
            totalGMV: Math.round(totalGMV * 100) / 100,
            totalPlatformFees: Math.round(netRevenue * 1.3 * 100) / 100, // Approximate gross
            totalBoostFees: 0, // Would need to track separately
            totalProcessingCosts: Math.round(netRevenue * 0.23 * 100) / 100, // Approximate
            netRevenue: Math.round(netRevenue * 100) / 100,
            avgTakeRate: totalGMV > 0 ? Math.round((netRevenue / totalGMV) * 100 * 100) / 100 : 0,
            avgTaskValue: totalTasks > 0 ? Math.round((totalGMV / totalTasks) * 100) / 100 : 0,
            instantPayoutCount: instantPayouts.length,
            instantPayoutRevenue: instantPayouts.reduce((sum, p) => sum + p.fee, 0),
        };
    }
    /**
     * Get pricing comparison table
     */
    getPricingTable(basePrice) {
        return ['normal', 'priority', 'rush', 'vip'].map(tier => {
            const pricing = this.calculatePricing(basePrice, tier);
            return {
                tier,
                tierName: BOOST_TIERS[tier].name,
                posterPays: pricing.posterTotal,
                platformEarns: pricing.platformNetRevenue,
                hustlerGets: pricing.hustlerStandardPayout,
                hustlerXP: pricing.hustlerXPMultiplier === 1 ? 'Standard' : `+${Math.round((pricing.hustlerXPMultiplier - 1) * 100)}%`,
            };
        });
    }
}
export const PricingEngine = new PricingEngineClass();
//# sourceMappingURL=PricingEngine.js.map