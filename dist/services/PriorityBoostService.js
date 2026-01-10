import { v4 as uuidv4 } from 'uuid';
import { modelRouter } from '../ai/router.js';
import { GamificationService } from './GamificationService.js';
import { serviceLogger } from '../utils/logger.js';
export const BOOST_TIERS = {
    normal: {
        tier: 'normal',
        name: 'Standard',
        feeMultiplier: 1.0,
        hustlerXPBoost: 1.0,
        matchingPriority: 1,
        searchRadiusBoost: 0,
        acceptancePriority: false,
        instantMatch: false,
        topHustlersOnly: false,
        color: '#6B7280',
        icon: '📋',
    },
    priority: {
        tier: 'priority',
        name: 'Priority',
        feeMultiplier: 1.05, // +5% fee
        hustlerXPBoost: 1.25, // +25% XP for hustler
        matchingPriority: 2,
        searchRadiusBoost: 2, // +2 miles
        acceptancePriority: true,
        instantMatch: false,
        topHustlersOnly: false,
        color: '#3B82F6',
        icon: '⚡',
    },
    rush: {
        tier: 'rush',
        name: 'Rush',
        feeMultiplier: 1.10, // +10% fee
        hustlerXPBoost: 1.5, // +50% XP for hustler
        matchingPriority: 3,
        searchRadiusBoost: 5, // +5 miles
        acceptancePriority: true,
        instantMatch: true,
        topHustlersOnly: false,
        color: '#F59E0B',
        icon: '🚀',
    },
    vip: {
        tier: 'vip',
        name: 'VIP',
        feeMultiplier: 1.20, // +20% fee
        hustlerXPBoost: 2.0, // +100% XP for hustler
        matchingPriority: 4,
        searchRadiusBoost: 10, // +10 miles
        acceptancePriority: true,
        instantMatch: true,
        topHustlersOnly: true, // Only top hustlers
        color: '#8B5CF6',
        icon: '👑',
    },
};
// ============================================
// In-memory stores
// ============================================
const boostedTasks = new Map();
const taskPlans = new Map();
// ============================================
// Priority Boost Service
// ============================================
class PriorityBoostServiceClass {
    /**
     * Calculate boost options for a task
     */
    getBoostOptions(basePrice) {
        return Object.entries(BOOST_TIERS).map(([tier, config]) => {
            const totalPrice = Math.round(basePrice * config.feeMultiplier);
            const platformFee = totalPrice - basePrice;
            const hustlerPayout = basePrice; // Hustler always gets base price
            return {
                tier: tier,
                config,
                totalPrice,
                platformFee,
                hustlerPayout,
                hustlerXPBoost: config.hustlerXPBoost === 1 ? 'Standard XP' : `+${Math.round((config.hustlerXPBoost - 1) * 100)}% XP`,
            };
        });
    }
    /**
     * Apply boost to a task
     */
    applyBoost(taskId, basePrice, tier) {
        const config = BOOST_TIERS[tier];
        const boostedPrice = Math.round(basePrice * config.feeMultiplier);
        const boosted = {
            taskId,
            boostTier: tier,
            boostConfig: config,
            originalPrice: basePrice,
            boostedPrice,
            platformFee: boostedPrice - basePrice,
            hustlerPayout: basePrice,
            hustlerXPBoost: config.hustlerXPBoost,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
            createdAt: new Date(),
        };
        boostedTasks.set(taskId, boosted);
        serviceLogger.info({ taskId, tier, boostedPrice }, 'Boost applied to task');
        return boosted;
    }
    /**
     * Get boost info for a task
     */
    getTaskBoost(taskId) {
        return boostedTasks.get(taskId) || null;
    }
    /**
     * Check if task should be shown to hustler based on boost level
     */
    shouldShowToHustler(taskId, hustlerLevel) {
        const boost = boostedTasks.get(taskId);
        if (!boost) {
            return { show: true, priority: 1, badges: [] };
        }
        const config = boost.boostConfig;
        const badges = [];
        // VIP tasks only shown to Level 5+ hustlers
        if (config.topHustlersOnly && hustlerLevel < 5) {
            return { show: false, priority: 0, badges: [] };
        }
        // Build badges
        if (config.tier !== 'normal') {
            badges.push(`${config.icon} ${config.name}`);
        }
        if (config.hustlerXPBoost > 1) {
            badges.push(`+${Math.round((config.hustlerXPBoost - 1) * 100)}% XP`);
        }
        if (config.instantMatch) {
            badges.push('⚡ Instant');
        }
        return {
            show: true,
            priority: config.matchingPriority,
            badges,
        };
    }
}
// ============================================
// Hustler Task Planner Service
// ============================================
const TASK_PLANNER_PROMPT = `You are an AI task planner for HustleXP hustlers. Break down this task into clear micro-objectives.

Task: {taskTitle}
Category: {category}
Description: {description}
Duration estimate: {durationMinutes} minutes
Location: {location}

Generate a step-by-step plan with:
1. 3-6 clear micro-objectives in order
2. Safety notes if applicable
3. Recommended tools/supplies
4. Pre-arrival tips (like "message for gate code")

Respond with JSON:
{
  "objectives": [
    {"title": "Arrive and confirm location", "description": "Check in with client, confirm scope", "minutes": 5, "xp": 10, "requiresPhoto": false},
    {"title": "Begin main task", "description": "Start the core work", "minutes": 30, "xp": 25, "requiresPhoto": true}
  ],
  "safetyNotes": [
    {"type": "tip", "message": "Lift with your legs, not back", "icon": "💪"}
  ],
  "tools": [
    {"name": "Work gloves", "reason": "Protect hands when moving items", "required": false, "icon": "🧤"}
  ],
  "preArrivalTips": ["Message client for parking instructions", "Confirm exact address"]
}`;
class HustlerTaskPlannerClass {
    /**
     * Generate a task plan for a hustler
     */
    async generatePlan(taskId, hustlerId, task, boostMultiplier = 1.0) {
        // Generate AI plan
        const prompt = TASK_PLANNER_PROMPT
            .replace('{taskTitle}', task.title)
            .replace('{category}', task.category)
            .replace('{description}', task.description)
            .replace('{durationMinutes}', String(task.durationMinutes))
            .replace('{location}', task.location);
        const result = await modelRouter.generateRouted('planning', prompt, {
            temperature: 0.5,
            maxTokens: 600,
        });
        let planData;
        try {
            planData = JSON.parse(result.content);
        }
        catch {
            // Fallback plan
            planData = this.generateFallbackPlan(task);
        }
        // Convert to MicroObjectives
        const objectives = planData.objectives.map((obj, index) => ({
            id: uuidv4(),
            order: index + 1,
            title: obj.title,
            description: obj.description,
            estimatedMinutes: obj.minutes,
            xpReward: Math.round(obj.xp * boostMultiplier),
            status: 'pending',
            requiresPhoto: obj.requiresPhoto,
        }));
        // Calculate XP
        const baseXP = objectives.reduce((sum, obj) => sum + obj.xpReward, 0);
        const punctualityBonus = 50; // Bonus for on-time arrival
        const communicationBonus = 25; // Bonus for good communication
        const potentialXP = Math.round((baseXP + punctualityBonus + communicationBonus) * boostMultiplier);
        const plan = {
            planId: uuidv4(),
            taskId,
            hustlerId,
            taskTitle: task.title,
            taskCategory: task.category,
            estimatedDuration: task.durationMinutes,
            objectives,
            completedObjectives: 0,
            totalObjectives: objectives.length,
            progressPercent: 0,
            safetyNotes: planData.safetyNotes.map(note => ({
                type: note.type,
                message: note.message,
                icon: note.icon,
            })),
            recommendedTools: planData.tools.map(tool => ({
                name: tool.name,
                reason: tool.reason,
                required: tool.required,
                icon: tool.icon,
            })),
            preArrivalTips: planData.preArrivalTips,
            baseXP,
            bonusXP: 0,
            boostMultiplier,
            currentXP: 0,
            potentialXP,
            punctualityBonus: false,
            communicationScore: 0,
            qualityCheckpoints: [
                { type: 'arrival', completed: false, xpBonus: 25 },
                { type: 'progress', completed: false, xpBonus: 15 },
                { type: 'photo', completed: false, xpBonus: 20 },
                { type: 'completion', completed: false, xpBonus: 50 },
            ],
            acceptedAt: new Date(),
            estimatedCompletionAt: new Date(Date.now() + task.durationMinutes * 60 * 1000),
            status: 'accepted',
        };
        taskPlans.set(plan.planId, plan);
        serviceLogger.info({ planId: plan.planId, taskId, objectives: objectives.length }, 'Task plan generated');
        return plan;
    }
    /**
     * Update objective status
     */
    async updateObjective(planId, objectiveId, status, photoUrl, notes) {
        const plan = taskPlans.get(planId);
        if (!plan)
            throw new Error('Plan not found');
        const objective = plan.objectives.find(obj => obj.id === objectiveId);
        if (!objective)
            throw new Error('Objective not found');
        objective.status = status;
        if (photoUrl)
            objective.photoUrl = photoUrl;
        if (notes)
            objective.notes = notes;
        if (status === 'completed')
            objective.completedAt = new Date();
        // Award XP if completed
        let xpAwarded = 0;
        if (status === 'completed') {
            xpAwarded = objective.xpReward;
            plan.currentXP += xpAwarded;
            plan.completedObjectives = plan.objectives.filter(o => o.status === 'completed').length;
            plan.progressPercent = Math.round((plan.completedObjectives / plan.totalObjectives) * 100);
            await GamificationService.awardXP(plan.hustlerId, xpAwarded, `objective_completed: ${objective.title}`);
        }
        // Update plan status
        if (plan.objectives.every(o => o.status === 'completed' || o.status === 'skipped')) {
            plan.status = 'completed';
            plan.completedAt = new Date();
            // Award completion checkpoint
            const completionCheckpoint = plan.qualityCheckpoints.find(c => c.type === 'completion');
            if (completionCheckpoint && !completionCheckpoint.completed) {
                completionCheckpoint.completed = true;
                plan.bonusXP += completionCheckpoint.xpBonus;
                await GamificationService.awardXP(plan.hustlerId, completionCheckpoint.xpBonus, 'task_completion_bonus');
            }
        }
        taskPlans.set(planId, plan);
        return { plan, xpAwarded };
    }
    /**
     * Record checkpoint (arrival, photo, etc.)
     */
    async recordCheckpoint(planId, checkpointType) {
        const plan = taskPlans.get(planId);
        if (!plan)
            throw new Error('Plan not found');
        const checkpoint = plan.qualityCheckpoints.find(c => c.type === checkpointType);
        if (!checkpoint || checkpoint.completed) {
            return { plan, xpAwarded: 0 };
        }
        checkpoint.completed = true;
        plan.bonusXP += checkpoint.xpBonus;
        plan.currentXP += checkpoint.xpBonus;
        // Update plan status based on checkpoint
        if (checkpointType === 'arrival') {
            plan.status = 'in_progress';
            plan.startedAt = new Date();
            // Check punctuality
            const acceptedTime = plan.acceptedAt.getTime();
            const now = Date.now();
            const expectedArrival = acceptedTime + 30 * 60 * 1000; // 30 min window
            if (now <= expectedArrival) {
                plan.punctualityBonus = true;
                plan.bonusXP += 50;
                plan.currentXP += 50;
                await GamificationService.awardXP(plan.hustlerId, 50, 'punctuality_bonus');
            }
        }
        await GamificationService.awardXP(plan.hustlerId, checkpoint.xpBonus, `checkpoint_${checkpointType}`);
        taskPlans.set(planId, plan);
        return { plan, xpAwarded: checkpoint.xpBonus };
    }
    /**
     * Get plan by ID
     */
    getPlan(planId) {
        return taskPlans.get(planId) || null;
    }
    /**
     * Get plans for a hustler
     */
    getHustlerPlans(hustlerId) {
        return Array.from(taskPlans.values()).filter(plan => plan.hustlerId === hustlerId);
    }
    /**
     * Generate fallback plan
     */
    generateFallbackPlan(task) {
        return {
            objectives: [
                { title: 'Arrive and confirm', description: 'Meet client, confirm task details', minutes: 5, xp: 15, requiresPhoto: false },
                { title: 'Complete main task', description: task.title, minutes: task.durationMinutes - 10, xp: 50, requiresPhoto: true },
                { title: 'Final check and wrap up', description: 'Ensure task is complete, get client approval', minutes: 5, xp: 15, requiresPhoto: false },
            ],
            safetyNotes: [
                { type: 'tip', message: 'Take your time and prioritize safety', icon: '⚡' },
            ],
            tools: [],
            preArrivalTips: ['Confirm address with client', 'Check for parking availability'],
        };
    }
}
export const PriorityBoostService = new PriorityBoostServiceClass();
export const HustlerTaskPlanner = new HustlerTaskPlannerClass();
//# sourceMappingURL=PriorityBoostService.js.map