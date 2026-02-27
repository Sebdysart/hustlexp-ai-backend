import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserService } from '../services/UserService.js';
import { TaskCompletionService } from '../services/TaskCompletionService.js';
import { AIGrowthCoachService } from '../services/AIGrowthCoachService.js';
import { ContextualCoachService, type ScreenContext } from '../services/ContextualCoachService.js';
import { ProfileOptimizerService } from '../services/ProfileOptimizerService.js';
import { SocialCardGenerator } from '../services/SocialCardGenerator.js';
import { DynamicBadgeEngine } from '../services/DynamicBadgeEngine.js';
import { QuestEngine } from '../services/QuestEngine.js';
import { UserBrainService } from '../services/UserBrainService.js';
import { ActionTrackerService, type ActionType } from '../services/ActionTrackerService.js';
import { AIMemoryService } from '../services/AIMemoryService.js';
import { AICostGuardService } from '../services/AICostGuardService.js';
import { SmartMatchAIService } from '../services/SmartMatchAIService.js';
import { PricingEngine } from '../services/PricingEngine.js';
import { tools } from '../ai/tools.js';
import { DisputeService } from '../services/DisputeService.js';
import { NotificationService } from '../services/NotificationService.js';
import { logger } from '../utils/logger.js';
import { requireAuth } from '../middleware/firebaseAuth.js';
import type { TaskCategory } from '../types/index.js';
import type { ScreenContext as BrainScreenContext } from '../services/UserBrainService.js';

const GenerateBioSchema = z.object({
    currentBio: z.string().optional(),
    skills: z.array(z.string()).optional(),
    personality: z.string().optional(),
});

const GenerateHeadlineSchema = z.object({
    currentHeadline: z.string().optional(),
    skills: z.array(z.string()).optional(),
    specialty: z.string().optional(),
});

const EarningsImpactSchema = z.object({
    photoUrl: z.string().optional(),
    bio: z.string().optional(),
    skills: z.array(z.string()).optional(),
    availabilitySet: z.boolean().optional(),
});

const GenerateCardSchema = z.object({
    type: z.enum(['task_completed', 'level_up', 'badge_unlocked', 'streak_milestone', 'earnings_milestone', 'quest_completed', 'first_task', 'weekly_recap']),
    data: z.object({
        taskTitle: z.string().optional(),
        taskCategory: z.string().optional(),
        earnings: z.number().optional(),
        xpEarned: z.number().optional(),
        rating: z.number().optional(),
        newLevel: z.number().optional(),
        totalXP: z.number().optional(),
        badgeName: z.string().optional(),
        badgeIcon: z.string().optional(),
        badgeRarity: z.string().optional(),
        streakDays: z.number().optional(),
        streakBonus: z.number().optional(),
        milestoneAmount: z.number().optional(),
        period: z.string().optional(),
        questTitle: z.string().optional(),
        questXP: z.number().optional(),
        weeklyTasks: z.number().optional(),
        weeklyEarnings: z.number().optional(),
        weeklyXP: z.number().optional(),
        weeklyStreak: z.number().optional(),
    }),
    userName: z.string().optional(),
});

const WeeklyRecapSchema = z.object({
    tasks: z.number(),
    earnings: z.number(),
    xp: z.number(),
    streak: z.number(),
    topCategory: z.string().optional(),
    userName: z.string().optional(),
});

const GenerateQuestSchema = z.object({
    topCategories: z.array(z.string()).optional().default([]),
    currentStreak: z.number().optional().default(0),
    recentEarnings: z.number().optional().default(0),
    level: z.number().optional().default(1),
});

