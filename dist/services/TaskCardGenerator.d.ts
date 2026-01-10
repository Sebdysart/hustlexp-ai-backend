import type { TaskCategory } from '../types/index.js';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type ExperienceLevel = 'none' | 'some' | 'experienced';
export type SafetyRating = 'safe' | 'caution' | 'requires_verification';
export interface PriceBreakdown {
    min: number;
    recommended: number;
    max: number;
    hourlyEquivalent: number;
    surgeApplied: boolean;
    originalRecommended?: number;
}
export interface GamificationData {
    baseXP: number;
    bonusXP: number;
    totalXP: number;
    streakMultiplier: number;
    streakText: string | null;
    categoryProgress: {
        current: number;
        max: number;
        badge: string;
    };
    potentialBadges: string[];
    doubleXPEligible: boolean;
    doubleXPReason: string | null;
}
export interface SeattleContext {
    surgeFactor: number;
    surgeReason: string | null;
    surgePercent: number;
    weatherWarning: string | null;
    trafficNote: string | null;
    eventNote: string | null;
    recommendedTiming: string | null;
    hotspotBonus: boolean;
    areaInsights: string | null;
}
export interface SocialProof {
    nearbyHustlers: number;
    completedSimilar: number;
    avgRating: number;
    successRate: number;
    popularityText: string;
}
export interface PriorityTags {
    tags: string[];
    matchScore: number;
    isRecommended: boolean;
}
export interface EnrichedTaskCard {
    id: string;
    title: string;
    description: string;
    originalInput: string;
    category: TaskCategory;
    categoryIcon: string;
    location: string;
    locationShort: string;
    durationMinutes: number;
    durationText: string;
    scheduledTime: string | null;
    difficulty: Difficulty;
    difficultyColor: string;
    experienceLevel: ExperienceLevel;
    levelRequired: number;
    equipment: string[];
    safetyRating: SafetyRating;
    safetyNotes: string[];
    price: PriceBreakdown;
    instantPayout: boolean;
    gamification: GamificationData;
    seattle: SeattleContext;
    socialProof: SocialProof;
    priorityTags: PriorityTags;
    visualHints: {
        gradientColors: [string, string];
        glowColor: string;
        badges: string[];
        animations: string[];
        urgencyLevel: 'low' | 'medium' | 'high';
    };
    createdAt: Date;
    expiresAt: Date | null;
}
declare class TaskCardGeneratorClass {
    /**
     * Generate a fully enriched task card from minimal input
     */
    generateCard(input: {
        rawText: string;
        location?: string;
        categoryHint?: TaskCategory;
        scheduledTime?: string;
        userId?: string;
        userLevel?: number;
        userStreak?: number;
        userCategoryCount?: number;
    }): Promise<EnrichedTaskCard>;
    /**
     * Enrich task using AI
     */
    private enrichTask;
    /**
     * Calculate Seattle-specific context
     */
    private calculateSeattleContext;
    /**
     * Calculate pricing with surge
     */
    private calculatePrice;
    /**
     * Calculate gamification elements
     */
    private calculateGamification;
    /**
     * Generate social proof
     */
    private generateSocialProof;
    /**
     * Generate priority tags for matching
     */
    private generatePriorityTags;
    /**
     * Calculate visual hints for frontend
     */
    private calculateVisualHints;
    /**
     * Calculate level required
     */
    private calculateLevelRequired;
    /**
     * Calculate safety rating
     */
    private calculateSafetyRating;
    /**
     * Generate fallback title
     */
    private generateFallbackTitle;
    /**
     * Shorten location for display
     */
    private shortenLocation;
}
export declare const TaskCardGenerator: TaskCardGeneratorClass;
export {};
//# sourceMappingURL=TaskCardGenerator.d.ts.map