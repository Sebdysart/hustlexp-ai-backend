/**
 * Context-Aware AI Prompt
 * 
 * Generates personalized system prompts that include
 * full user context - making HUSTLEAI truly aware.
 */

import type { AIContextBlock, ProfileSnapshot, RecentAction, ScreenContext, TaskCategory } from '../../types/index.js';
import type { UserGoals, UserConstraints, TaskPreferences } from '../../services/UserBrainService.js';

// ============================================
// Types
// ============================================

export interface FullUserContext {
    // Core identity
    userId: string;
    role: 'hustler' | 'client' | 'both';

    // Profile snapshot
    profile: ProfileSnapshot;

    // Location in app
    screen: ScreenContext;
    recentActions: RecentAction[];

    // Learned preferences
    goals: UserGoals;
    constraints: UserConstraints;
    taskPreferences: TaskPreferences;

    // AI memory
    aiHistorySummary: string;
    learningScore: number;
}

// ============================================
// Prompt Generation
// ============================================

/**
 * Generate the full context-aware system prompt
 */
export function getContextAwarePrompt(context: FullUserContext): string {
    const sections: string[] = [];

    // Core identity
    sections.push(`You are HUSTLEAI, the personal work coach for HustleXP in Seattle.`);
    sections.push(`You're not a generic chatbot - you KNOW this user and their hustle.`);
    sections.push('');

    // Who they are
    sections.push('## WHO YOU\'RE TALKING TO:');
    sections.push(`- Role: ${context.role.toUpperCase()}`);
    sections.push(`- Level: ${context.profile.level} (${context.profile.xp} XP)`);
    sections.push(`- Streak: ${context.profile.streakDays} days`);
    sections.push(`- Earnings (7d): $${context.profile.earningsLast7d}`);
    if (context.profile.topCategories.length > 0) {
        sections.push(`- Top categories: ${context.profile.topCategories.join(', ')}`);
    }
    if (context.profile.rating) {
        sections.push(`- Rating: ${context.profile.rating}/5`);
    }
    sections.push('');

    // What we know about them
    if (context.aiHistorySummary) {
        sections.push('## WHAT YOU KNOW ABOUT THEM:');
        sections.push(context.aiHistorySummary);
        sections.push('');
    }

    // Their goals
    if (context.goals.monthlyIncomeTarget || context.goals.shortTermGoal) {
        sections.push('## THEIR GOALS:');
        if (context.goals.monthlyIncomeTarget) {
            sections.push(`- Monthly target: $${context.goals.monthlyIncomeTarget}`);
        }
        if (context.goals.weeklyIncomeTarget) {
            sections.push(`- Weekly target: $${context.goals.weeklyIncomeTarget}`);
        }
        if (context.goals.shortTermGoal) {
            sections.push(`- Working toward: ${context.goals.shortTermGoal.replace('_', ' ')}`);
        }
        sections.push('');
    }

    // Their constraints
    const constraintNotes: string[] = [];
    if (!context.constraints.hasCar) constraintNotes.push('No car');
    if (!context.constraints.petFriendly) constraintNotes.push('No pets');
    if (!context.constraints.canDoHeavyLifting) constraintNotes.push('No heavy lifting');
    if (context.constraints.maxDistanceKm) constraintNotes.push(`Max ${context.constraints.maxDistanceKm}km`);
    if (context.constraints.availableTimes.length > 0) {
        constraintNotes.push(`Works ${context.constraints.availableTimes.join(', ')}`);
    }

    if (constraintNotes.length > 0) {
        sections.push('## THEIR CONSTRAINTS:');
        sections.push(constraintNotes.map(c => `- ${c}`).join('\n'));
        sections.push('');
    }

    // Task preferences
    if (context.taskPreferences.preferredCategories.length > 0 || context.taskPreferences.avoidedCategories.length > 0) {
        sections.push('## TASK PREFERENCES:');
        if (context.taskPreferences.preferredCategories.length > 0) {
            sections.push(`- Likes: ${context.taskPreferences.preferredCategories.join(', ')}`);
        }
        if (context.taskPreferences.avoidedCategories.length > 0) {
            sections.push(`- Avoids: ${context.taskPreferences.avoidedCategories.join(', ')}`);
        }
        if (context.taskPreferences.prefersShortTasks) sections.push('- Prefers quick tasks');
        if (context.taskPreferences.prefersIndoorTasks) sections.push('- Prefers indoor work');
        sections.push('');
    }

    // Where they are now
    sections.push('## WHERE THEY ARE NOW:');
    sections.push(`- Screen: ${context.screen}`);
    if (context.recentActions.length > 0) {
        const actionList = context.recentActions.slice(0, 5).map(a => {
            return a.category ? `${a.type}:${a.category}` : a.type;
        }).join(', ');
        sections.push(`- Recent actions: ${actionList}`);
    }
    sections.push('');

    // How to respond
    sections.push('## HOW TO RESPOND:');
    sections.push('1. Be SPECIFIC to their situation - use their actual numbers');
    sections.push('2. Reference their goals if known');
    sections.push('3. Give CONCRETE advice (exact $, times, XP amounts)');
    sections.push('4. NEVER give generic advice');
    sections.push('5. Sound like a street-smart friend who has their back');
    sections.push('6. Make them feel like you KNOW their hustle');
    sections.push('');

    // Screen-specific guidance
    sections.push('## SCREEN-SPECIFIC GUIDANCE:');
    sections.push(getScreenGuidance(context.screen, context.profile));

    return sections.join('\n');
}

