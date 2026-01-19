/**
 * AI Orchestrator - The central brain of HustleXP AI
 *
 * This is the main entry point for all AI interactions.
 * It classifies intent, routes to the appropriate handler,
 * and returns structured responses.
 *
 * UPGRADED: Now integrates UserBrainService for continuous learning.
 * Every interaction → learning → better next response.
 */
import { classifyIntent } from './intents.js';
import { routedGenerate } from './router.js';
import { tools } from './tools.js';
import { getTaskComposerPrompt } from './prompts/intentClassifier.js';
import { getPriceAdvisorPrompt } from './prompts/priceAdvisor.js';
import { getHustlerCoachPrompt } from './prompts/hustlerCoach.js';
import { aiLogger } from '../utils/logger.js';
import { UserBrainService } from '../services/UserBrainService.js';
import { ActionTrackerService } from '../services/ActionTrackerService.js';
/**
 * Main orchestration entry point
 * Now includes learning loop from every interaction
 */
export async function orchestrate(input) {
    const startTime = Date.now();
    try {
        // NEW: Get user's brain for personalization
        const userBrain = UserBrainService.getUserBrain(input.userId);
        const screen = input.context?.screen || 'chat';
        // IDENTITY-AWARE: Get identity context for personalized AI
        const { AIIdentityContextService } = await import('../services/AIIdentityContextService.js');
        const identityContext = await AIIdentityContextService.getOnboardingContext(input.userId);
        const identityPromptContext = identityContext
            ? await AIIdentityContextService.generateAIPromptContext(input.userId)
            : null;
        aiLogger.info({
            userId: input.userId,
            mode: input.mode,
            messageLength: input.message.length,
            screen,
            learningScore: userBrain.learningScore,
            trustTier: identityContext?.trustTier || 'unknown',
            riskLevel: identityContext?.riskLevel || 'unknown',
        }, 'Orchestration started (identity-aware)');
        // Inject identity context into input for handlers
        const enrichedInput = {
            ...input,
            context: {
                screen,
                recentActions: input.context?.recentActions || [],
                profileSnapshot: input.context?.profileSnapshot || {
                    role: 'hustler',
                    level: 1,
                    xp: 0,
                    streakDays: 0,
                    topCategories: [],
                    earningsLast7d: 0,
                },
                aiHistorySummary: input.context?.aiHistorySummary,
                identityContext: identityContext ? {
                    trustScore: identityContext.trustScore,
                    trustTier: identityContext.trustTier,
                    riskLevel: identityContext.riskLevel,
                    shouldChallenge: identityContext.shouldChallenge,
                    skipRedundantQuestions: identityContext.skipRedundantQuestions,
                    isFullyVerified: identityContext.identityVerified && identityContext.isReturningUser,
                } : null,
                identityPromptContext,
            },
        };
        // NEW: Track this message as an action
        ActionTrackerService.trackAction(input.userId, {
            actionType: 'sent_message',
            screen,
            metadata: { messageLength: input.message.length },
        });
        // Step 1: Classify intent
        const intentResult = await classifyIntent(input.message, input.mode);
        aiLogger.debug({
            intent: intentResult.intent,
            confidence: intentResult.confidence,
        }, 'Intent classified');
        // Step 2: Route to appropriate handler
        const response = await routeToHandler(input, intentResult.intent);
        // NEW: Learn from this interaction
        await UserBrainService.updateFromChat(input.userId, input.message, response.message);
        aiLogger.info({
            intent: intentResult.intent,
            responseType: response.type,
            duration: Date.now() - startTime,
            learned: true,
        }, 'Orchestration completed (with learning)');
        return response;
    }
    catch (error) {
        aiLogger.error({ error, userId: input.userId }, 'Orchestration failed');
        return {
            type: 'ERROR',
            data: null,
            message: 'Sorry, something went wrong. Please try again.',
        };
    }
}
/**
 * Route to the appropriate handler based on intent
 */
