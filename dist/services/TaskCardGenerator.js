import { modelRouter } from '../ai/router.js';
import { serviceLogger } from '../utils/logger.js';
import { TASK_ENRICHMENT_PROMPT, } from '../ai/prompts/taskCard.js';
// ============================================
// Constants
// ============================================
const CATEGORY_ICONS = {
    delivery: '📦',
    moving: '🚚',
    cleaning: '🧹',
    pet_care: '🐕',
    errands: '🏃',
    handyman: '🔧',
    tech_help: '💻',
    yard_work: '🌿',
    event_help: '🎉',
    general: '✨',
    other: '✨',
};
const DIFFICULTY_COLORS = {
    easy: '#4CAF50',
    medium: '#FF9800',
    hard: '#F44336',
};
const BASE_XP = {
    easy: 50,
    medium: 100,
    hard: 200,
};
const CATEGORY_BADGES = {
    delivery: 'Delivery Pro',
    moving: 'Moving Master',
    cleaning: 'Cleaning Expert',
    pet_care: 'Pet Whisperer',
    errands: 'Errand Runner Elite',
    handyman: 'Handyman Hero',
    tech_help: 'Tech Guru',
    yard_work: 'Garden Guardian',
    event_help: 'Event Star',
    other: 'Versatile Hustler',
};
// Seattle hotspots with surge modifiers
const SEATTLE_HOTSPOTS = {
    'capitol hill': { baseSurge: 1.10, peakHours: [18, 19, 20, 21], peakDays: [5, 6] },
    'ballard': { baseSurge: 1.05, peakHours: [10, 11, 12, 13], peakDays: [6, 0] },
    'uw': { baseSurge: 1.08, peakHours: [11, 12, 13, 14], peakDays: [1, 2, 3, 4, 5] },
    'downtown': { baseSurge: 1.12, peakHours: [12, 13, 17, 18], peakDays: [1, 2, 3, 4, 5] },
    'fremont': { baseSurge: 1.05, peakHours: [11, 12, 18, 19], peakDays: [5, 6, 0] },
    'queen anne': { baseSurge: 1.07, peakHours: [10, 11, 17, 18], peakDays: [6, 0] },
};
// ============================================
// TaskCardGenerator Service
// ============================================
class TaskCardGeneratorClass {
    /**
     * Generate a fully enriched task card from minimal input
     */
    async generateCard(input) {
        const now = new Date();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        // Step 1: AI enriches the raw text
        const enriched = await this.enrichTask(input.rawText, input.location, input.categoryHint, now, days[now.getDay()]);
        // Step 2: Calculate Seattle context
        const seattle = this.calculateSeattleContext(enriched.category, input.location || 'Seattle', now);
        // Step 3: Apply surge to pricing
        const price = this.calculatePrice(enriched.priceBreakdown, seattle.surgeFactor);
        // Step 4: Calculate gamification
        const gamification = this.calculateGamification(enriched.category, enriched.difficulty, enriched.durationMinutes, input.userLevel || 1, input.userStreak || 0, input.userCategoryCount || 0);
        // Step 5: Generate social proof
        const socialProof = await this.generateSocialProof(enriched.category, input.location);
        // Step 6: Generate priority tags
        const priorityTags = this.generatePriorityTags(enriched, seattle, gamification, input.userLevel || 1);
        // Step 7: Calculate visual hints
        const visualHints = this.calculateVisualHints(enriched, seattle, gamification);
        // Step 8: Determine level required
        const levelRequired = this.calculateLevelRequired(enriched.difficulty, enriched.experienceLevel);
        // Step 9: Determine safety rating
        const safetyRating = this.calculateSafetyRating(enriched);
        const card = {
            id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title: enriched.title,
            description: enriched.description,
            originalInput: input.rawText,
            category: enriched.category,
            categoryIcon: CATEGORY_ICONS[enriched.category] || '✨',
            location: input.location || 'Seattle, WA',
            locationShort: this.shortenLocation(input.location || 'Seattle'),
            durationMinutes: enriched.durationMinutes,
            durationText: enriched.durationText,
            scheduledTime: input.scheduledTime || null,
            difficulty: enriched.difficulty,
            difficultyColor: DIFFICULTY_COLORS[enriched.difficulty],
            experienceLevel: enriched.experienceLevel,
            levelRequired,
            equipment: enriched.equipment,
            safetyRating,
            safetyNotes: enriched.safetyNotes ? [enriched.safetyNotes] : [],
            price,
            instantPayout: price.recommended >= 30,
            gamification,
            seattle,
            socialProof,
            priorityTags,
            visualHints,
            createdAt: now,
            expiresAt: null,
        };
        serviceLogger.info({ cardId: card.id, category: card.category }, 'Task card generated');
        return card;
    }
    /**
     * Enrich task using AI
     */
    async enrichTask(rawText, location, categoryHint, now, dayOfWeek) {
        const prompt = TASK_ENRICHMENT_PROMPT
            .replace('{rawInput}', rawText)
            .replace('{location}', location || 'Seattle')
            .replace('{categoryHint}', categoryHint || 'auto-detect')
            .replace('{currentTime}', now.toLocaleTimeString())
            .replace('{dayOfWeek}', dayOfWeek);
        const result = await modelRouter.generateRouted('planning', prompt, {
            temperature: 0.5,
            maxTokens: 500,
        });
        try {
            const data = JSON.parse(result.content);
            return {
                title: data.title || this.generateFallbackTitle(rawText),
                description: data.description || rawText,
                category: data.category || categoryHint || 'other',
                durationMinutes: data.durationMinutes || 60,
                durationText: data.durationText || '~1 hour',
                difficulty: data.difficulty || 'medium',
                equipment: data.equipment || [],
                safetyNotes: data.safetyNotes || '',
                experienceLevel: data.experienceLevel || 'none',
                priceBreakdown: data.priceBreakdown || { min: 25, recommended: 40, max: 60, hourlyEquivalent: 25 },
            };
        }
        catch {
            // Fallback enrichment
            return {
                title: this.generateFallbackTitle(rawText),
                description: rawText,
                category: categoryHint || 'errands',
                durationMinutes: 60,
                durationText: '~1 hour',
                difficulty: 'medium',
                equipment: [],
                safetyNotes: '',
                experienceLevel: 'none',
                priceBreakdown: { min: 25, recommended: 40, max: 60, hourlyEquivalent: 25 },
            };
        }
    }
    /**
     * Calculate Seattle-specific context
     */
    calculateSeattleContext(category, location, now) {
        const hour = now.getHours();
        const dayOfWeek = now.getDay();
        const locationLower = location.toLowerCase();
        let surgeFactor = 1.0;
        let surgeReason = null;
        let hotspotBonus = false;
        // Check hotspots
        for (const [hotspot, config] of Object.entries(SEATTLE_HOTSPOTS)) {
            if (locationLower.includes(hotspot)) {
                surgeFactor = config.baseSurge;
                hotspotBonus = true;
                // Peak hour bonus
                if (config.peakHours.includes(hour)) {
                    surgeFactor += 0.05;
                    surgeReason = `${hotspot.charAt(0).toUpperCase() + hotspot.slice(1)} peak hours`;
                }
                // Peak day bonus  
                if (config.peakDays.includes(dayOfWeek)) {
                    surgeFactor += 0.05;
                    surgeReason = surgeReason
                        ? `${surgeReason} + weekend surge`
                        : `${hotspot.charAt(0).toUpperCase() + hotspot.slice(1)} weekend surge`;
                }
                break;
            }
        }
        // Weather warning (simplified - would integrate with real API)
        let weatherWarning = null;
        if (category === 'yard_work' || category === 'moving') {
            weatherWarning = 'Check weather before outdoor work - Seattle rain possible';
        }
        // Traffic note for delivery/errands
        let trafficNote = null;
        if ((category === 'delivery' || category === 'errands') && hour >= 16 && hour <= 18) {
            trafficNote = 'Rush hour traffic - allow extra time';
        }
        return {
            surgeFactor,
            surgeReason,
            surgePercent: Math.round((surgeFactor - 1) * 100),
            weatherWarning,
            trafficNote,
            eventNote: null, // Would integrate with events API
            recommendedTiming: hour < 10 ? 'Best rates in morning' : null,
            hotspotBonus,
            areaInsights: hotspotBonus ? 'High hustler availability in this area' : null,
        };
    }
    /**
     * Calculate pricing with surge
     */
    calculatePrice(base, surgeFactor) {
        const surgeApplied = surgeFactor > 1;
        return {
            min: Math.round(base.min * surgeFactor),
            recommended: Math.round(base.recommended * surgeFactor),
            max: Math.round(base.max * surgeFactor),
            hourlyEquivalent: Math.round(base.hourlyEquivalent * surgeFactor),
            surgeApplied,
            originalRecommended: surgeApplied ? base.recommended : undefined,
        };
    }
    /**
     * Calculate gamification elements
     */
    calculateGamification(category, difficulty, durationMinutes, userLevel, userStreak, userCategoryCount) {
        // Base XP
        const baseXP = BASE_XP[difficulty];
        // Duration bonus (25 XP per 30 mins)
        const durationBonus = Math.floor(durationMinutes / 30) * 25;
        // Streak multiplier
        let streakMultiplier = 1.0;
        let streakText = null;
        if (userStreak >= 14) {
            streakMultiplier = 2.0;
            streakText = '🔥 2x streak boost!';
        }
        else if (userStreak >= 7) {
            streakMultiplier = 1.5;
            streakText = '🔥 +50% streak boost';
        }
        else if (userStreak >= 3) {
            streakMultiplier = 1.25;
            streakText = '🔥 +25% streak boost';
        }
        const totalXP = Math.round((baseXP + durationBonus) * streakMultiplier);
        // Category progress
        const categoryProgress = {
            current: userCategoryCount % 10,
            max: 10,
            badge: CATEGORY_BADGES[category] || 'Versatile Hustler',
        };
        // Potential badges
        const potentialBadges = [];
        if (userCategoryCount === 0)
            potentialBadges.push('First Timer');
        if (userCategoryCount + 1 === 10)
            potentialBadges.push(CATEGORY_BADGES[category]);
        if (difficulty === 'hard')
            potentialBadges.push('Challenge Accepted');
        // Double XP eligibility
        const hour = new Date().getHours();
        const doubleXPEligible = hour >= 6 && hour <= 9;
        return {
            baseXP,
            bonusXP: durationBonus,
            totalXP,
            streakMultiplier,
            streakText,
            categoryProgress,
            potentialBadges,
            doubleXPEligible,
            doubleXPReason: doubleXPEligible ? 'Early bird bonus (6-9am)' : null,
        };
    }
    /**
     * Generate social proof
     */
    async generateSocialProof(category, location) {
        // In production, query real data
        const nearbyHustlers = Math.floor(Math.random() * 8) + 3;
        const completedSimilar = Math.floor(Math.random() * 50) + 10;
        const avgRating = 4.5 + Math.random() * 0.5;
        const successRate = 0.92 + Math.random() * 0.08;
        let popularityText = '';
        if (completedSimilar > 30) {
            popularityText = `${completedSimilar} similar tasks completed nearby`;
        }
        else if (nearbyHustlers > 5) {
            popularityText = `${nearbyHustlers} hustlers available now`;
        }
        else {
            popularityText = `${Math.round(avgRating * 10) / 10}★ average rating`;
        }
        return {
            nearbyHustlers,
            completedSimilar,
            avgRating: Math.round(avgRating * 10) / 10,
            successRate: Math.round(successRate * 100) / 100,
            popularityText,
        };
    }
    /**
     * Generate priority tags for matching
     */
    generatePriorityTags(enriched, seattle, gamification, userLevel) {
        const tags = [];
        // Easy tasks
        if (enriched.difficulty === 'easy' && enriched.experienceLevel === 'none') {
            tags.push('no experience needed');
            tags.push('new user friendly');
        }
        // High paying
        if (enriched.priceBreakdown.recommended >= 80) {
            tags.push('top paying');
        }
        // Quick tasks
        if (enriched.durationMinutes <= 60) {
            tags.push('quick task');
            tags.push('easy work');
        }
        // Surge/hotspot
        if (seattle.hotspotBonus) {
            tags.push('high demand');
        }
        if (seattle.surgeFactor > 1.1) {
            tags.push('surge pricing');
            tags.push(`+${seattle.surgePercent}%`);
        }
        // Gamification
        if (gamification.doubleXPEligible) {
            tags.push('double XP');
        }
        if (gamification.potentialBadges.length > 0) {
            tags.push('badge available');
        }
        // Calculate match score
        const matchScore = Math.min(100, 60 +
            (tags.length * 8) +
            (seattle.hotspotBonus ? 10 : 0) +
            (gamification.streakMultiplier > 1 ? 10 : 0));
        return {
            tags,
            matchScore,
            isRecommended: matchScore >= 75,
        };
    }
    /**
     * Calculate visual hints for frontend
     */
    calculateVisualHints(enriched, seattle, gamification) {
        // Gradient based on category
        const gradients = {
            delivery: ['#667eea', '#764ba2'],
            moving: ['#f093fb', '#f5576c'],
            cleaning: ['#4facfe', '#00f2fe'],
            pet_care: ['#43e97b', '#38f9d7'],
            errands: ['#fa709a', '#fee140'],
            handyman: ['#30cfd0', '#330867'],
            tech_help: ['#a8edea', '#fed6e3'],
            default: ['#667eea', '#764ba2'],
        };
        const gradientColors = gradients[enriched.category] || gradients.default;
        // Glow based on surge/special
        let glowColor = 'rgba(102, 126, 234, 0.3)';
        if (seattle.surgeFactor > 1.15) {
            glowColor = 'rgba(255, 215, 0, 0.5)'; // Gold for high surge
        }
        else if (gamification.doubleXPEligible) {
            glowColor = 'rgba(138, 43, 226, 0.5)'; // Purple for double XP
        }
        // Badges to show
        const badges = [];
        if (seattle.surgePercent > 0)
            badges.push(`+${seattle.surgePercent}% Surge`);
        if (gamification.doubleXPEligible)
            badges.push('2x XP');
        if (seattle.hotspotBonus)
            badges.push('🔥 Hot');
        // Animations
        const animations = ['hover-glow'];
        if (seattle.surgeFactor > 1.1)
            animations.push('pulse');
        if (gamification.streakMultiplier > 1)
            animations.push('fire');
        // Urgency
        let urgencyLevel = 'low';
        if (seattle.surgeFactor > 1.15)
            urgencyLevel = 'high';
        else if (seattle.hotspotBonus)
            urgencyLevel = 'medium';
        return {
            gradientColors,
            glowColor,
            badges,
            animations,
            urgencyLevel,
        };
    }
    /**
     * Calculate level required
     */
    calculateLevelRequired(difficulty, experience) {
        if (difficulty === 'easy' && experience === 'none')
            return 1;
        if (difficulty === 'easy')
            return 2;
        if (difficulty === 'medium' && experience === 'none')
            return 2;
        if (difficulty === 'medium')
            return 4;
        if (difficulty === 'hard' && experience === 'experienced')
            return 8;
        return 5;
    }
    /**
     * Calculate safety rating
     */
    calculateSafetyRating(enriched) {
        if (enriched.category === 'moving' && enriched.difficulty === 'hard') {
            return 'caution';
        }
        if (enriched.experienceLevel === 'experienced' && enriched.difficulty === 'hard') {
            return 'requires_verification';
        }
        if (enriched.safetyNotes && enriched.safetyNotes.toLowerCase().includes('heavy')) {
            return 'caution';
        }
        return 'safe';
    }
    /**
     * Generate fallback title
     */
    generateFallbackTitle(rawText) {
        const words = rawText.split(' ').slice(0, 4);
        return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    /**
     * Shorten location for display
     */
    shortenLocation(location) {
        const parts = location.split(',');
        return parts[0].trim();
    }
}
export const TaskCardGenerator = new TaskCardGeneratorClass();
//# sourceMappingURL=TaskCardGenerator.js.map