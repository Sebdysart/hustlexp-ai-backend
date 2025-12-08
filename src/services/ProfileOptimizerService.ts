/**
 * Profile Optimizer Service
 * 
 * AI-powered profile improvement suggestions.
 * "Add 3 photos and unlock Verified Pro badge"
 * "Your headline is weak—suggestion: Furniture Assembly + IKEA Expert"
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
import type { TaskCategory, HustlerProfile } from '../types/index.js';

// ============================================
// Types
// ============================================

export type ProfileType = 'hustler' | 'poster';

export interface ProfileScore {
    userId: string;
    profileType: ProfileType;
    overall: number; // 0-100
    grade: 'A' | 'B' | 'C' | 'D' | 'F';

    // Components
    components: {
        photo: { score: number; maxScore: number; hasItem: boolean };
        bio: { score: number; maxScore: number; hasItem: boolean };
        skills: { score: number; maxScore: number; count: number };
        availability: { score: number; maxScore: number; isSet: boolean };
        verification: { score: number; maxScore: number; level: string };
        reputation: { score: number; maxScore: number; rating: number };
    };

    // Improvement suggestions
    suggestions: ProfileSuggestion[];

    // Predicted improvements
    matchRateIncrease: number;  // percentage
    earningsIncrease: number;   // dollar amount per week

    // Next unlock
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

    // Basic info
    displayName?: string;
    headline?: string;
    bio?: string;
    photoUrl?: string;
    photoCount: number;

    // Skills & Categories (hustlers)
    skills: string[];
    categories: TaskCategory[];

    // Availability
    availabilitySet: boolean;
    availableNow: boolean;

    // Verification
    emailVerified: boolean;
    phoneVerified: boolean;
    backgroundCheck: boolean;

    // Reputation
    rating: number;
    reviewCount: number;
    tasksCompleted: number;
    level: number;

    // Location
    locationSet: boolean;
    city?: string;
}

// ============================================
// Profile Data Store (in production, from DB)
// ============================================

const profileDataStore = new Map<string, ProfileData>();

// ============================================
// Profile Optimizer Service
// ============================================

class ProfileOptimizerServiceClass {
    /**
     * Get or create mock profile data
     */
    private getProfileData(userId: string, profileType: ProfileType = 'hustler'): ProfileData {
        if (!profileDataStore.has(userId)) {
            profileDataStore.set(userId, {
                userId,
                profileType,
                displayName: undefined,
                headline: undefined,
                bio: undefined,
                photoUrl: undefined,
                photoCount: 0,
                skills: [],
                categories: [],
                availabilitySet: false,
                availableNow: false,
                emailVerified: true,
                phoneVerified: false,
                backgroundCheck: false,
                rating: 0,
                reviewCount: 0,
                tasksCompleted: 0,
                level: 1,
                locationSet: false,
            });
        }
        return profileDataStore.get(userId)!;
    }

    /**
     * Update profile data
     */
    updateProfileData(userId: string, updates: Partial<ProfileData>): ProfileData {
        const data = this.getProfileData(userId);
        Object.assign(data, updates);
        profileDataStore.set(userId, data);
        return data;
    }

    /**
     * Calculate full profile score
     */
    getProfileScore(userId: string): ProfileScore {
        const data = this.getProfileData(userId);

        // Calculate component scores
        const components = {
            photo: {
                score: data.photoUrl ? 20 : 0,
                maxScore: 20,
                hasItem: !!data.photoUrl,
            },
            bio: {
                score: data.bio ? Math.min(20, Math.floor((data.bio.length / 150) * 20)) : 0,
                maxScore: 20,
                hasItem: !!data.bio && data.bio.length > 0,
            },
            skills: {
                score: Math.min(15, data.skills.length * 3),
                maxScore: 15,
                count: data.skills.length,
            },
            availability: {
                score: data.availabilitySet ? 15 : 0,
                maxScore: 15,
                isSet: data.availabilitySet,
            },
            verification: {
                score: this.calculateVerificationScore(data),
                maxScore: 15,
                level: this.getVerificationLevel(data),
            },
            reputation: {
                score: this.calculateReputationScore(data),
                maxScore: 15,
                rating: data.rating,
            },
        };

        // Calculate overall score
        const overall = Object.values(components).reduce((sum, c) => sum + c.score, 0);
        const grade = this.getGrade(overall);

        // Generate suggestions
        const suggestions = this.generateSuggestions(data, components);

        // Calculate potential improvements
        const matchRateIncrease = Math.round((100 - overall) * 0.8);
        const earningsIncrease = Math.round((100 - overall) * 2);

        // Find next unlock
        const nextUnlock = this.getNextUnlock(data, overall);

        return {
            userId,
            profileType: data.profileType,
            overall,
            grade,
            components,
            suggestions,
            matchRateIncrease,
            earningsIncrease,
            nextUnlock,
        };
    }

    /**
     * Get just the suggestions
     */
    getProfileSuggestions(userId: string): ProfileSuggestion[] {
        const score = this.getProfileScore(userId);
        return score.suggestions;
    }

    /**
     * Generate an AI-powered bio
     */
    async generateBioSuggestion(
        userId: string,
        context?: {
            currentBio?: string;
            skills?: string[];
            topCategories?: TaskCategory[];
            personality?: string;
        }
    ): Promise<{ bio: string; alternatives: string[] }> {
        const data = this.getProfileData(userId);
        const skills = context?.skills || data.skills;
        const categories = context?.topCategories || data.categories;

        try {
            const result = await routedGenerate('small_aux', {
                system: `You are a profile bio writer for HustleXP, a gig marketplace app in Seattle.
Write short, punchy, professional bios that highlight skills and personality.
Keep bios under 150 characters. Be friendly but professional.

Return JSON:
{
    "bio": "main bio suggestion",
    "alternatives": ["alternative 1", "alternative 2"]
}`,
                messages: [{
                    role: 'user',
                    content: `Write a bio for a hustler with these traits:
- Skills: ${skills.join(', ') || 'various'}
- Top categories: ${categories.join(', ') || 'general tasks'}
- Current bio: "${context?.currentBio || 'none'}"
- Personality: ${context?.personality || 'friendly and reliable'}

Make it catchy and Seattle-appropriate!`,
                }],
                json: true,
                maxTokens: 256,
            });

            const parsed = JSON.parse(result.content);
            serviceLogger.debug({ userId }, 'Generated bio suggestions');

            return {
                bio: parsed.bio,
                alternatives: parsed.alternatives || [],
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to generate bio');

            // Fallback bio
            const skillText = skills.length > 0 ? skills.slice(0, 2).join(' & ') : 'various tasks';
            return {
                bio: `Seattle local ready to help with ${skillText}. Fast, reliable, and friendly! 🚀`,
                alternatives: [
                    `Your go-to helper for ${skillText} in Seattle. Let's get it done! ✨`,
                    `${skillText.charAt(0).toUpperCase() + skillText.slice(1)} pro. Seattle born. Always on time. 💪`,
                ],
            };
        }
    }

    /**
     * Generate an AI-powered headline
     */
    async generateHeadlineSuggestion(
        userId: string,
        context?: {
            currentHeadline?: string;
            skills?: string[];
            specialty?: string;
        }
    ): Promise<{ headline: string; alternatives: string[] }> {
        const data = this.getProfileData(userId);
        const skills = context?.skills || data.skills;

        try {
            const result = await routedGenerate('small_aux', {
                system: `You are a profile headline writer for HustleXP.
Write short, catchy headlines that appear under someone's name.
Keep headlines under 50 characters. Use keywords that attract clients.

Return JSON:
{
    "headline": "main headline",
    "alternatives": ["alt 1", "alt 2"] 
}`,
                messages: [{
                    role: 'user',
                    content: `Write a headline for:
- Skills: ${skills.join(', ') || 'general'}
- Specialty: ${context?.specialty || skills[0] || 'helping out'}
- Current headline: "${context?.currentHeadline || 'none'}"`,
                }],
                json: true,
                maxTokens: 200,
            });

            const parsed = JSON.parse(result.content);
            return {
                headline: parsed.headline,
                alternatives: parsed.alternatives || [],
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to generate headline');

            // Fallback headlines
            const skill = skills[0] || 'Tasks';
            return {
                headline: `${skill} Pro | Fast & Reliable`,
                alternatives: [
                    `Seattle ${skill} Expert`,
                    `${skill} Specialist | 5★ Rated`,
                ],
            };
        }
    }

    /**
     * Get skill recommendations based on demand
     */
    getSkillRecommendations(userId: string): {
        recommended: { skill: string; demand: 'high' | 'medium'; avgPay: number }[];
        currentSkills: string[];
    } {
        const data = this.getProfileData(userId);

        // High demand skills in Seattle (hardcoded for now)
        const highDemandSkills = [
            { skill: 'IKEA Assembly', demand: 'high' as const, avgPay: 55 },
            { skill: 'Pet Sitting', demand: 'high' as const, avgPay: 45 },
            { skill: 'Deep Cleaning', demand: 'high' as const, avgPay: 80 },
            { skill: 'Moving Help', demand: 'high' as const, avgPay: 75 },
            { skill: 'Grocery Delivery', demand: 'medium' as const, avgPay: 30 },
            { skill: 'Tech Support', demand: 'medium' as const, avgPay: 50 },
            { skill: 'Yard Work', demand: 'medium' as const, avgPay: 45 },
            { skill: 'Dog Walking', demand: 'high' as const, avgPay: 25 },
        ];

        // Filter out skills user already has
        const recommended = highDemandSkills.filter(
            s => !data.skills.some(us => us.toLowerCase().includes(s.skill.toLowerCase()))
        ).slice(0, 5);

        return {
            recommended,
            currentSkills: data.skills,
        };
    }

    /**
     * Predict earnings impact of profile changes
     */
    predictEarningsImpact(
        userId: string,
        changes: Partial<ProfileData>
    ): {
        currentWeeklyEstimate: number;
        improvedWeeklyEstimate: number;
        increase: number;
        increasePercent: number;
        breakdown: string[];
    } {
        const data = this.getProfileData(userId);
        const currentScore = this.getProfileScore(userId);

        // Simulate changes
        const simulatedData = { ...data, ...changes };
        profileDataStore.set(`temp_${userId}`, simulatedData);
        const improvedScore = this.getProfileScore(`temp_${userId}`);
        profileDataStore.delete(`temp_${userId}`);

        // Estimate earnings based on profile score and activity
        const baseWeekly = 200; // Assume base earnings
        const currentMultiplier = 1 + (currentScore.overall / 200);
        const improvedMultiplier = 1 + (improvedScore.overall / 200);

        const currentWeeklyEstimate = Math.round(baseWeekly * currentMultiplier);
        const improvedWeeklyEstimate = Math.round(baseWeekly * improvedMultiplier);
        const increase = improvedWeeklyEstimate - currentWeeklyEstimate;
        const increasePercent = Math.round((increase / currentWeeklyEstimate) * 100);

        // Generate breakdown
        const breakdown: string[] = [];
        if (changes.photoUrl && !data.photoUrl) {
            breakdown.push('Profile photo: +30% more task offers');
        }
        if (changes.bio && !data.bio) {
            breakdown.push('Bio: +20% client trust');
        }
        if (changes.skills && changes.skills.length > data.skills.length) {
            breakdown.push('More skills: +40% match rate');
        }
        if (changes.availabilitySet && !data.availabilitySet) {
            breakdown.push('Availability: +25% priority notifications');
        }

        return {
            currentWeeklyEstimate,
            improvedWeeklyEstimate,
            increase,
            increasePercent,
            breakdown,
        };
    }

    // ============================================
    // Helper Methods
    // ============================================

    private calculateVerificationScore(data: ProfileData): number {
        let score = 0;
        if (data.emailVerified) score += 5;
        if (data.phoneVerified) score += 5;
        if (data.backgroundCheck) score += 5;
        return score;
    }

    private getVerificationLevel(data: ProfileData): string {
        if (data.backgroundCheck) return 'Background Checked';
        if (data.phoneVerified) return 'Phone Verified';
        if (data.emailVerified) return 'Email Verified';
        return 'Unverified';
    }

    private calculateReputationScore(data: ProfileData): number {
        if (data.reviewCount === 0) return 0;

        // Score based on rating and review count
        const ratingScore = (data.rating / 5) * 10;
        const reviewScore = Math.min(5, data.reviewCount / 10);

        return Math.round(ratingScore + reviewScore);
    }

    private getGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
        if (score >= 90) return 'A';
        if (score >= 80) return 'B';
        if (score >= 70) return 'C';
        if (score >= 60) return 'D';
        return 'F';
    }

    private generateSuggestions(
        data: ProfileData,
        components: ProfileScore['components']
    ): ProfileSuggestion[] {
        const suggestions: ProfileSuggestion[] = [];

        // Photo suggestion
        if (!components.photo.hasItem) {
            suggestions.push({
                id: 'add_photo',
                priority: 'high',
                type: 'photo',
                title: 'Add a Profile Photo',
                description: 'Profiles with photos get 60% more task offers.',
                impact: '+60% matches',
                xpReward: 50,
                completed: false,
            });
        }

        // Bio suggestion
        if (!components.bio.hasItem) {
            suggestions.push({
                id: 'add_bio',
                priority: 'high',
                type: 'bio',
                title: 'Write Your Bio',
                description: 'Tell clients about yourself and your experience.',
                impact: '+40% trust',
                xpReward: 30,
                completed: false,
            });
        } else if (data.bio && data.bio.length < 100) {
            suggestions.push({
                id: 'expand_bio',
                priority: 'medium',
                type: 'bio',
                title: 'Expand Your Bio',
                description: 'Longer bios with details perform better.',
                impact: '+15% trust',
                xpReward: 15,
                completed: false,
            });
        }

        // Skills suggestion
        if (components.skills.count < 3) {
            suggestions.push({
                id: 'add_skills',
                priority: 'high',
                type: 'skills',
                title: `Add ${3 - components.skills.count} More Skills`,
                description: 'More skills = more task matches.',
                impact: '+50% matches',
                xpReward: 25,
                completed: false,
            });
        }

        // Availability suggestion
        if (!components.availability.isSet) {
            suggestions.push({
                id: 'set_availability',
                priority: 'medium',
                type: 'availability',
                title: 'Set Your Availability',
                description: 'Get notified about tasks that fit your schedule.',
                impact: '+25% relevant tasks',
                xpReward: 20,
                completed: false,
            });
        }

        // Verification suggestion
        if (!data.phoneVerified) {
            suggestions.push({
                id: 'verify_phone',
                priority: 'medium',
                type: 'verification',
                title: 'Verify Your Phone',
                description: 'Verified hustlers get priority in search results.',
                impact: '+30% visibility',
                xpReward: 40,
                completed: false,
            });
        }

        // Headline suggestion
        if (!data.headline) {
            suggestions.push({
                id: 'add_headline',
                priority: 'medium',
                type: 'headline',
                title: 'Add a Catchy Headline',
                description: 'Stand out with a memorable profile headline.',
                impact: '+20% clicks',
                xpReward: 15,
                completed: false,
            });
        }

        // Sort by priority
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

        return suggestions;
    }

    private getNextUnlock(data: ProfileData, score: number): ProfileScore['nextUnlock'] | undefined {
        if (score < 50) {
            return {
                name: 'Basic Badge',
                requirement: 'Complete 50% of your profile',
                progress: Math.round(score / 50 * 100),
            };
        }

        if (score < 80) {
            return {
                name: 'Verified Pro Badge',
                requirement: 'Complete 80% of your profile',
                progress: Math.round(score / 80 * 100),
            };
        }

        if (!data.backgroundCheck) {
            return {
                name: 'Background Checked Badge',
                requirement: 'Complete background verification',
                progress: 0,
            };
        }

        return undefined;
    }
}

export const ProfileOptimizerService = new ProfileOptimizerServiceClass();