async function routeToHandler(input, intent) {
    switch (intent) {
        case 'create_task':
            return handleCreateTask(input);
        case 'search_tasks':
            return handleSearchTasks(input);
        case 'ask_pricing':
            return handleAskPricing(input);
        case 'hustler_plan':
            return handleHustlerPlan(input);
        case 'ask_support':
            return handleSupport(input);
        default:
            return handleOther(input);
    }
}
// ============================================
// Handler Functions
// ============================================
/**
 * Handle task creation - AI Task Composer
 */
async function handleCreateTask(input) {
    try {
        // Get user info for context
        const user = await tools.getUser(input.userId);
        // Step 1: Use DeepSeek to compose the task
        const composerResult = await routedGenerate('planning', {
            system: getTaskComposerPrompt(),
            messages: [
                {
                    role: 'user',
                    content: `User request: "${input.message}"

${user ? `User location: Seattle, WA` : ''}

Extract and structure this into a task.`,
                },
            ],
            json: true,
            maxTokens: 1024,
        });
        const taskDraft = JSON.parse(composerResult.content);
        // Step 2: Moderate the content
        const moderationResult = await tools.moderateContent({
            content: `${taskDraft.title}. ${taskDraft.description}`,
        });
        if (moderationResult.decision === 'blocked') {
            return {
                type: 'ERROR',
                data: null,
                message: moderationResult.userMessage || 'This task cannot be posted. Please revise and try again.',
            };
        }
        // Return draft for user to review/confirm
        return {
            type: 'TASK_DRAFT',
            data: {
                taskDraft,
                moderationStatus: moderationResult.decision,
            },
            message: taskDraft.priceExplanation || `I've prepared a ${taskDraft.category} task for you. Review the details and confirm to post.`,
            nextAction: 'confirm_task',
        };
    }
    catch (error) {
        aiLogger.error({ error }, 'handleCreateTask failed');
        return {
            type: 'ERROR',
            data: null,
            message: 'Failed to create task. Please try describing what you need again.',
        };
    }
}
/**
 * Handle task search for hustlers
 */
async function handleSearchTasks(input) {
    try {
        // Get user's hustler profile for context
        const profile = await tools.getHustlerProfile(input.userId);
        // Get available tasks
        const openTasks = await tools.getOpenTasksForHustler(input.userId, 10);
        if (openTasks.length === 0) {
            return {
                type: 'TASKS_FOUND',
                data: { tasks: [], count: 0 },
                message: 'No open tasks available right now. Check back soon!',
            };
        }
        // If there are tasks, consider AI re-ranking based on profile
        return {
            type: 'TASKS_FOUND',
            data: {
                tasks: openTasks,
                count: openTasks.length,
                matchedToProfile: !!profile,
            },
            message: `Found ${openTasks.length} tasks available near you.`,
        };
    }
    catch (error) {
        aiLogger.error({ error }, 'handleSearchTasks failed');
        return {
            type: 'ERROR',
            data: null,
            message: 'Failed to search tasks. Please try again.',
        };
    }
}
/**
 * Handle pricing questions
 */
async function handleAskPricing(input) {
    try {
        const result = await routedGenerate('pricing', {
            system: getPriceAdvisorPrompt(),
            messages: [
                {
                    role: 'user',
                    content: `User question: "${input.message}"

Provide pricing guidance based on Seattle market rates.`,
                },
            ],
            json: true,
            maxTokens: 512,
        });
        const priceAdvice = JSON.parse(result.content);
        return {
            type: 'PRICE_SUGGESTION',
            data: priceAdvice,
            message: priceAdvice.explanation,
        };
    }
    catch (error) {
        aiLogger.error({ error }, 'handleAskPricing failed');
        return {
            type: 'ERROR',
            data: null,
            message: 'Unable to provide pricing guidance. Please try again.',
        };
    }
}
/**
 * Handle hustler coaching - suggest optimal tasks
 */
