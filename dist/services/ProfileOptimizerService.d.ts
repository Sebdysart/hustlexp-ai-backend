/**
 * Profile Optimizer Service
 *
 * AI-powered profile improvement suggestions.
 * "Add 3 photos and unlock Verified Pro badge"
 * "Your headline is weak—suggestion: Furniture Assembly + IKEA Expert"
 */
import type { TaskCategory } from '../types/index.js';
export type ProfileType = 'hustler' | 'poster';
export interface ProfileScore {
    userId: string;
    profileType: ProfileType;
    overall: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    components: {
        photo: {
            score: number;
            maxScore: number;
            hasItem: boolean;
        };
        bio: {
            score: number;
            maxScore: number;
            hasItem: boolean;
        };
        skills: {
            score: number;
            maxScore: number;
            count: number;
        };
        availability: {
            score: number;
            maxScore: number;
            isSet: boolean;
        };
        verification: {
            score: number;
            maxScore: number;
            level: string;
        };
        reputation: {
            score: number;
            maxScore: number;
            rating: number;
        };
    };
    suggestions: ProfileSuggestion[];
    matchRateIncrease: number;
    earningsIncrease: number;
    nextUnlock?: {
        name: string;
        requirement: string;
        progress: number;
    };
}
export interface ProfileSuggestion {
    id: string;
    priority: 'high' | 'medium' | 'low';
    type: 'photo' | 'bio' | 'skills' | 'availability' | 'verification' | 'headline';
    title: string;
    description: string;
    impact: string;
    xpReward: number;
    completed: boolean;
}
export interface ProfileData {
    userId: string;
    profileType: ProfileType;
    displayName?: string;
    headline?: string;
    bio?: string;
    photoUrl?: string;
    photoCount: number;
    skills: string[];
    categories: TaskCategory[];
    availabilitySet: boolean;
    availableNow: boolean;
    emailVerified: boolean;
    phoneVerified: boolean;
    backgroundCheck: boolean;
    rating: number;
    reviewCount: number;
    tasksCompleted: number;
    level: number;
    locationSet: boolean;
    city?: string;
}
declare class ProfileOptimizerServiceClass {
    /**
     * Get or create mock profile data
     */
    private getProfileData;
    /**
     * Update profile data
     */
    updateProfileData(userId: string, updates: Partial<ProfileData>): ProfileData;
    /**
     * Calculate full profile score
     */
    getProfileScore(userId: string): ProfileScore;
    /**
     * Get just the suggestions
     */
    getProfileSuggestions(userId: string): ProfileSuggestion[];
    /**
     * Generate an AI-powered bio
     */
    generateBioSuggestion(userId: string, context?: {
        currentBio?: string;
        skills?: string[];
        topCategories?: TaskCategory[];
        personality?: string;
    }): Promise<{
        bio: string;
        alternatives: string[];
    }>;
    /**
     * Generate an AI-powered headline
     */
    generateHeadlineSuggestion(userId: string, context?: {
        currentHeadline?: string;
        skills?: string[];
        specialty?: string;
    }): Promise<{
        headline: string;
        alternatives: string[];
    }>;
    /**
     * Get skill recommendations based on demand
     */
    getSkillRecommendations(userId: string): {
        recommended: {
            skill: string;
            demand: 'high' | 'medium';
            avgPay: number;
        }[];
        currentSkills: string[];
    };
    /**
     * Predict earnings impact of profile changes
     */
    predictEarningsImpact(userId: string, changes: Partial<ProfileData>): {
        currentWeeklyEstimate: number;
        improvedWeeklyEstimate: number;
        increase: number;
        increasePercent: number;
        breakdown: string[];
    };
    private calculateVerificationScore;
    private getVerificationLevel;
    private calculateReputationScore;
    private getGrade;
    private generateSuggestions;
    private getNextUnlock;
}
export declare const ProfileOptimizerService: ProfileOptimizerServiceClass;
export {};
//# sourceMappingURL=ProfileOptimizerService.d.ts.map