const InstantPayoutSchema = z.object({
    hustlerId: z.string(),
    taskId: z.string(),
    amount: z.number().positive(),
});

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
    // Get user profile (C5)
    fastify.get<{
        Params: { userId: string };
    }>('/api/users/:userId', async (request, reply) => {
        const { userId } = request.params;
        const user = await UserService.getUser(userId);

        if (!user) {
            reply.code(404);
            return { error: 'User not found', code: 'USER_NOT_FOUND' };
        }

        return { user };
    });

    // Get user stats
    fastify.get('/api/users/:userId/stats', async (request, reply) => {
        const { userId } = request.params as { userId: string };
        const stats = await tools.getUserStats(userId);

        if (!stats) {
            reply.status(404);
            return { error: 'User not found' };
        }

        return stats;
    });

    // Get streak status for a hustler
    fastify.get('/api/users/:userId/streak', async (request) => {
        const { userId } = request.params as { userId: string };
        const streak = TaskCompletionService.getStreakStatus(userId);
        return streak;
    });

    // Get completion history for a hustler
    fastify.get('/api/users/:userId/completions', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const history = TaskCompletionService.getCompletionHistory(userId);
        return {
            completions: history.slice(0, limit ? parseInt(limit) : 20),
            count: history.length,
        };
    });

    // ============================================
    // Growth Coach Endpoints (Phase 1: Dopamine Core)
    // ============================================

    // Get full personalized growth plan
    fastify.get('/api/coach/:userId/plan', async (request) => {
        const { userId } = request.params as { userId: string };
        const plan = await AIGrowthCoachService.getGrowthPlan(userId);
        return plan;
    });

    // Get earnings projection
    fastify.get('/api/coach/:userId/earnings', async (request) => {
        const { userId } = request.params as { userId: string };
        const plan = await AIGrowthCoachService.getGrowthPlan(userId);
        return {
            current: plan.earnings,
            projection: plan.projection,
        };
    });

    // Get single best next action
    fastify.get('/api/coach/:userId/next-action', async (request) => {
        const { userId } = request.params as { userId: string };
        const action = await AIGrowthCoachService.getNextBestAction(userId);
        return action || { message: 'No recommendations right now', type: 'none' };
    });

    // Get optimal tasks for this user
    fastify.get('/api/coach/:userId/optimal-tasks', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const tasks = await AIGrowthCoachService.getOptimalTasks(userId, limit ? parseInt(limit) : 5);
        return { tasks, count: tasks.length };
    });

    // Get context-aware coaching tip
    fastify.get('/api/coach/:userId/tip', async (request) => {
        const { userId } = request.params as { userId: string };
        const { context } = request.query as { context?: string };
        const tip = await AIGrowthCoachService.getCoachingTip(userId, undefined, context);
        return tip;
    });

    // Get poster insights
    fastify.get('/api/coach/poster/:userId/insights', async (request) => {
        const { userId } = request.params as { userId: string };
        const insights = AIGrowthCoachService.getPosterInsights(userId);
        return insights;
    });

    // ============================================
    // Badge Endpoints (Dynamic Badge Engine)
    // ============================================

    // Get all badges with progress for user
    fastify.get('/api/badges/:userId', async (request) => {
        const { userId } = request.params as { userId: string };
        const progress = DynamicBadgeEngine.getBadgeProgress(userId);
        const stats = DynamicBadgeEngine.getBadgeStats(userId);
        return {
            badges: progress,
            stats,
            totalAvailable: DynamicBadgeEngine.getAllBadges().length,
        };
    });

    // Get recently earned badges
    fastify.get('/api/badges/:userId/recent', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const badges = DynamicBadgeEngine.getRecentBadges(userId, limit ? parseInt(limit) : 5);
        return { badges, count: badges.length };
    });

    // Get public profile showcase badges
    fastify.get('/api/badges/:userId/showcase', async (request) => {
        const { userId } = request.params as { userId: string };
        const badges = DynamicBadgeEngine.getBadgeShowcase(userId);
        return { badges, count: badges.length };
    });

    // Get seasonal/special badges
    fastify.get('/api/badges/seasonal', async () => {
        const badges = DynamicBadgeEngine.getSeasonalBadges();
        return { badges, count: badges.length };
    });

    // Evaluate and award badges for user
    fastify.post('/api/badges/:userId/evaluate', async (request) => {
        const { userId } = request.params as { userId: string };
        const result = await DynamicBadgeEngine.evaluateBadges(userId);
        return {
            newBadges: result.newBadges,
            xpAwarded: result.totalXPAwarded,
            message: result.newBadges.length > 0
                ? `🎉 Unlocked ${result.newBadges.length} new badge(s)!`
                : 'No new badges unlocked',
        };
    });

    // Award beta pioneer badge (special)
    fastify.post('/api/badges/:userId/beta-pioneer', async (request) => {
        const { userId } = request.params as { userId: string };
        const badge = DynamicBadgeEngine.awardBetaPioneer(userId);
        return badge
            ? { success: true, badge, message: '🚀 Beta Pioneer badge awarded!' }
            : { success: false, message: 'Badge already awarded or not found' };
    });

    // ============================================
    // Quest Endpoints (Quest Engine)
    // ============================================

    // Get daily quests
    fastify.get('/api/quests/:userId/daily', async (request) => {
        const { userId } = request.params as { userId: string };
        const quests = QuestEngine.getDailyQuests(userId);
        return { quests, count: quests.length };
    });

    // Get weekly quests
    fastify.get('/api/quests/:userId/weekly', async (request) => {
        const { userId } = request.params as { userId: string };
        const quests = QuestEngine.getWeeklyQuests(userId);
        return { quests, count: quests.length };
    });

    // Get seasonal quests
    fastify.get('/api/quests/:userId/seasonal', async (request) => {
        const { userId } = request.params as { userId: string };
        const quests = QuestEngine.getSeasonalQuests(userId);
        return { quests, count: quests.length };
    });

    // Get all active quests
    fastify.get('/api/quests/:userId/all', async (request) => {
        const { userId } = request.params as { userId: string };
        const quests = QuestEngine.getAllActiveQuests(userId);
        const stats = QuestEngine.getQuestStats(userId);
        return { quests, count: quests.length, stats };
    });

    // Refresh daily quests
    fastify.post('/api/quests/:userId/refresh', async (request) => {
        const { userId } = request.params as { userId: string };
        const quests = QuestEngine.refreshDailyQuests(userId);
        return { quests, count: quests.length, message: '🔄 Daily quests refreshed!' };
    });

    // Claim quest reward
    fastify.post('/api/quests/:userId/:questId/claim', async (request) => {
        const { userId, questId } = request.params as { userId: string; questId: string };
        const result = QuestEngine.claimQuest(userId, questId);
        return result;
    });

    // Generate personalized AI quest
    fastify.post('/api/quests/:userId/generate', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = GenerateQuestSchema.parse(request.body);
            const quest = await QuestEngine.generatePersonalizedQuest(userId, {
                topCategories: body.topCategories as TaskCategory[],
                currentStreak: body.currentStreak,
                recentEarnings: body.recentEarnings,
                level: body.level,
            });
            return quest
                ? { success: true, quest }
                : { success: false, message: 'Failed to generate quest' };
        } catch (error) {
            logger.error({ error }, 'Quest generation failed');
            reply.status(500);
            return { error: 'Failed to generate quest' };
        }
    });

    // ============================================
    // Contextual Coach Endpoints (Phase 2: Live Coaching)
    // ============================================

    // Get contextual tip for current screen
    fastify.get('/api/tips/:userId/screen/:screen', async (request) => {
        const { userId, screen } = request.params as { userId: string; screen: string };
        const tip = ContextualCoachService.getTipForScreen(userId, screen as ScreenContext);
        return tip ? { tip } : { message: 'No tip available for this context' };
    });

    // Get best contextual tip (auto-detect)
    fastify.get('/api/tips/:userId/contextual', async (request) => {
        const { userId } = request.params as { userId: string };
        const tip = ContextualCoachService.getContextualTip(userId);
        return tip ? { tip } : { message: 'No tips right now' };
    });

    // Get time-sensitive opportunities
    fastify.get('/api/tips/:userId/time-sensitive', async (request) => {
        const { userId } = request.params as { userId: string };
        const tip = ContextualCoachService.getTimeSensitiveTip(userId);
        return tip ? { tip } : { message: 'No time-sensitive opportunities right now' };
    });

    // Get streak-related tip
    fastify.get('/api/tips/:userId/streak', async (request) => {
        const { userId } = request.params as { userId: string };
        const { currentStreak } = request.query as { currentStreak?: string };
        const tip = ContextualCoachService.getStreakTip(userId, parseInt(currentStreak || '0'));
        return tip ? { tip } : { message: 'No streak tips right now' };
    });

    // Get all relevant tips
    fastify.get('/api/tips/:userId/all', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const tips = ContextualCoachService.getAllRelevantTips(userId, parseInt(limit || '3'));
        return { tips, count: tips.length };
    });

    // ============================================
    // Action Tracking & User Brain Endpoints
    // ============================================

    // Track user action
    fastify.post('/api/actions/track', async (request, reply) => {
        try {
            const body = request.body as {
                userId: string;
                actionType: ActionType;
                screen: BrainScreenContext;
                metadata?: Record<string, unknown>;
            };

            if (!body.userId || !body.actionType || !body.screen) {
                reply.status(400);
                return { error: 'Missing required fields: userId, actionType, screen' };
            }

            const action = ActionTrackerService.trackAction(body.userId, {
                actionType: body.actionType,
                screen: body.screen,
                metadata: body.metadata,
            });

            return { tracked: true, actionId: action.id };
        } catch (error) {
            logger.error({ error }, 'Action tracking failed');
            reply.status(500);
            return { error: 'Failed to track action' };
        }
    });

    // Get user's recent actions
    fastify.get('/api/actions/:userId/recent', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const actions = ActionTrackerService.getRecentActions(userId, parseInt(limit || '10'));
        return { actions, count: actions.length };
    });

    // Get user's action patterns (for debugging/analytics)
    fastify.get('/api/actions/:userId/patterns', async (request) => {
        const { userId } = request.params as { userId: string };
        const patterns = ActionTrackerService.analyzePatterns(userId);
        const stats = ActionTrackerService.getStats(userId);
        return { patterns, stats };
    });

    // Get user's brain (learned preferences)
    fastify.get('/api/brain/:userId', async (request) => {
        const { userId } = request.params as { userId: string };
        const brain = UserBrainService.getUserBrain(userId);
        return {
            userId: brain.userId,
            role: brain.role,
            goals: brain.goals,
            constraints: brain.constraints,
            taskPreferences: brain.taskPreferences,
            aiHistorySummary: brain.aiHistorySummary,
            learningScore: brain.learningScore,
            totalInteractions: brain.totalInteractions,
            lastActiveAt: brain.lastActiveAt,
        };
    });

    // Get AI context for a user (what the AI knows)
    fastify.get('/api/brain/:userId/context', async (request) => {
        const { userId } = request.params as { userId: string };
        const context = await UserBrainService.getContextForAI(userId);
        return { context };
    });

    // Update brain from external source (e.g., profile update)
    fastify.post('/api/brain/:userId/learn', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = request.body as { message: string };

            if (!body.message) {
                reply.status(400);
                return { error: 'Missing message field' };
            }

            await UserBrainService.updateFromChat(userId, body.message);
            const brain = UserBrainService.getUserBrain(userId);

            return {
                learned: true,
                learningScore: brain.learningScore,
                aiHistorySummary: brain.aiHistorySummary,
            };
        } catch (error) {
            logger.error({ error }, 'Brain learning failed');
            reply.status(500);
            return { error: 'Failed to learn from message' };
        }
    });

    // ============================================
    // AI Memory Endpoints (Phase 2: Conversation Memory)
    // ============================================

    // Get user's conversation history
    fastify.get('/api/memory/:userId/history', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const history = AIMemoryService.getRecentConversation(userId, parseInt(limit || '20'));
        return { history, count: history.length };
    });

    // Get extracted facts
    fastify.get('/api/memory/:userId/facts', async (request) => {
        const { userId } = request.params as { userId: string };
        const facts = AIMemoryService.getFacts(userId);
        const structured = AIMemoryService.getStructuredData(userId);
        return { facts, structured, count: facts.length };
    });

    // Get AI-generated summary
    fastify.get('/api/memory/:userId/summary', async (request) => {
        const { userId } = request.params as { userId: string };
        const summary = AIMemoryService.getSummary(userId);
        const stats = AIMemoryService.getStats(userId);
        return { summary, stats };
    });

    // Force regenerate summary
    fastify.post('/api/memory/:userId/regenerate-summary', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const summary = await AIMemoryService.regenerateSummary(userId);
            return { summary, regenerated: true };
        } catch (error) {
            logger.error({ error }, 'Summary regeneration failed');
            reply.status(500);
            return { error: 'Failed to regenerate summary' };
        }
    });

    // ============================================
    // Profile Optimizer Endpoints (Phase 2)
    // ============================================

    // Get full profile analysis
    fastify.get('/api/profile/:userId/score', async (request) => {
        const { userId } = request.params as { userId: string };
        const score = ProfileOptimizerService.getProfileScore(userId);
        return score;
    });

    // Get improvement suggestions
    fastify.get('/api/profile/:userId/suggestions', async (request) => {
        const { userId } = request.params as { userId: string };
        const suggestions = ProfileOptimizerService.getProfileSuggestions(userId);
        return { suggestions, count: suggestions.length };
    });

    // Generate AI bio
    fastify.post('/api/profile/:userId/generate-bio', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = GenerateBioSchema.parse(request.body);
            const result = await ProfileOptimizerService.generateBioSuggestion(userId, body);
            return result;
        } catch (error) {
            logger.error({ error }, 'Bio generation failed');
            reply.status(500);
            return { error: 'Failed to generate bio' };
        }
    });

    // Generate AI headline
    fastify.post('/api/profile/:userId/generate-headline', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = GenerateHeadlineSchema.parse(request.body);
            const result = await ProfileOptimizerService.generateHeadlineSuggestion(userId, body);
            return result;
        } catch (error) {
            logger.error({ error }, 'Headline generation failed');
            reply.status(500);
            return { error: 'Failed to generate headline' };
        }
    });

    // Get skill recommendations
    fastify.get('/api/profile/:userId/skill-recommendations', async (request) => {
        const { userId } = request.params as { userId: string };
        const recommendations = ProfileOptimizerService.getSkillRecommendations(userId);
        return recommendations;
    });

    // Predict earnings impact of profile changes
    fastify.post('/api/profile/:userId/earnings-impact', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const changes = EarningsImpactSchema.parse(request.body);
            const impact = ProfileOptimizerService.predictEarningsImpact(userId, changes);
            return impact;
        } catch (error) {
            reply.status(400);
            return { error: 'Invalid request body' };
        }
    });

    // ============================================
    // Social Card Endpoints (Phase 2: Viral Growth)
    // ============================================

    // Generate a social card
    fastify.post('/api/cards/:userId/generate', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = GenerateCardSchema.parse(request.body);
            const cardData = {
                ...body.data,
                taskCategory: body.data.taskCategory as TaskCategory | undefined,
            };
            const card = SocialCardGenerator.generateCard(userId, body.type, cardData, body.userName);
            return { card, ascii: SocialCardGenerator.getCardAscii(card) };
        } catch (error) {
            logger.error({ error }, 'Card generation failed');
            reply.status(500);
            return { error: 'Failed to generate card' };
        }
    });

    // Get recent cards
    fastify.get('/api/cards/:userId/recent', async (request) => {
        const { userId } = request.params as { userId: string };
        const { limit } = request.query as { limit?: string };
        const cards = SocialCardGenerator.getRecentCards(userId, parseInt(limit || '10'));
        return { cards, count: cards.length };
    });

    // Get specific card
    fastify.get('/api/cards/:cardId', async (request) => {
        const { cardId } = request.params as { cardId: string };
        const card = SocialCardGenerator.getCard(cardId);
        return card ? { card } : { error: 'Card not found' };
    });

    // Generate weekly recap card
    fastify.post('/api/cards/:userId/weekly-recap', async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = WeeklyRecapSchema.parse(request.body);
            const card = SocialCardGenerator.generateWeeklyRecap(userId, {
                tasks: body.tasks,
                earnings: body.earnings,
                xp: body.xp,
                streak: body.streak,
                topCategory: body.topCategory as TaskCategory | undefined,
            }, body.userName);
            return { card, ascii: SocialCardGenerator.getCardAscii(card) };
        } catch (error) {
            logger.error({ error }, 'Weekly recap generation failed');
            reply.status(500);
            return { error: 'Failed to generate weekly recap' };
        }
    });

    // Get share text for specific platform
    fastify.get('/api/cards/:cardId/share/:platform', async (request) => {
        const { cardId, platform } = request.params as { cardId: string; platform: string };
        const card = SocialCardGenerator.getCard(cardId);

        if (!card) {
            return { error: 'Card not found' };
        }

        const validPlatforms = ['twitter', 'instagram', 'tiktok', 'sms'];
        if (!validPlatforms.includes(platform)) {
            return { error: 'Invalid platform. Use: twitter, instagram, tiktok, or sms' };
        }

        const shareText = SocialCardGenerator.getShareTextForPlatform(
            card,
            platform as 'twitter' | 'instagram' | 'tiktok' | 'sms'
        );

        return { platform, shareText };
    });

    // ============================================
    // AI Cost Guard Endpoints
    // ============================================

    // Check if user can make AI call
    fastify.get('/api/cost/:userId/check/:provider', async (request) => {
        const { userId, provider } = request.params as { userId: string; provider: string };
        const result = AICostGuardService.checkLimit(userId, provider as 'openai' | 'deepseek' | 'qwen');
        return result;
    });

    // Get user's AI usage stats
    fastify.get('/api/cost/:userId/stats', async (request) => {
        const { userId } = request.params as { userId: string };
        const stats = AICostGuardService.getUserStats(userId);
        return stats;
    });

    // Get system-wide AI stats (admin)
    fastify.get('/api/cost/system/stats', async (request) => {
        const stats = AICostGuardService.getSystemStats();
        const limits = AICostGuardService.getLimits();
        return { stats, limits };
    });

    // Update cost limits (admin)
    fastify.post('/api/cost/limits', async (request) => {
        const newLimits = request.body as Partial<typeof AICostGuardService extends { updateLimits: (l: infer P) => unknown } ? P : never>;
        const limits = AICostGuardService.updateLimits(newLimits);
        return limits;
    });

    // ============================================
    // SmartMatch AI Endpoints
    // ============================================

    // Re-rank candidates for a task
    fastify.post('/api/match/:taskId/rerank', async (request, reply) => {
        try {
            const { taskId } = request.params as { taskId: string };
            const { task, candidates, limit } = request.body as {
                task: Parameters<typeof SmartMatchAIService.reRankCandidates>[0];
                candidates: Parameters<typeof SmartMatchAIService.reRankCandidates>[1];
                limit?: number;
            };
            const result = await SmartMatchAIService.reRankCandidates(task, candidates, limit);
            return result;
        } catch (error) {
            reply.status(500);
            return { error: 'Match ranking failed' };
        }
    });

    // Quick score a candidate
    fastify.post('/api/match/quick-score', async (request) => {
        const { task, candidate } = request.body as {
            task: Parameters<typeof SmartMatchAIService.quickScore>[0];
            candidate: Parameters<typeof SmartMatchAIService.quickScore>[1];
        };
        const score = SmartMatchAIService.quickScore(task, candidate);
        return { score };
    });

    // Explain a match
    fastify.post('/api/match/explain', async (request) => {
        const { task, candidate } = request.body as {
            task: Parameters<typeof SmartMatchAIService.explainMatch>[0];
            candidate: Parameters<typeof SmartMatchAIService.explainMatch>[1];
        };
        const explanation = await SmartMatchAIService.explainMatch(task, candidate);
        return explanation;
    });

    // Get test candidates for simulation
    fastify.get('/api/match/test-candidates', async (request) => {
        const { count } = request.query as { count?: string };
        const candidates = SmartMatchAIService.generateTestCandidates(parseInt(count || '10'));
        return { candidates };
    });

    // ============================================
    // Pricing Engine Endpoints
    // ============================================

    // Get pricing breakdown for a task
    fastify.get('/api/pricing/calculate/:price', async (request) => {
        const { price } = request.params as { price: string };
        const basePrice = parseFloat(price);
        const query = request.query as { boost?: string; newHustler?: string; rating?: string };

        if (isNaN(basePrice) || basePrice <= 0) {
            return { error: 'Invalid price' };
        }

        const boostTier = (query.boost || 'normal') as 'normal' | 'priority' | 'rush' | 'vip';
        const pricing = PricingEngine.calculatePricing(basePrice, boostTier, {
            isNewHustler: query.newHustler === 'true',
            hustlerRating: query.rating ? parseFloat(query.rating) : undefined,
        });

        return pricing;
    });

    // Get comparison table for all tiers
    fastify.get('/api/pricing/table/:price', async (request) => {
        const { price } = request.params as { price: string };
        const basePrice = parseFloat(price);

        if (isNaN(basePrice) || basePrice <= 0) {
            return { error: 'Invalid price' };
        }

        return PricingEngine.getPricingTable(basePrice);
    });

    // Get poster quote (what client sees)
    fastify.get('/api/pricing/quote/:price', async (request) => {
        const { price } = request.params as { price: string };
        const query = request.query as { boost?: string };
        const basePrice = parseFloat(price);
        const boostTier = (query.boost || 'normal') as 'normal' | 'priority' | 'rush' | 'vip';

        if (isNaN(basePrice) || basePrice <= 0) {
            return { error: 'Invalid price' };
        }

        return PricingEngine.getPosterQuote(basePrice, boostTier);
    });

    // Get hustler earnings preview
    fastify.get('/api/pricing/earnings/:price', async (request) => {
        const { price } = request.params as { price: string };
        const query = request.query as { boost?: string; newHustler?: string; rating?: string };
        const basePrice = parseFloat(price);
        const boostTier = (query.boost || 'normal') as 'normal' | 'priority' | 'rush' | 'vip';

        if (isNaN(basePrice) || basePrice <= 0) {
            return { error: 'Invalid price' };
        }

        return PricingEngine.getHustlerEarnings(basePrice, boostTier, {
            isNewHustler: query.newHustler === 'true',
            hustlerRating: query.rating ? parseFloat(query.rating) : undefined,
        });
    });

    // Request instant payout
    fastify.post('/api/pricing/payout/instant', async (request, reply) => {
        try {
            const body = InstantPayoutSchema.parse(request.body);
            const payout = PricingEngine.requestInstantPayout(body.hustlerId, body.taskId, body.amount);
            return payout;
        } catch (error) {
            logger.error({ error }, 'Instant payout error');
            reply.status(400);
            return { error: 'Failed to process payout' };
        }
    });

    // Get payout history
    fastify.get('/api/pricing/payout/:hustlerId', async (request) => {
        const { hustlerId } = request.params as { hustlerId: string };
        const history = PricingEngine.getPayoutHistory(hustlerId);
        return { payouts: history, count: history.length };
    });

    // Get revenue metrics
    fastify.get('/api/pricing/revenue', async (request) => {
        const query = request.query as { period?: string };
        const period = (query.period || 'all') as 'day' | 'week' | 'month' | 'all';
        return PricingEngine.getRevenueMetrics(period);
    });

    // Get/update pricing config (admin)
    fastify.get('/api/pricing/config', async () => {
        return PricingEngine.getConfig();
    });

    // ============================================
    // User Suspension
    // ============================================

    // Check user suspension status (public, for app use)
    fastify.get('/api/user/:userId/suspension', async (request) => {
        const { userId } = request.params as { userId: string };
        return DisputeService.isUserSuspended(userId);
    });

    // ============================================
    // User Notifications
    // ============================================

    // Get user notifications
    fastify.get('/api/notifications', { preHandler: [requireAuth] }, async (request) => {
        const userId = request.user?.uid;
        if (!userId) return { notifications: [] };

        return {
            notifications: NotificationService.getNotifications(userId, { limit: 20 }),
        };
    });
}
