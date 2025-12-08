/**
 * Social Card Generator
 * 
 * Auto-generate shareable achievement cards.
 * When Hustlers complete tasks or hit milestones, generate social-ready content.
 * 
 * "Task completed! Level 3 unlocked. Earned $58 + 60XP. #HustleXP #SeattleHustler"
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { GamificationService } from './GamificationService.js';
import { DynamicBadgeEngine } from './DynamicBadgeEngine.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Types
// ============================================

export type CardType =
    | 'task_completed'
    | 'level_up'
    | 'badge_unlocked'
    | 'streak_milestone'
    | 'earnings_milestone'
    | 'quest_completed'
    | 'first_task'
    | 'weekly_recap';

export interface SocialCard {
    id: string;
    userId: string;
    type: CardType;

    // Visual
    backgroundColor: string;
    accentColor: string;
    emoji: string;

    // Content
    headline: string;
    subheadline: string;
    stats: { label: string; value: string; icon?: string }[];

    // User info
    userName?: string;
    userLevel?: number;

    // Branding
    hashtags: string[];

    // Sharing
    shareText: string;
    shareUrl: string;

    createdAt: Date;
}

export interface CardGenerationData {
    // Task completion
    taskTitle?: string;
    taskCategory?: TaskCategory;
    earnings?: number;
    xpEarned?: number;
    rating?: number;

    // Level up
    newLevel?: number;
    totalXP?: number;

    // Badge
    badgeName?: string;
    badgeIcon?: string;
    badgeRarity?: string;

    // Streak
    streakDays?: number;
    streakBonus?: number;

    // Earnings milestone
    milestoneAmount?: number;
    period?: string;

    // Quest
    questTitle?: string;
    questXP?: number;

    // Weekly recap
    weeklyTasks?: number;
    weeklyEarnings?: number;
    weeklyXP?: number;
    weeklyStreak?: number;
    topCategory?: TaskCategory;
}

// ============================================
// Card Templates
// ============================================

const CARD_TEMPLATES: Record<CardType, {
    backgroundColor: string;
    accentColor: string;
    emoji: string;
    getHeadline: (data: CardGenerationData) => string;
    getSubheadline: (data: CardGenerationData, userName?: string) => string;
    getStats: (data: CardGenerationData) => SocialCard['stats'];
    getHashtags: (data: CardGenerationData) => string[];
    getShareText: (data: CardGenerationData, userName?: string) => string;
}> = {
    task_completed: {
        backgroundColor: '#1a1a2e',
        accentColor: '#4ade80',
        emoji: '🎉',
        getHeadline: () => 'Task Complete!',
        getSubheadline: (data) => data.taskTitle || 'Another task crushed',
        getStats: (data) => [
            { label: 'Earned', value: `$${data.earnings?.toFixed(0) || 0}`, icon: '💰' },
            { label: 'XP', value: `+${data.xpEarned || 0}`, icon: '⚡' },
            ...(data.rating === 5 ? [{ label: 'Rating', value: '⭐⭐⭐⭐⭐' }] : []),
        ],
        getHashtags: () => ['#HustleXP', '#TaskComplete', '#SeattleHustler'],
        getShareText: (data, userName) =>
            `${userName ? userName + ' just' : 'Just'} completed a task on HustleXP! 💰 $${data.earnings?.toFixed(0) || 0} earned ⚡ +${data.xpEarned || 0} XP`,
    },

    level_up: {
        backgroundColor: '#1e1b4b',
        accentColor: '#a78bfa',
        emoji: '🚀',
        getHeadline: (data) => `Level ${data.newLevel} Unlocked!`,
        getSubheadline: (_, userName) => `${userName || 'Hustler'} is leveling up!`,
        getStats: (data) => [
            { label: 'New Level', value: data.newLevel?.toString() || '?', icon: '🏆' },
            { label: 'Total XP', value: data.totalXP?.toString() || '0', icon: '⚡' },
        ],
        getHashtags: () => ['#LevelUp', '#HustleXP', '#Leveling'],
        getShareText: (data, userName) =>
            `🚀 ${userName || 'I'} just reached Level ${data.newLevel} on HustleXP! ${data.totalXP} XP earned. Keep hustling! 💪`,
    },

    badge_unlocked: {
        backgroundColor: '#1c1917',
        accentColor: '#fbbf24',
        emoji: '🏆',
        getHeadline: (data) => `${data.badgeName || 'Badge'} Unlocked!`,
        getSubheadline: (data) => `${data.badgeRarity || 'Rare'} achievement earned`,
        getStats: (data) => [
            { label: 'Badge', value: data.badgeName || 'Mystery', icon: data.badgeIcon || '🏆' },
            { label: 'Rarity', value: data.badgeRarity || 'Rare', icon: '✨' },
        ],
        getHashtags: (data) => ['#BadgeUnlocked', '#HustleXP', `#${(data.badgeName || 'Badge').replace(/\s+/g, '')}`],
        getShareText: (data, userName) =>
            `${data.badgeIcon || '🏆'} ${userName || 'New'} badge unlocked: ${data.badgeName}! ${data.badgeRarity || 'Rare'} achievement on HustleXP. #BadgeUnlocked`,
    },

    streak_milestone: {
        backgroundColor: '#7c2d12',
        accentColor: '#fb923c',
        emoji: '🔥',
        getHeadline: (data) => `${data.streakDays}-Day Streak!`,
        getSubheadline: () => 'Consistency is key',
        getStats: (data) => [
            { label: 'Streak', value: `${data.streakDays} days`, icon: '🔥' },
            { label: 'Bonus XP', value: `+${data.streakBonus || 0}`, icon: '⚡' },
        ],
        getHashtags: (data) => ['#StreakMaster', '#HustleXP', `#${data.streakDays}DayStreak`],
        getShareText: (data, userName) =>
            `🔥 ${data.streakDays}-day streak on HustleXP! ${userName || 'I'} earned +${data.streakBonus || 0} XP bonus. Never miss a day! #StreakMaster`,
    },

    earnings_milestone: {
        backgroundColor: '#14532d',
        accentColor: '#86efac',
        emoji: '💰',
        getHeadline: (data) => `$${data.milestoneAmount} Earned!`,
        getSubheadline: (data) => data.period || 'Major milestone',
        getStats: (data) => [
            { label: 'Earned', value: `$${data.milestoneAmount}`, icon: '💰' },
            { label: 'Period', value: data.period || 'Total', icon: '📊' },
        ],
        getHashtags: (data) => ['#Earnings', '#HustleXP', `#$${data.milestoneAmount}Club`],
        getShareText: (data, userName) =>
            `💰 $${data.milestoneAmount} ${data.period || 'total'} on HustleXP! ${userName || 'I'} hustle pays off. #EarningsGoals`,
    },

    quest_completed: {
        backgroundColor: '#164e63',
        accentColor: '#22d3ee',
        emoji: '🎯',
        getHeadline: (data) => 'Quest Complete!',
        getSubheadline: (data) => data.questTitle || 'Challenge conquered',
        getStats: (data) => [
            { label: 'Quest', value: data.questTitle || 'Challenge', icon: '🎯' },
            { label: 'XP Reward', value: `+${data.questXP || 0}`, icon: '⚡' },
        ],
        getHashtags: () => ['#QuestComplete', '#HustleXP', '#Challenge'],
        getShareText: (data, userName) =>
            `🎯 Quest complete: "${data.questTitle}"! ${userName || 'I'} earned +${data.questXP || 0} XP on HustleXP. #QuestComplete`,
    },

    first_task: {
        backgroundColor: '#312e81',
        accentColor: '#c4b5fd',
        emoji: '🌟',
        getHeadline: () => 'First Task Complete!',
        getSubheadline: () => 'The hustle begins...',
        getStats: (data) => [
            { label: 'Earned', value: `$${data.earnings?.toFixed(0) || 0}`, icon: '💰' },
            { label: 'XP', value: `+${data.xpEarned || 0}`, icon: '⚡' },
            { label: 'Status', value: 'Hustler', icon: '🚀' },
        ],
        getHashtags: () => ['#FirstTask', '#HustleXP', '#NewHustler', '#Seattle'],
        getShareText: (data, userName) =>
            `🌟 ${userName || 'I'} just completed my first task on HustleXP! $${data.earnings?.toFixed(0) || 0} earned. The hustle is real! #FirstTask #SeattleHustler`,
    },

    weekly_recap: {
        backgroundColor: '#1f2937',
        accentColor: '#60a5fa',
        emoji: '📊',
        getHeadline: () => 'Weekly Hustle Recap',
        getSubheadline: () => 'Your week in numbers',
        getStats: (data) => [
            { label: 'Tasks', value: data.weeklyTasks?.toString() || '0', icon: '✅' },
            { label: 'Earned', value: `$${data.weeklyEarnings?.toFixed(0) || 0}`, icon: '💰' },
            { label: 'XP', value: `+${data.weeklyXP || 0}`, icon: '⚡' },
            ...(data.weeklyStreak ? [{ label: 'Streak', value: `${data.weeklyStreak} days`, icon: '🔥' }] : []),
        ],
        getHashtags: () => ['#WeeklyRecap', '#HustleXP', '#WeekInReview'],
        getShareText: (data, userName) =>
            `📊 ${userName || 'My'} HustleXP weekly recap: ✅ ${data.weeklyTasks} tasks | 💰 $${data.weeklyEarnings?.toFixed(0)} earned | ⚡ +${data.weeklyXP} XP ${data.weeklyStreak ? `| 🔥 ${data.weeklyStreak} day streak` : ''} #WeeklyRecap`,
    },
};

// ============================================
// Card Store (in production, persist to DB)
// ============================================

const cardStore = new Map<string, SocialCard>();
const userCards = new Map<string, string[]>(); // userId -> cardIds

// ============================================
// Social Card Generator Service
// ============================================

class SocialCardGeneratorClass {
    /**
     * Generate a shareable social card
     */
    generateCard(
        userId: string,
        type: CardType,
        data: CardGenerationData,
        userName?: string
    ): SocialCard {
        const template = CARD_TEMPLATES[type];

        if (!template) {
            throw new Error(`Unknown card type: ${type}`);
        }

        const card: SocialCard = {
            id: uuidv4(),
            userId,
            type,
            backgroundColor: template.backgroundColor,
            accentColor: template.accentColor,
            emoji: template.emoji,
            headline: template.getHeadline(data),
            subheadline: template.getSubheadline(data, userName),
            stats: template.getStats(data),
            userName,
            userLevel: data.newLevel,
            hashtags: template.getHashtags(data),
            shareText: template.getShareText(data, userName),
            shareUrl: `https://hustlexp.com/share/${userId}`,
            createdAt: new Date(),
        };

        // Store card
        cardStore.set(card.id, card);

        // Track user's cards
        const userCardList = userCards.get(userId) || [];
        userCardList.push(card.id);
        userCards.set(userId, userCardList);

        serviceLogger.info({ userId, type, cardId: card.id }, 'Social card generated');

        return card;
    }

    /**
     * Get a card by ID
     */
    getCard(cardId: string): SocialCard | null {
        return cardStore.get(cardId) || null;
    }

    /**
     * Get recent cards for a user
     */
    getRecentCards(userId: string, limit: number = 10): SocialCard[] {
        const cardIds = userCards.get(userId) || [];

        return cardIds
            .slice(-limit)
            .reverse()
            .map(id => cardStore.get(id))
            .filter((card): card is SocialCard => card !== null);
    }

    /**
     * Generate weekly recap card
     */
    generateWeeklyRecap(
        userId: string,
        data: {
            tasks: number;
            earnings: number;
            xp: number;
            streak: number;
            topCategory?: TaskCategory;
        },
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'weekly_recap', {
            weeklyTasks: data.tasks,
            weeklyEarnings: data.earnings,
            weeklyXP: data.xp,
            weeklyStreak: data.streak,
            topCategory: data.topCategory,
        }, userName);
    }

    /**
     * Generate task completion card
     */
    generateTaskCompletedCard(
        userId: string,
        data: {
            taskTitle: string;
            category: TaskCategory;
            earnings: number;
            xp: number;
            rating?: number;
        },
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'task_completed', {
            taskTitle: data.taskTitle,
            taskCategory: data.category,
            earnings: data.earnings,
            xpEarned: data.xp,
            rating: data.rating,
        }, userName);
    }

    /**
     * Generate level up card
     */
    generateLevelUpCard(
        userId: string,
        newLevel: number,
        totalXP: number,
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'level_up', {
            newLevel,
            totalXP,
        }, userName);
    }

    /**
     * Generate badge unlocked card
     */
    generateBadgeCard(
        userId: string,
        badgeName: string,
        badgeIcon: string,
        badgeRarity: string,
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'badge_unlocked', {
            badgeName,
            badgeIcon,
            badgeRarity,
        }, userName);
    }

    /**
     * Generate streak milestone card
     */
    generateStreakCard(
        userId: string,
        streakDays: number,
        bonusXP: number,
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'streak_milestone', {
            streakDays,
            streakBonus: bonusXP,
        }, userName);
    }

    /**
     * Generate earnings milestone card
     */
    generateEarningsCard(
        userId: string,
        amount: number,
        period: string,
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'earnings_milestone', {
            milestoneAmount: amount,
            period,
        }, userName);
    }

    /**
     * Generate quest completed card
     */
    generateQuestCard(
        userId: string,
        questTitle: string,
        xpReward: number,
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'quest_completed', {
            questTitle,
            questXP: xpReward,
        }, userName);
    }

    /**
     * Generate first task card
     */
    generateFirstTaskCard(
        userId: string,
        earnings: number,
        xp: number,
        userName?: string
    ): SocialCard {
        return this.generateCard(userId, 'first_task', {
            earnings,
            xpEarned: xp,
        }, userName);
    }

    /**
     * Get shareable text for a platform
     */
    getShareTextForPlatform(
        card: SocialCard,
        platform: 'twitter' | 'instagram' | 'tiktok' | 'sms'
    ): string {
        let text = card.shareText;

        switch (platform) {
            case 'twitter':
                // Add hashtags, keep under 280 chars
                const twitterTags = card.hashtags.slice(0, 3).join(' ');
                text = `${text} ${twitterTags}`.slice(0, 280);
                break;

            case 'instagram':
                // More hashtags for IG
                text = `${text}\n\n${card.hashtags.join(' ')} #hustle #gig #seattle`;
                break;

            case 'tiktok':
                // Short and punchy
                text = `${card.emoji} ${card.headline} ${card.hashtags[0]}`;
                break;

            case 'sms':
                // Clean for texting
                text = `${card.headline} - ${card.subheadline}. Check it out: ${card.shareUrl}`;
                break;
        }

        return text;
    }

    /**
     * Get ASCII art representation of card (for console/logs)
     */
    getCardAscii(card: SocialCard): string {
        const line = '─'.repeat(40);
        const stats = card.stats.map(s => `${s.icon || '•'} ${s.label}: ${s.value}`).join('\n');
        const tags = card.hashtags.join(' ');

        return `
╔══════════════════════════════════════════╗
║ ${card.emoji} ${card.headline.padEnd(38)}║
╠══════════════════════════════════════════╣
║ ${card.subheadline.padEnd(40)}║
╠──────────────────────────────────────────╣
${stats.split('\n').map(s => `║ ${s.padEnd(40)}║`).join('\n')}
╠──────────────────────────────────────────╣
║ ${tags.slice(0, 40).padEnd(40)}║
╚══════════════════════════════════════════╝
`;
    }

    /**
     * Check for milestone and auto-generate cards
     */
    checkAndGenerateMilestoneCards(
        userId: string,
        currentEarnings: number,
        previousEarnings: number,
        userName?: string
    ): SocialCard[] {
        const cards: SocialCard[] = [];
        const milestones = [100, 500, 1000, 2500, 5000];

        for (const milestone of milestones) {
            if (previousEarnings < milestone && currentEarnings >= milestone) {
                cards.push(this.generateEarningsCard(userId, milestone, 'Total', userName));
            }
        }

        return cards;
    }
}

export const SocialCardGenerator = new SocialCardGeneratorClass();
