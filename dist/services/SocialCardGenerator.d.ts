/**
 * Social Card Generator
 *
 * Auto-generate shareable achievement cards.
 * When Hustlers complete tasks or hit milestones, generate social-ready content.
 *
 * "Task completed! Level 3 unlocked. Earned $58 + 60XP. #HustleXP #SeattleHustler"
 */
import type { TaskCategory } from '../types/index.js';
export type CardType = 'task_completed' | 'level_up' | 'badge_unlocked' | 'streak_milestone' | 'earnings_milestone' | 'quest_completed' | 'first_task' | 'weekly_recap';
export interface SocialCard {
    id: string;
    userId: string;
    type: CardType;
    backgroundColor: string;
    accentColor: string;
    emoji: string;
    headline: string;
    subheadline: string;
    stats: {
        label: string;
        value: string;
        icon?: string;
    }[];
    userName?: string;
    userLevel?: number;
    hashtags: string[];
    shareText: string;
    shareUrl: string;
    createdAt: Date;
}
export interface CardGenerationData {
    taskTitle?: string;
    taskCategory?: TaskCategory;
    earnings?: number;
    xpEarned?: number;
    rating?: number;
    newLevel?: number;
    totalXP?: number;
    badgeName?: string;
    badgeIcon?: string;
    badgeRarity?: string;
    streakDays?: number;
    streakBonus?: number;
    milestoneAmount?: number;
    period?: string;
    questTitle?: string;
    questXP?: number;
    weeklyTasks?: number;
    weeklyEarnings?: number;
    weeklyXP?: number;
    weeklyStreak?: number;
    topCategory?: TaskCategory;
}
declare class SocialCardGeneratorClass {
    /**
     * Generate a shareable social card
     */
    generateCard(userId: string, type: CardType, data: CardGenerationData, userName?: string): SocialCard;
    /**
     * Get a card by ID
     */
    getCard(cardId: string): SocialCard | null;
    /**
     * Get recent cards for a user
     */
    getRecentCards(userId: string, limit?: number): SocialCard[];
    /**
     * Generate weekly recap card
     */
    generateWeeklyRecap(userId: string, data: {
        tasks: number;
        earnings: number;
        xp: number;
        streak: number;
        topCategory?: TaskCategory;
    }, userName?: string): SocialCard;
    /**
     * Generate task completion card
     */
    generateTaskCompletedCard(userId: string, data: {
        taskTitle: string;
        category: TaskCategory;
        earnings: number;
        xp: number;
        rating?: number;
    }, userName?: string): SocialCard;
    /**
     * Generate level up card
     */
    generateLevelUpCard(userId: string, newLevel: number, totalXP: number, userName?: string): SocialCard;
    /**
     * Generate badge unlocked card
     */
    generateBadgeCard(userId: string, badgeName: string, badgeIcon: string, badgeRarity: string, userName?: string): SocialCard;
    /**
     * Generate streak milestone card
     */
    generateStreakCard(userId: string, streakDays: number, bonusXP: number, userName?: string): SocialCard;
    /**
     * Generate earnings milestone card
     */
    generateEarningsCard(userId: string, amount: number, period: string, userName?: string): SocialCard;
    /**
     * Generate quest completed card
     */
    generateQuestCard(userId: string, questTitle: string, xpReward: number, userName?: string): SocialCard;
    /**
     * Generate first task card
     */
    generateFirstTaskCard(userId: string, earnings: number, xp: number, userName?: string): SocialCard;
    /**
     * Get shareable text for a platform
     */
    getShareTextForPlatform(card: SocialCard, platform: 'twitter' | 'instagram' | 'tiktok' | 'sms'): string;
    /**
     * Get ASCII art representation of card (for console/logs)
     */
    getCardAscii(card: SocialCard): string;
    /**
     * Check for milestone and auto-generate cards
     */
    checkAndGenerateMilestoneCards(userId: string, currentEarnings: number, previousEarnings: number, userName?: string): SocialCard[];
}
export declare const SocialCardGenerator: SocialCardGeneratorClass;
export {};
//# sourceMappingURL=SocialCardGenerator.d.ts.map