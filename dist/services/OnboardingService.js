import { v4 as uuidv4 } from 'uuid';
import { modelRouter } from '../ai/router.js';
import { GamificationService } from './GamificationService.js';
import { TaskService } from './TaskService.js';
import { serviceLogger } from '../utils/logger.js';
import { ONBOARDING_INTRO_PROMPT, ONBOARDING_PROFILE_BUILDER_PROMPT, MONEY_PATH_PROMPT, FIRST_QUEST_PROMPT, } from '../ai/prompts/onboarding.js';
const referralCodes = new Map();
const userReferrals = new Map(); // userId -> referralCode
// ============================================
// Verification Levels
// ============================================
const VERIFICATION_LEVELS = {
    0: { name: 'New', xpRequired: 0, perks: ['Basic tasks'] },
    1: { name: 'Verified', xpRequired: 100, perks: ['All task categories', 'Priority matching'] },
    2: { name: 'Trusted', xpRequired: 500, perks: ['Higher paying tasks', 'Repeat client access'] },
    3: { name: 'Pro', xpRequired: 1500, perks: ['Premium tasks', 'Background check badge'] },
    4: { name: 'Elite', xpRequired: 4000, perks: ['VIP clients', 'Surge pricing access'] },
    5: { name: 'Legend', xpRequired: 10000, perks: ['All perks', 'Mentor program', 'Revenue share'] },
};
// ============================================
// Session Storage
// ============================================
const sessionsMemory = new Map();
const userSessions = new Map(); // userId -> sessionId (for resume)
const completedOnboarding = new Set(); // Track users who have completed onboarding
// ============================================
// Question Configurations
// ============================================
const HUSTLER_QUESTIONS = [
    { key: 'q1', question: "What type of tasks do you want to do?", options: ["Delivery", "Cleaning", "Pet Care", "Moving", "Errands", "Handyman"], canSkip: false },
    { key: 'q2', question: "Do you have a vehicle?", options: ["Car", "Bike", "No vehicle"], canSkip: false },
    { key: 'q3', question: "What's your neighborhood?", options: ["Capitol Hill", "Ballard", "UW Area", "Downtown", "Fremont", "Other"], canSkip: false },
    { key: 'q4', question: "When are you usually free?", options: ["Mornings", "Afternoons", "Evenings", "Weekends", "Flexible"], canSkip: true },
    { key: 'q5', question: "Any special skills or experience?", options: ["Handyman", "Tech help", "Heavy lifting", "Pet experience", "Driving", "None specific"], canSkip: true },
];
const CLIENT_QUESTIONS = [
    { key: 'q1', question: "What kind of help do you usually need?", options: ["Cleaning", "Errands", "Moving", "Pet Care", "Delivery", "Other"], canSkip: false },
    { key: 'q2', question: "What's your neighborhood?", options: ["Capitol Hill", "Ballard", "UW Area", "Downtown", "Fremont", "Other"], canSkip: false },
    { key: 'q3', question: "What's your typical budget per task?", options: ["$20-40", "$40-80", "$80-150", "$150+"], canSkip: true },
];
// ============================================
// Onboarding Service
// ============================================
class OnboardingServiceClass {
    /**
     * Start or resume onboarding session
     */
    async startOnboarding(userId, referralCode) {
        // Check for existing session (resume support)
        const existingSessionId = userSessions.get(userId);
        if (existingSessionId) {
            const existingSession = sessionsMemory.get(existingSessionId);
            if (existingSession && existingSession.step < existingSession.totalSteps + 1) {
                return this.resumeOnboarding(existingSession);
            }
        }
        const sessionId = uuidv4();
        // Generate AI intro
        const introResult = await modelRouter.generateRouted('intent', ONBOARDING_INTRO_PROMPT, {
            temperature: 0.7,
            maxTokens: 150,
        });
        let introData = {
            greeting: "I'm your HustleAI. I help you make money fast. Ready?",
            xpAwarded: 10,
            badge: 'first_step',
        };
        try {
            introData = JSON.parse(introResult.content);
        }
        catch {
            serviceLogger.debug('Using default intro');
        }
        // Handle referral
        let referredBy = null;
        let referralBonus = 0;
        if (referralCode && referralCodes.has(referralCode)) {
            const referral = referralCodes.get(referralCode);
            referredBy = referral.ownerId;
            referralBonus = 50; // Bonus XP for using referral
            referral.uses += 1;
            referral.xpEarned += 100; // Referrer gets 100 XP
            await GamificationService.awardXP(referral.ownerId, 100, 'referral_signup');
        }
        // Create session
        const session = {
            sessionId,
            userId,
            role: null,
            step: 0,
            totalSteps: 5, // Will be updated when role is chosen
            answers: {},
            skippedQuestions: [],
            profile: null,
            xpEarned: introData.xpAwarded + referralBonus,
            badges: [introData.badge],
            referralCode: this.generateReferralCode(userId),
            referredBy,
            verificationLevel: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.saveSession(session);
        userSessions.set(userId, sessionId);
        // Award XP
        await GamificationService.awardXP(userId, introData.xpAwarded, 'onboarding_start');
        if (referralBonus > 0) {
            await GamificationService.awardXP(userId, referralBonus, 'referral_bonus');
        }
        const animations = ['confetti', 'sparkle'];
        if (referralBonus > 0)
            animations.push('glow');
        return {
            sessionId,
            step: 0,
            totalSteps: 5,
            xpEarned: session.xpEarned,
            xpAwarded: introData.xpAwarded + referralBonus,
            badges: session.badges,
            badgeAwarded: introData.badge,
            animations,
            data: {
                greeting: introData.greeting,
                referralApplied: referralBonus > 0,
                referralBonus,
                yourReferralCode: session.referralCode,
            },
            nextAction: 'choose_role',
            canSkip: false,
            canResume: true,
        };
    }
    /**
     * Resume an existing session
     */
    async resumeOnboarding(session) {
        const animations = ['pulse'];
        if (session.step === 0) {
            return {
                sessionId: session.sessionId,
                step: 0,
                totalSteps: session.totalSteps,
                xpEarned: session.xpEarned,
                xpAwarded: 0,
                badges: session.badges,
                animations,
                data: {
                    greeting: "Welcome back! Let's continue where you left off.",
                    resumed: true,
                },
                nextAction: 'choose_role',
                canSkip: false,
                canResume: true,
            };
        }
        // Get current question
        const questionData = this.getQuestionData(session);
        return {
            sessionId: session.sessionId,
            step: session.step,
            totalSteps: session.totalSteps,
            xpEarned: session.xpEarned,
            xpAwarded: 0,
            badges: session.badges,
            animations,
            data: {
                resumed: true,
                message: "Welcome back! Let's continue.",
                ...questionData,
            },
            nextAction: 'answer_question',
            canSkip: questionData.canSkip,
            canResume: true,
        };
    }
    /**
     * User chooses their role (hustler or client)
     */
    async chooseRole(sessionId, role) {
        const session = this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.role = role;
        session.step = 1;
        session.totalSteps = role === 'hustler' ? 5 : 3; // Dynamic question count!
        session.updatedAt = new Date();
        const xpAwarded = 15;
        session.xpEarned += xpAwarded;
        const badge = role === 'hustler' ? 'hustler_path' : 'client_path';
        session.badges.push(badge);
        this.saveSession(session);
        await GamificationService.awardXP(session.userId, xpAwarded, `chose_${role}_role`);
        const questionData = this.getQuestionData(session);
        return {
            sessionId,
            step: 1,
            totalSteps: session.totalSteps,
            xpEarned: session.xpEarned,
            xpAwarded,
            badges: session.badges,
            badgeAwarded: badge,
            animations: ['badge', 'glow'],
            data: {
                role,
                roleMessage: role === 'hustler'
                    ? `Let's build your hustler profile. Just ${session.totalSteps} quick questions!`
                    : `Tell me what you need. Only ${session.totalSteps} questions!`,
                ...questionData,
            },
            nextAction: 'answer_question',
            canSkip: questionData.canSkip,
            canResume: true,
        };
    }
    /**
     * Process an interview answer (or skip)
     */
    async answerQuestion(sessionId, questionKey, answer, skip = false) {
        const session = this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        // Validate skip is allowed
        const questions = session.role === 'hustler' ? HUSTLER_QUESTIONS : CLIENT_QUESTIONS;
        const currentQ = questions[session.step - 1];
        if (skip && !currentQ?.canSkip) {
            throw new Error('This question cannot be skipped');
        }
        // Save answer or mark as skipped
        if (skip) {
            session.skippedQuestions.push(questionKey);
        }
        else {
            session.answers[questionKey] = answer;
        }
        session.step += 1;
        session.updatedAt = new Date();
        // XP - less for skipped questions
        const xpAwarded = skip ? 10 : 25;
        session.xpEarned += xpAwarded;
        this.saveSession(session);
        await GamificationService.awardXP(session.userId, xpAwarded, skip ? 'question_skipped' : 'onboarding_answer');
        // Check if interview complete
        if (session.step > session.totalSteps) {
            return this.completeOnboarding(session);
        }
        const questionData = this.getQuestionData(session);
        const animations = skip ? ['pulse'] : ['sparkle'];
        return {
            sessionId,
            step: session.step,
            totalSteps: session.totalSteps,
            xpEarned: session.xpEarned,
            xpAwarded,
            badges: session.badges,
            animations,
            data: questionData,
            nextAction: session.step > session.totalSteps ? 'complete' : 'answer_question',
            canSkip: questionData.canSkip,
            canResume: true,
        };
    }
    /**
     * Get question data for current step
     */
    getQuestionData(session) {
        const questions = session.role === 'hustler' ? HUSTLER_QUESTIONS : CLIENT_QUESTIONS;
        const q = questions[session.step - 1];
        if (!q) {
            return { question: 'Complete!', options: [], canSkip: false };
        }
        return {
            questionKey: q.key,
            question: q.question,
            options: q.options,
            allowFreeText: true,
            canSkip: q.canSkip,
            xpForAnswer: q.canSkip ? 10 : 25,
            progressPercent: Math.round((session.step / session.totalSteps) * 100),
        };
    }
    /**
     * Complete onboarding - build profile, create quest, show money path
     */
    async completeOnboarding(session) {
        // Build profile from answers
        const profile = await this.buildProfile(session);
        session.profile = profile;
        // Generate first quest
        const quest = await this.generateFirstQuest(session);
        // Calculate verification level based on XP
        session.verificationLevel = this.calculateVerificationLevel(session.xpEarned);
        // For hustlers, generate money path and recommendations
        let moneyPath = null;
        let recommendations = null;
        if (session.role === 'hustler') {
            moneyPath = await this.generateMoneyPath(profile);
            recommendations = await this.getInstantRecommendations(session.userId, profile);
        }
        // Final XP bonus
        const completionXP = 100;
        session.xpEarned += completionXP;
        session.badges.push('onboarding_complete');
        // Bonus badge for no skips
        if (session.skippedQuestions.length === 0) {
            session.badges.push('completionist');
            session.xpEarned += 25;
        }
        session.updatedAt = new Date();
        this.saveSession(session);
        await GamificationService.awardXP(session.userId, completionXP, 'onboarding_complete');
        // Mark onboarding as complete for this user
        completedOnboarding.add(session.userId);
        // Build animations list
        const animations = ['confetti', 'levelUp', 'badge'];
        if (session.skippedQuestions.length === 0)
            animations.push('sparkle');
        if (session.verificationLevel > 0)
            animations.push('glow');
        return {
            sessionId: session.sessionId,
            step: session.step,
            totalSteps: session.totalSteps,
            xpEarned: session.xpEarned,
            xpAwarded: completionXP + (session.skippedQuestions.length === 0 ? 25 : 0),
            badges: session.badges,
            badgeAwarded: 'onboarding_complete',
            animations,
            data: {
                profile,
                quest,
                moneyPath,
                recommendations,
                streakStarted: true,
                streakDay: 1,
                verificationLevel: session.verificationLevel,
                verificationInfo: VERIFICATION_LEVELS[session.verificationLevel],
                nextVerificationAt: this.getNextVerificationXP(session.verificationLevel),
                yourReferralCode: session.referralCode,
                skippedCount: session.skippedQuestions.length,
                completionMessage: session.role === 'hustler'
                    ? `You're ready to hustle! ${moneyPath?.motivationalMessage || "Let's get you earning."}`
                    : 'Your profile is set! Post your first task and we\'ll find the perfect hustler.',
            },
            nextAction: session.role === 'hustler' ? 'view_tasks' : 'create_task',
            canSkip: false,
            canResume: false,
        };
    }
    /**
     * Build profile from interview answers using AI
     */
    async buildProfile(session) {
        const prompt = ONBOARDING_PROFILE_BUILDER_PROMPT
            .replace('{role}', session.role || 'hustler')
            .replace('{answers}', JSON.stringify(session.answers, null, 2));
        const result = await modelRouter.generateRouted('planning', prompt, {
            temperature: 0.3,
            maxTokens: 300,
        });
        try {
            return JSON.parse(result.content);
        }
        catch {
            // Fallback profile
            if (session.role === 'hustler') {
                return {
                    skills: ['errands', 'delivery'],
                    hasVehicle: session.answers.q2?.toLowerCase() || 'none',
                    neighborhood: session.answers.q3 || 'Seattle',
                    availability: [session.answers.q4?.toLowerCase() || 'flexible'],
                    bio: 'New hustler ready to earn',
                    suggestedCategories: ['errands', 'delivery'],
                    estimatedHourlyRate: 22,
                };
            }
            return {
                typicalNeeds: [session.answers.q1?.toLowerCase() || 'errands'],
                neighborhood: session.answers.q2 || 'Seattle',
                budgetRange: session.answers.q3 || 'medium',
            };
        }
    }
    /**
     * Generate money path (earnings projection) for hustlers
     */
    async generateMoneyPath(profile) {
        const now = new Date();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const hours = now.getHours();
        const timeOfDay = hours < 12 ? 'morning' : hours < 17 ? 'afternoon' : 'evening';
        const prompt = MONEY_PATH_PROMPT
            .replace('{profile}', JSON.stringify(profile))
            .replace('{dayOfWeek}', days[now.getDay()])
            .replace('{timeOfDay}', timeOfDay);
        const result = await modelRouter.generateRouted('planning', prompt, {
            temperature: 0.7,
            maxTokens: 400,
        });
        try {
            return JSON.parse(result.content);
        }
        catch {
            return {
                weeklyGoal: 300,
                dailyBreakdown: [
                    { day: 'Today', tasks: 2, earnings: 50, hotspot: 'Capitol Hill' },
                    { day: 'Tomorrow', tasks: 3, earnings: 75, hotspot: 'UW' },
                ],
                peakHours: ['5pm-8pm weekdays', '10am-2pm weekends'],
                topCategories: profile.suggestedCategories || ['errands'],
                motivationalMessage: 'You could make $300 this week. Let\'s go!',
                tips: ['Start with tasks near you', 'Build your rating with small tasks first'],
            };
        }
    }
    /**
     * Generate first quest for new user
     */
    async generateFirstQuest(session) {
        const prompt = FIRST_QUEST_PROMPT
            .replace('{role}', session.role || 'hustler')
            .replace('{profile}', JSON.stringify(session.profile || {}));
        const result = await modelRouter.generateRouted('intent', prompt, {
            temperature: 0.8,
            maxTokens: 200,
        });
        try {
            return JSON.parse(result.content);
        }
        catch {
            return {
                title: session.role === 'hustler' ? 'First Blood' : 'First Post',
                description: session.role === 'hustler'
                    ? 'Complete your first task within 24 hours'
                    : 'Post your first task within 24 hours',
                xpReward: 500,
                badge: 'founder',
                expiresInHours: 24,
                motivationalMessage: "You're one of the first. Make history.",
            };
        }
    }
    /**
     * Get instant task recommendations for new hustler
     */
    async getInstantRecommendations(userId, profile) {
        const skills = (profile.suggestedCategories || profile.skills || ['errands']);
        const allTasks = await TaskService.searchTasks({ limit: 20 });
        const recommendations = allTasks
            .filter(task => skills.includes(task.category))
            .slice(0, 3)
            .map(task => ({
            id: task.id,
            title: task.title,
            category: task.category,
            price: task.recommendedPrice,
            location: task.locationText || 'Seattle',
            matchReason: `Matches your ${task.category} skill`,
        }));
        if (recommendations.length === 0) {
            return [
                { title: 'Grocery Delivery', category: 'delivery', price: 35, location: 'Capitol Hill', matchReason: 'High demand now' },
                { title: 'Dog Walking', category: 'pet_care', price: 30, location: 'Ballard', matchReason: 'Great for new hustlers' },
                { title: 'Moving Help', category: 'moving', price: 60, location: 'UW Area', matchReason: 'Quick cash' },
            ];
        }
        return recommendations;
    }
    /**
     * Generate a unique referral code for user
     */
    generateReferralCode(userId) {
        const existingCode = userReferrals.get(userId);
        if (existingCode)
            return existingCode;
        const code = `HUSTLE${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        referralCodes.set(code, {
            code,
            ownerId: userId,
            uses: 0,
            xpEarned: 0,
            createdAt: new Date(),
        });
        userReferrals.set(userId, code);
        return code;
    }
    /**
     * Get referral stats for a user
     */
    getReferralStats(userId) {
        const code = userReferrals.get(userId);
        if (!code)
            return null;
        const record = referralCodes.get(code);
        if (!record)
            return null;
        return {
            code: record.code,
            uses: record.uses,
            xpEarned: record.xpEarned,
        };
    }
    /**
     * Calculate verification level based on XP
     */
    calculateVerificationLevel(xp) {
        for (let level = 5; level >= 0; level--) {
            if (xp >= VERIFICATION_LEVELS[level].xpRequired) {
                return level;
            }
        }
        return 0;
    }
    /**
     * Get XP needed for next verification level
     */
    getNextVerificationXP(currentLevel) {
        if (currentLevel >= 5)
            return null;
        return VERIFICATION_LEVELS[(currentLevel + 1)].xpRequired;
    }
    /**
     * Get verification level info
     */
    getVerificationInfo(level) {
        return VERIFICATION_LEVELS[level];
    }
    /**
     * Get onboarding status for a user
     * This allows the frontend to determine if a user needs to go through onboarding
     */
    getOnboardingStatus(userId) {
        // Check if user has completed onboarding
        if (completedOnboarding.has(userId)) {
            return {
                userId,
                onboardingComplete: true,
                message: 'Welcome to HustleXP!',
            };
        }
        // Check if user has an active session
        const sessionId = userSessions.get(userId);
        if (sessionId) {
            const session = sessionsMemory.get(sessionId);
            if (session) {
                // Check if session indicates completion (step > totalSteps)
                if (session.step > session.totalSteps) {
                    completedOnboarding.add(userId);
                    return {
                        userId,
                        onboardingComplete: true,
                        message: 'Welcome to HustleXP!',
                    };
                }
                // User has started but not completed onboarding
                return {
                    userId,
                    onboardingComplete: false,
                    currentStep: session.step,
                    totalSteps: session.totalSteps,
                    role: session.role,
                    message: 'Continue your onboarding to unlock all features!',
                };
            }
        }
        // User has never started onboarding
        return {
            userId,
            onboardingComplete: false,
            message: 'Start your journey with HustleXP!',
        };
    }
    // Session management
    saveSession(session) {
        sessionsMemory.set(session.sessionId, session);
        serviceLogger.debug({ sessionId: session.sessionId }, 'Session saved');
    }
    getSession(sessionId) {
        return sessionsMemory.get(sessionId) || null;
    }
}
export const OnboardingService = new OnboardingServiceClass();
//# sourceMappingURL=OnboardingService.js.map