/**
 * Get screen-specific guidance for the AI
 */
function getScreenGuidance(screen: ScreenContext, profile: ProfileSnapshot): string {
    switch (screen) {
        case 'home':
            return `User is on HOME. Give a quick status update and ONE concrete action to take.
Example: "You're at Level ${profile.level} with a ${profile.streakDays}-day streak! Check the top task in your feed to keep it going."`;

        case 'feed':
            return `User is browsing TASKS. Help them pick the right one based on their categories and patterns.
Highlight tasks that match their preferences. Mention specific prices and time estimates.`;

        case 'task_detail':
            return `User is looking at a SPECIFIC TASK. Help them decide: accept or skip?
Be concrete: "Tasks like this usually take X minutes and pay $Y. Good fit for you because..."`;

        case 'profile':
            return `User is on their PROFILE. Suggest specific improvements that will get them more matches.
Be direct: "Adding X and Y could improve your match rate by ~Z%"`;

        case 'earnings':
            return `User is checking EARNINGS. Interpret their numbers and give projection.
"You made $X this week. At this pace, you'll hit ~$Y by end of month. To reach your $Z goal, try..."`;

        case 'quests':
            return `User is viewing QUESTS. Help prioritize which to focus on.
"This quest gives the best XP for your time. Complete it by doing X."`;

        case 'chat':
            return `User is in AI CHAT. They want to talk. Listen, learn, and give personalized advice.
Every message is a chance to learn more about their preferences.`;

        default:
            return `User is on ${screen}. Provide helpful, personalized guidance.`;
    }
}

/**
 * Generate a minimal prompt for quick responses
 */
export function getMinimalContextPrompt(context: {
    role: 'hustler' | 'client';
    level: number;
    streak: number;
    screen: ScreenContext;
    aiHistorySummary?: string;
}): string {
    return `You are HUSTLEAI for a ${context.role} (Level ${context.level}, ${context.streak}-day streak) on ${context.screen} screen.
${context.aiHistorySummary ? `What you know: ${context.aiHistorySummary}` : ''}
Be specific, use numbers, sound like a friend.`;
}

/**
 * Extract key context for logging
 */
export function summarizeContext(context: FullUserContext): string {
    return `L${context.profile.level} ${context.role} on ${context.screen} | ${context.recentActions.length} actions | Score: ${context.learningScore}`;
}
