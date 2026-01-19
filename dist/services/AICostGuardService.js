/**
 * AI Cost Guard Service
 *
 * Per-user rate limiting and cost control for AI calls.
 * Prevents budget overruns by limiting expensive model usage.
 */
import { serviceLogger } from '../utils/logger.js';
// ============================================
// Default Limits
// ============================================
const DEFAULT_LIMITS = {
    // Per-user daily limits
    maxOpenaiCallsPerDay: 50, // GPT-4o is expensive
    maxDeepseekCallsPerDay: 200, // Cheaper, more allowed
    maxGroqCallsPerDay: 1000, // Very cheap, generous limit
    // Cost limits
    maxOpenaiCostPerDay: 1.00, // $1/user/day for GPT-4o
    maxDeepseekCostPerDay: 0.50, // $0.50/user/day
    maxTotalCostPerDay: 2.00, // $2/user/day total
    // System-wide hourly limits
    maxTotalOpenaiCallsPerHour: 500,
    maxTotalCostPerHour: 50.00, // $50/hour system-wide
};
// Cost per call estimates (in USD)
const COST_ESTIMATES = {
    openai: 0.02, // ~$0.02 per GPT-4o call avg
    deepseek: 0.002, // ~$0.002 per call
    qwen: 0.0005, // ~$0.0005 per Groq call (very cheap)
};
// ============================================
// In-Memory Storage
// ============================================
const userUsage = new Map();
const systemUsageByHour = new Map();
// ============================================
// AI Cost Guard Service
// ============================================
class AICostGuardServiceClass {
    limits = { ...DEFAULT_LIMITS };
    /**
     * Update cost limits
     */
    updateLimits(newLimits) {
        this.limits = { ...this.limits, ...newLimits };
        serviceLogger.info({ limits: this.limits }, 'AI cost limits updated');
        return this.limits;
    }
    /**
     * Get current limits
     */
    getLimits() {
        return { ...this.limits };
    }
    /**
     * Get or create user usage record
     */
    getUserUsage(userId) {
        const today = new Date().toISOString().split('T')[0];
        const key = `${userId}:${today}`;
        let usage = userUsage.get(key);
        if (!usage) {
            usage = {
                userId,
                date: today,
                openaiCalls: 0,
                deepseekCalls: 0,
                groqCalls: 0,
                openaiCostUsd: 0,
                deepseekCostUsd: 0,
                groqCostUsd: 0,
                lastCallAt: new Date(),
                warningIssued: false,
            };
            userUsage.set(key, usage);
        }
        return usage;
    }
    /**
     * Check if a user can make an AI call
     */
    checkLimit(userId, provider) {
        const usage = this.getUserUsage(userId);
        // Get provider-specific limits
        let maxCalls;
        let currentCalls;
        let maxCost;
        let currentCost;
        switch (provider) {
            case 'openai':
                maxCalls = this.limits.maxOpenaiCallsPerDay;
                currentCalls = usage.openaiCalls;
                maxCost = this.limits.maxOpenaiCostPerDay;
                currentCost = usage.openaiCostUsd;
                break;
            case 'deepseek':
                maxCalls = this.limits.maxDeepseekCallsPerDay;
                currentCalls = usage.deepseekCalls;
                maxCost = this.limits.maxDeepseekCostPerDay;
                currentCost = usage.deepseekCostUsd;
                break;
            case 'qwen':
            default:
                maxCalls = this.limits.maxGroqCallsPerDay;
                currentCalls = usage.groqCalls;
                maxCost = Infinity; // No specific Groq limit
                currentCost = usage.groqCostUsd;
                break;
        }
        // Check call limit
        if (currentCalls >= maxCalls) {
            const fallback = this.getSuggestedFallback(provider);
            return {
                allowed: false,
                reason: `Daily ${provider} call limit reached (${maxCalls})`,
                remainingCalls: 0,
                suggestedFallback: fallback,
            };
        }
        // Check cost limit
        if (currentCost >= maxCost) {
            const fallback = this.getSuggestedFallback(provider);
            return {
                allowed: false,
                reason: `Daily ${provider} cost limit reached ($${maxCost})`,
                remainingCalls: 0,
                suggestedFallback: fallback,
            };
        }
        // Check total daily cost
        const totalCost = usage.openaiCostUsd + usage.deepseekCostUsd + usage.groqCostUsd;
        if (totalCost >= this.limits.maxTotalCostPerDay) {
            return {
                allowed: false,
                reason: 'Daily AI budget exhausted',
                remainingCalls: 0,
            };
        }
        // Check system-wide hourly limit for OpenAI
        if (provider === 'openai') {
            const hourlyCheck = this.checkSystemHourlyLimit();
            if (!hourlyCheck.allowed) {
                return hourlyCheck;
            }
        }
        // Calculate remaining
        const remaining = maxCalls - currentCalls;
        // Issue warning if approaching limit
        let warningMessage;
        if (remaining <= 5 && !usage.warningIssued) {
            usage.warningIssued = true;
            warningMessage = `Only ${remaining} ${provider} calls remaining today`;
        }
        return {
            allowed: true,
            remainingCalls: remaining,
            warningMessage,
        };
    }
    /**
     * Record an AI call
     */
    recordCall(userId, provider, success = true) {
        const usage = this.getUserUsage(userId);
        const cost = success ? COST_ESTIMATES[provider] : 0;
        switch (provider) {
            case 'openai':
                usage.openaiCalls++;
                usage.openaiCostUsd += cost;
                break;
            case 'deepseek':
                usage.deepseekCalls++;
                usage.deepseekCostUsd += cost;
                break;
            case 'qwen':
            default:
                usage.groqCalls++;
                usage.groqCostUsd += cost;
                break;
        }
        usage.lastCallAt = new Date();
        // Update system hourly tracking
        const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
        const hourlyStats = systemUsageByHour.get(hour) || { calls: 0, cost: 0 };
        hourlyStats.calls++;
        hourlyStats.cost += cost;
        systemUsageByHour.set(hour, hourlyStats);
        serviceLogger.debug({ userId, provider, calls: this.getTotalCalls(usage), cost }, 'AI call recorded');
    }
    /**
     * Get user's usage stats
     */
    getUserStats(userId) {
        const usage = this.getUserUsage(userId);
        const totalCost = usage.openaiCostUsd + usage.deepseekCostUsd + usage.groqCostUsd;
        return {
            usage,
            limits: this.limits,
            percentUsed: {
                openai: Math.round((usage.openaiCalls / this.limits.maxOpenaiCallsPerDay) * 100),
                deepseek: Math.round((usage.deepseekCalls / this.limits.maxDeepseekCallsPerDay) * 100),
                groq: Math.round((usage.groqCalls / this.limits.maxGroqCallsPerDay) * 100),
                totalCost: Math.round((totalCost / this.limits.maxTotalCostPerDay) * 100),
            },
        };
    }
    /**
     * Reset user's daily usage (for testing or admin)
     */
    resetUserUsage(userId) {
        const today = new Date().toISOString().split('T')[0];
        const key = `${userId}:${today}`;
        userUsage.delete(key);
        serviceLogger.info({ userId }, 'User AI usage reset');
    }
    /**
     * Get system-wide stats
     */
    getSystemStats() {
        const hour = new Date().toISOString().slice(0, 13);
        const hourlyStats = systemUsageByHour.get(hour) || { calls: 0, cost: 0 };
        // Calculate daily
        const today = new Date().toISOString().split('T')[0];
        let dailyCalls = 0;
        let dailyCost = 0;
        let userCount = 0;
        userUsage.forEach((usage, key) => {
            if (key.endsWith(today)) {
                dailyCalls += this.getTotalCalls(usage);
                dailyCost += usage.openaiCostUsd + usage.deepseekCostUsd + usage.groqCostUsd;
                userCount++;
            }
        });
        return {
            hourly: hourlyStats,
            daily: { calls: dailyCalls, cost: dailyCost, users: userCount },
        };
    }
    // ============================================
    // Helper Methods
    // ============================================
    getTotalCalls(usage) {
        return usage.openaiCalls + usage.deepseekCalls + usage.groqCalls;
    }
    getSuggestedFallback(provider) {
        // Suggest cheaper alternatives
        if (provider === 'openai')
            return 'deepseek';
        if (provider === 'deepseek')
            return 'qwen';
        return undefined;
    }
    checkSystemHourlyLimit() {
        const hour = new Date().toISOString().slice(0, 13);
        const hourlyStats = systemUsageByHour.get(hour) || { calls: 0, cost: 0 };
        if (hourlyStats.calls >= this.limits.maxTotalOpenaiCallsPerHour) {
            return {
                allowed: false,
                reason: 'System-wide hourly limit reached',
                suggestedFallback: 'deepseek',
            };
        }
        if (hourlyStats.cost >= this.limits.maxTotalCostPerHour) {
            return {
                allowed: false,
                reason: 'System-wide hourly cost limit reached',
                suggestedFallback: 'qwen',
            };
        }
        return { allowed: true };
    }
}
export const AICostGuardService = new AICostGuardServiceClass();
//# sourceMappingURL=AICostGuardService.js.map