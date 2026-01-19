/**
 * Action Tracker Service
 *
 * Records every user action and learns behavioral patterns.
 * The AI becomes aware of what you're doing in the app.
 *
 * Tracks: viewed, accepted, skipped, completed, cancelled tasks
 * Learns: patterns, preferences, active times
 */
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// In-Memory Storage
// ============================================
const actionHistory = new Map();
const actionStats = new Map();
const MAX_ACTIONS_PER_USER = 500; // Keep last 500 actions
const RECENT_ACTIONS_DEFAULT = 10;
// ============================================
// Action Tracker Service
// ============================================
class ActionTrackerServiceClass {
    /**
     * Track a user action
     */
    trackAction(userId, action) {
        const trackedAction = {
            id: uuidv4(),
            userId,
            actionType: action.actionType,
            screen: action.screen,
            metadata: action.metadata || {},
            timestamp: new Date(),
        };
        // Store in history
        const history = actionHistory.get(userId) || [];
        history.unshift(trackedAction);
        // Trim to max size
        if (history.length > MAX_ACTIONS_PER_USER) {
            history.length = MAX_ACTIONS_PER_USER;
        }
        actionHistory.set(userId, history);
        // Update stats
        this.updateStats(userId, trackedAction);
        serviceLogger.debug({
            userId,
            actionType: action.actionType,
            screen: action.screen,
        }, 'Action tracked');
        return trackedAction;
    }
    /**
     * Get recent actions for a user
     */
    getRecentActions(userId, limit = RECENT_ACTIONS_DEFAULT) {
        const history = actionHistory.get(userId) || [];
        return history.slice(0, limit);
    }
    /**
     * Get recent actions formatted for AI context
     */
    getRecentActionsForAI(userId, limit = 5) {
        const actions = this.getRecentActions(userId, limit);
        return actions.map(a => {
            const category = a.metadata.taskCategory ? `:${a.metadata.taskCategory}` : '';
            return `${a.actionType}${category}`;
        });
    }
    /**
     * Get action stats for a user
     */
    getStats(userId) {
        let stats = actionStats.get(userId);
        if (!stats) {
            stats = this.initializeStats(userId);
            actionStats.set(userId, stats);
        }
        return stats;
    }
    /**
     * Initialize empty stats
     */
    initializeStats(userId) {
        return {
            userId,
            tasksViewed: 0,
            tasksAccepted: 0,
            tasksSkipped: 0,
            tasksCompleted: 0,
            tasksCancelled: 0,
            categoryStats: {},
            activeHours: {},
            activeDays: {},
            avgAcceptedPrice: 0,
            priceRangeAccepted: { min: Infinity, max: 0 },
            mostVisitedScreens: [],
            lastActiveAt: new Date(),
        };
    }
    /**
     * Update stats from action
     */
    updateStats(userId, action) {
        const stats = this.getStats(userId);
        stats.lastActiveAt = action.timestamp;
        // Track time patterns
        const hour = action.timestamp.getHours();
        const day = action.timestamp.getDay();
        stats.activeHours[hour] = (stats.activeHours[hour] || 0) + 1;
        stats.activeDays[day] = (stats.activeDays[day] || 0) + 1;
        // Track by action type
        switch (action.actionType) {
            case 'viewed_task':
                stats.tasksViewed++;
                this.updateCategoryStats(stats, action.metadata.taskCategory, 'viewed');
                break;
            case 'accepted_task':
                stats.tasksAccepted++;
                this.updateCategoryStats(stats, action.metadata.taskCategory, 'accepted');
                if (action.metadata.taskPrice) {
                    this.updatePriceStats(stats, action.metadata.taskPrice);
                }
                break;
            case 'skipped_task':
            case 'rejected_task':
                stats.tasksSkipped++;
                this.updateCategoryStats(stats, action.metadata.taskCategory, 'skipped');
                break;
            case 'completed_task':
                stats.tasksCompleted++;
                this.updateCategoryStats(stats, action.metadata.taskCategory, 'completed');
                break;
            case 'cancelled_task':
                stats.tasksCancelled++;
                break;
        }
        actionStats.set(userId, stats);
    }
    /**
     * Update category-specific stats
     */
    updateCategoryStats(stats, category, type) {
        if (!category)
            return;
        if (!stats.categoryStats[category]) {
            stats.categoryStats[category] = {
                viewed: 0,
                accepted: 0,
                skipped: 0,
                completed: 0,
                acceptanceRate: 0,
            };
        }
        stats.categoryStats[category][type]++;
        // Recalculate acceptance rate
        const catStats = stats.categoryStats[category];
        if (catStats.viewed > 0) {
            catStats.acceptanceRate = catStats.accepted / catStats.viewed;
        }
    }
    /**
     * Update price stats
     */
    updatePriceStats(stats, price) {
        const acceptedCount = stats.tasksAccepted;
        // Running average
        stats.avgAcceptedPrice = ((stats.avgAcceptedPrice * (acceptedCount - 1)) + price) / acceptedCount;
        // Range
        if (price < stats.priceRangeAccepted.min) {
            stats.priceRangeAccepted.min = price;
        }
        if (price > stats.priceRangeAccepted.max) {
            stats.priceRangeAccepted.max = price;
        }
    }
    /**
     * Analyze behavioral patterns
     */
    analyzePatterns(userId) {
        const stats = this.getStats(userId);
        const history = actionHistory.get(userId) || [];
        // Find preferred categories (high acceptance rate)
        const preferredCategories = [];
        const avoidedCategories = [];
        for (const [category, catStats] of Object.entries(stats.categoryStats)) {
            if (catStats.viewed >= 3) { // Need enough data
                if (catStats.acceptanceRate >= 0.5) {
                    preferredCategories.push(category);
                }
                else if (catStats.acceptanceRate < 0.2) {
                    avoidedCategories.push(category);
                }
            }
        }
        // Find peak hours (top 3)
        const hourEntries = Object.entries(stats.activeHours)
            .map(([h, count]) => ({ hour: parseInt(h), count }))
            .sort((a, b) => b.count - a.count);
        const peakHours = hourEntries.slice(0, 3).map(e => e.hour);
        // Find peak days
        const dayEntries = Object.entries(stats.activeDays)
            .map(([d, count]) => ({ day: parseInt(d), count }))
            .sort((a, b) => b.count - a.count);
        const peakDays = dayEntries.slice(0, 3).map(e => e.day);
        // Calculate avg tasks per day
        const now = new Date();
        const oldestAction = history[history.length - 1];
        let avgTasksPerDay = 0;
        if (oldestAction) {
            const daysDiff = Math.max(1, (now.getTime() - oldestAction.timestamp.getTime()) / (1000 * 60 * 60 * 24));
            avgTasksPerDay = stats.tasksCompleted / daysDiff;
        }
        // Is user active? (action in last 7 days)
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const isActive = stats.lastActiveAt > sevenDaysAgo;
        return {
            preferredCategories,
            avoidedCategories,
            peakHours,
            peakDays,
            avgTasksPerDay,
            isActive,
        };
    }
    /**
     * Get acceptance rate for a category
     */
    getCategoryAcceptanceRate(userId, category) {
        const stats = this.getStats(userId);
        return stats.categoryStats[category]?.acceptanceRate || 0.5; // Default 50%
    }
    /**
     * Check if user is likely to accept a task
     */
    predictLikelyToAccept(userId, task) {
        const stats = this.getStats(userId);
        const patterns = this.analyzePatterns(userId);
        let score = 0.5; // Start neutral
        let reason = 'Insufficient data';
        // Check category preference
        if (patterns.preferredCategories.includes(task.category)) {
            score += 0.3;
            reason = `User typically accepts ${task.category} tasks`;
        }
        else if (patterns.avoidedCategories.includes(task.category)) {
            score -= 0.3;
            reason = `User typically skips ${task.category} tasks`;
        }
        // Check price range
        if (stats.priceRangeAccepted.min !== Infinity) {
            if (task.price >= stats.priceRangeAccepted.min && task.price <= stats.priceRangeAccepted.max * 1.2) {
                score += 0.1;
            }
            else if (task.price < stats.priceRangeAccepted.min) {
                score -= 0.1;
                reason = 'Price lower than user\'s typical range';
            }
        }
        // Check if it's their active time
        const now = new Date();
        if (patterns.peakHours.includes(now.getHours())) {
            score += 0.1;
        }
        const confidence = Math.min(100, stats.tasksViewed * 10); // More data = more confidence
        return {
            likely: score >= 0.5,
            confidence,
            reason,
        };
    }
    /**
     * Clear history for a user (testing)
     */
    clearHistory(userId) {
        actionHistory.delete(userId);
        actionStats.delete(userId);
        serviceLogger.info({ userId }, 'Action history cleared');
    }
    /**
     * Get all actions for analytics
     */
    getAllActions() {
        const allActions = [];
        actionHistory.forEach(history => {
            allActions.push(...history);
        });
        return allActions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }
}
export const ActionTrackerService = new ActionTrackerServiceClass();
//# sourceMappingURL=ActionTrackerService.js.map