async function handleHustlerPlan(input) {
    try {
        // Get user stats and open tasks
        const [stats, profile, openTasks] = await Promise.all([
            tools.getUserStats(input.userId),
            tools.getHustlerProfile(input.userId),
            tools.getOpenTasksForHustler(input.userId, 20),
        ]);
        if (!profile || !stats) {
            return {
                type: 'ERROR',
                data: null,
                message: 'Please set up your hustler profile first.',
            };
        }
        if (openTasks.length === 0) {
            return {
                type: 'HUSTLER_PLAN',
                data: { tasks: [], earnings: 0 },
                message: 'No tasks available right now. Great time to take a break and come back later!',
            };
        }
        // Use DeepSeek to create a personalized plan
        const result = await routedGenerate('planning', {
            system: getHustlerCoachPrompt(),
            messages: [
                {
                    role: 'user',
                    content: `Hustler profile:
- Skills: ${profile.skills.join(', ')}
- Level: ${stats.level}
- XP: ${stats.xp}
- Streak: ${stats.streak} days
- Tasks completed: ${stats.tasksCompleted}
- Rating: ${stats.rating}

Open tasks nearby:
${openTasks.map((t) => `- ${t.id}: ${t.title} (${t.category}) - $${t.recommendedPrice}`).join('\n')}

Create a task plan for today.`,
                },
            ],
            json: true,
            maxTokens: 1024,
        });
        const plan = JSON.parse(result.content);
        // Map selected task IDs to full task objects
        const selectedTasks = openTasks.filter((t) => plan.selectedTaskIds?.includes(t.id));
        return {
            type: 'HUSTLER_PLAN',
            data: {
                tasks: selectedTasks,
                estimatedEarnings: plan.totalEstimatedEarnings,
                estimatedHours: plan.totalEstimatedHours,
                streakAdvice: plan.streakAdvice,
                taskNotes: plan.taskNotes,
            },
            message: plan.summaryText,
            nextAction: 'view_tasks',
        };
    }
    catch (error) {
        aiLogger.error({ error }, 'handleHustlerPlan failed');
        return {
            type: 'ERROR',
            data: null,
            message: 'Failed to create your plan. Please try again.',
        };
    }
}
/**
 * Handle support requests
 */
async function handleSupport(input) {
    try {
        // For now, provide a helpful response
        // In production, this could integrate with a ticketing system
        const result = await routedGenerate('high_stakes_copy', {
            system: `You are a helpful support assistant for HustleXP, a gig marketplace.
Be empathetic, professional, and helpful. If you can't solve the issue directly,
explain how the user can get more help. 

Return JSON:
{
  "response": "Your helpful response",
  "needsHumanReview": true/false,
  "category": "billing" | "dispute" | "technical" | "general"
}`,
            messages: [
                {
                    role: 'user',
                    content: input.message,
                },
            ],
            json: true,
            maxTokens: 512,
        });
        const support = JSON.parse(result.content);
        return {
            type: 'SUPPORT_RESPONSE',
            data: {
                needsHumanReview: support.needsHumanReview,
                category: support.category,
            },
            message: support.response,
            nextAction: support.needsHumanReview ? 'create_ticket' : undefined,
        };
    }
    catch (error) {
        aiLogger.error({ error }, 'handleSupport failed');
        return {
            type: 'ERROR',
            data: null,
            message: 'Unable to process your support request. Please contact support@hustlexp.com',
        };
    }
}
/**
 * Handle other/unclear intents
 */
async function handleOther(input) {
    return {
        type: 'CLARIFICATION_NEEDED',
        data: null,
        message: `I'm not sure what you're looking for. You can:
• Post a task (tell me what you need help with)
• Find tasks (search for gigs to complete)
• Ask about pricing
• Get help with an issue

What would you like to do?`,
    };
}
export const orchestrator = { orchestrate };
//# sourceMappingURL=orchestrator.js.map