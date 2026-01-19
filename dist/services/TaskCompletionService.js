/**
 * Task Completion Service
 *
 * Orchestrates the complete task lifecycle:
 * Proof Verification → Task Completion → XP Award → Payout → Streak Update
 *
 * This is the "Smart Completion Flow" that connects all services.
 */
import { TaskService } from './TaskService.js';
import { AIProofService } from './AIProofService.js';
import { GamificationService } from './GamificationService.js';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// In-memory stores
// ============================================
const streakData = new Map();
const completionHistory = new Map();
// Streak bonus thresholds
const STREAK_BONUSES = [
    { days: 3, xp: 25, message: '🔥 3-day streak!' },
    { days: 7, xp: 75, message: '🔥🔥 Week warrior!' },
    { days: 14, xp: 150, message: '🔥🔥🔥 Two week champion!' },
    { days: 30, xp: 500, message: '👑 Monthly legend!' },
];
// ============================================
// Task Completion Service
// ============================================
class TaskCompletionServiceClass {
    /**
     * Check if a task is eligible for completion
     */
    async getCompletionEligibility(taskId) {
        const task = await TaskService.getTask(taskId);
        if (!task) {
            return {
                taskId,
                status: 'not_found',
                eligible: false,
                proofComplete: false,
                missingProofs: [],
                proofProgress: { completed: 0, required: 0, percent: 0 },
            };
        }
        if (task.status === 'completed') {
            return {
                taskId,
                status: 'already_completed',
                eligible: false,
                proofComplete: true,
                missingProofs: [],
                proofProgress: { completed: 0, required: 0, percent: 100 },
            };
        }
        // Check proof status
        const proofSession = AIProofService.getSessionByTaskId(taskId);
        if (!proofSession) {
            // No proof session exists yet
            const requirements = AIProofService.getProofRequirements(task.category);
            const requiredCount = requirements.filter(r => r.required).length;
            return {
                taskId,
                status: 'proof_required',
                eligible: false,
                proofComplete: false,
                missingProofs: requirements.filter(r => r.required).map(r => r.title),
                proofProgress: { completed: 0, required: requiredCount, percent: 0 },
            };
        }
        // Check if all required proofs are submitted
        const requiredProofs = proofSession.requirements.filter(r => r.required);
        const submittedIds = new Set(proofSession.proofs.map(p => p.requirementId));
        const missingProofs = requiredProofs
            .filter(r => !submittedIds.has(r.id))
            .map(r => r.title);
        const proofComplete = missingProofs.length === 0;
        return {
            taskId,
            status: proofComplete ? 'eligible' : 'proof_required',
            eligible: proofComplete,
            proofComplete,
            missingProofs,
            proofProgress: {
                completed: proofSession.completedCount,
                required: proofSession.totalRequired,
                percent: proofSession.progressPercent,
            },
        };
    }
    /**
     * Smart complete a task with full reward flow
     */
    async smartComplete(taskId, hustlerId, options) {
        const rating = options?.rating;
        const skipProofCheck = options?.skipProofCheck ?? false;
        // 1. Check eligibility
        if (!skipProofCheck) {
            const eligibility = await this.getCompletionEligibility(taskId);
            if (!eligibility.eligible) {
                return this.createFailedResult(taskId, hustlerId, `Cannot complete: ${eligibility.status}`);
            }
        }
        // 2. Get task
        const task = await TaskService.getTask(taskId);
        if (!task) {
            return this.createFailedResult(taskId, hustlerId, 'Task not found');
        }
        // 3. Complete the task
        const completedTask = await TaskService.completeTask(taskId);
        if (!completedTask) {
            return this.createFailedResult(taskId, hustlerId, 'Failed to complete task');
        }
        // 4. Calculate XP breakdown
        const xpBreakdown = {
            base: 100,
            proofBonus: 0,
            ratingBonus: 0,
            streakBonus: 0,
        };
        // Proof completion bonus (based on proof session XP)
        const proofSession = AIProofService.getSessionByTaskId(taskId);
        if (proofSession) {
            xpBreakdown.proofBonus = proofSession.totalXPEarned;
        }
        // Rating bonus
        if (rating === 5) {
            xpBreakdown.ratingBonus = 50;
        }
        else if (rating === 4) {
            xpBreakdown.ratingBonus = 20;
        }
        // 5. Update streak and get streak bonus
        const streakResult = await this.updateStreak(hustlerId);
        xpBreakdown.streakBonus = streakResult.bonusAwarded;
        // 6. Award total XP
        const totalXP = xpBreakdown.base + xpBreakdown.proofBonus + xpBreakdown.ratingBonus + xpBreakdown.streakBonus;
        await GamificationService.awardXP(hustlerId, totalXP, 'task_completed', taskId);
        // 7. Calculate new level
        const history = completionHistory.get(hustlerId) || [];
        const previousXP = history.reduce((sum, h) => sum + h.xpEarned, 0);
        const newTotalXP = previousXP + totalXP;
        const previousLevel = GamificationService.calculateLevel(previousXP);
        const newLevel = GamificationService.calculateLevel(newTotalXP);
        const levelUp = newLevel > previousLevel;
        // 8. Store completion history
        history.push({ taskId, completedAt: new Date(), xpEarned: totalXP });
        completionHistory.set(hustlerId, history);
        // 9. Calculate payout eligibility
        const payoutAmount = task.recommendedPrice ?? 0;
        const payoutEligible = payoutAmount > 0;
        // 10. Build animations list
        const animations = ['confetti', 'xp_burst'];
        if (levelUp)
            animations.push('level_up');
        if (rating === 5)
            animations.push('rating_stars');
        if (streakResult.streak.current >= 3)
            animations.push('streak_fire');
        if (payoutEligible)
            animations.push('coins');
        // 11. Build celebration message
        const celebrationMessage = this.buildCelebrationMessage(totalXP, levelUp, newLevel, streakResult.streak.current, rating);
        serviceLogger.info({
            taskId,
            hustlerId,
            totalXP,
            levelUp,
            newLevel,
            streak: streakResult.streak.current,
        }, 'Task smart-completed');
        return {
            success: true,
            taskId,
            hustlerId,
            task: completedTask,
            xpAwarded: totalXP,
            xpBreakdown,
            newTotalXP,
            levelUp,
            newLevel,
            payoutEligible,
            payoutAmount,
            streak: streakResult.streak,
            animations,
            message: 'Task completed successfully!',
            celebrationMessage,
        };
    }
    /**
     * Update streak for a hustler
     */
    async updateStreak(hustlerId) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        let data = streakData.get(hustlerId);
        if (!data) {
            // First ever completion
            data = {
                hustlerId,
                currentStreak: 1,
                longestStreak: 1,
                lastCompletionDate: today,
                completionsToday: 1,
                streakHistory: [{ date: today, count: 1 }],
            };
            streakData.set(hustlerId, data);
            return {
                streak: this.toStreakStatus(data),
                bonusAwarded: 0,
            };
        }
        // Check if already completed today
        if (data.lastCompletionDate === today) {
            data.completionsToday += 1;
            return {
                streak: this.toStreakStatus(data),
                bonusAwarded: 0,
            };
        }
        // Check if this continues the streak (completed yesterday)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        let bonusAwarded = 0;
        if (data.lastCompletionDate === yesterdayStr) {
            // Streak continues!
            data.currentStreak += 1;
            data.longestStreak = Math.max(data.longestStreak, data.currentStreak);
            // Check for streak bonus
            const bonus = STREAK_BONUSES.find(b => b.days === data.currentStreak);
            if (bonus) {
                bonusAwarded = bonus.xp;
                await GamificationService.awardXP(hustlerId, bonus.xp, `${data.currentStreak}_day_streak`);
                serviceLogger.info({ hustlerId, streak: data.currentStreak, bonus: bonus.xp }, 'Streak bonus awarded');
            }
        }
        else {
            // Streak broken, reset to 1
            data.currentStreak = 1;
        }
        data.lastCompletionDate = today;
        data.completionsToday = 1;
        data.streakHistory.push({ date: today, count: data.currentStreak });
        // Keep only last 30 days of history
        if (data.streakHistory.length > 30) {
            data.streakHistory = data.streakHistory.slice(-30);
        }
        streakData.set(hustlerId, data);
        return {
            streak: this.toStreakStatus(data),
            bonusAwarded,
        };
    }
    /**
     * Get current streak status for a hustler
     */
    getStreakStatus(hustlerId) {
        const data = streakData.get(hustlerId);
        if (!data) {
            return {
                current: 0,
                isActive: false,
                completedToday: false,
                daysUntilBonus: 3,
                nextBonusAmount: 25,
                longestStreak: 0,
                lastCompletionDate: null,
            };
        }
        return this.toStreakStatus(data);
    }
    /**
     * Get completion history for a hustler
     */
    getCompletionHistory(hustlerId) {
        return completionHistory.get(hustlerId) || [];
    }
    // ============================================
    // Private helpers
    // ============================================
    toStreakStatus(data) {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        const completedToday = data.lastCompletionDate === today;
        const isActive = completedToday || data.lastCompletionDate === yesterdayStr;
        // Find next bonus
        const nextBonus = STREAK_BONUSES.find(b => b.days > data.currentStreak) || STREAK_BONUSES[STREAK_BONUSES.length - 1];
        const daysUntilBonus = nextBonus.days - data.currentStreak;
        return {
            current: isActive ? data.currentStreak : 0,
            isActive,
            completedToday,
            daysUntilBonus: Math.max(0, daysUntilBonus),
            nextBonusAmount: nextBonus.xp,
            longestStreak: data.longestStreak,
            lastCompletionDate: data.lastCompletionDate,
        };
    }
    createFailedResult(taskId, hustlerId, message) {
        return {
            success: false,
            taskId,
            hustlerId,
            task: null,
            xpAwarded: 0,
            xpBreakdown: { base: 0, proofBonus: 0, ratingBonus: 0, streakBonus: 0 },
            newTotalXP: 0,
            levelUp: false,
            newLevel: 0,
            payoutEligible: false,
            payoutAmount: 0,
            streak: {
                current: 0,
                isActive: false,
                completedToday: false,
                daysUntilBonus: 3,
                nextBonusAmount: 25,
                longestStreak: 0,
                lastCompletionDate: null,
            },
            animations: [],
            message,
            celebrationMessage: '',
        };
    }
    buildCelebrationMessage(xp, levelUp, newLevel, streak, rating) {
        const parts = [];
        parts.push(`💰 +${xp} XP earned!`);
        if (levelUp) {
            parts.push(`🎉 LEVEL UP! You're now Level ${newLevel}!`);
        }
        if (streak >= 7) {
            parts.push(`🔥 ${streak}-day streak! Unstoppable!`);
        }
        else if (streak >= 3) {
            parts.push(`🔥 ${streak}-day streak! Keep it going!`);
        }
        if (rating === 5) {
            parts.push(`⭐ Perfect 5-star rating!`);
        }
        return parts.join(' ');
    }
}
export const TaskCompletionService = new TaskCompletionServiceClass();
//# sourceMappingURL=TaskCompletionService.js.map