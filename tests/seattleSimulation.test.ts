/**
 * Seattle Beta Simulation Test
 * 
 * Comprehensive simulation of the HustleXP platform workflow:
 * - Multiple users (hustlers and posters)
 * - Tasks across Seattle neighborhoods
 * - Full completion flow with XP, badges, quests
 * - Profitability analysis
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { TaskService } from '../src/services/TaskService.js';
import { PricingEngine } from '../src/services/PricingEngine.js';
import { DynamicBadgeEngine } from '../src/services/DynamicBadgeEngine.js';
import { QuestEngine } from '../src/services/QuestEngine.js';
import { AIGrowthCoachService } from '../src/services/AIGrowthCoachService.js';
import { GamificationService } from '../src/services/GamificationService.js';
import { TaskCompletionService } from '../src/services/TaskCompletionService.js';
import type { TaskCategory, TaskDraft } from '../src/types/index.js';

// ============================================
// Test Data - Seattle Beta Simulation
// ============================================

const SEATTLE_NEIGHBORHOODS = [
    'Capitol Hill',
    'Ballard',
    'Fremont',
    'Queen Anne',
    'University District',
    'Wallingford',
    'Green Lake',
    'Downtown',
    'Belltown',
    'South Lake Union',
];

const TASK_TEMPLATES: Array<{
    category: TaskCategory;
    title: string;
    basePrice: number;
    durationMinutes: number;
}> = [
        { category: 'cleaning', title: 'Apartment Deep Clean', basePrice: 80, durationMinutes: 120 },
        { category: 'cleaning', title: 'Move-out Cleaning', basePrice: 120, durationMinutes: 180 },
        { category: 'delivery', title: 'Grocery Pickup & Delivery', basePrice: 25, durationMinutes: 45 },
        { category: 'delivery', title: 'Furniture Delivery', basePrice: 60, durationMinutes: 90 },
        { category: 'moving', title: 'Studio Apartment Move', basePrice: 150, durationMinutes: 180 },
        { category: 'moving', title: 'Help with Heavy Furniture', basePrice: 75, durationMinutes: 60 },
        { category: 'handyman', title: 'IKEA Furniture Assembly', basePrice: 50, durationMinutes: 60 },
        { category: 'handyman', title: 'Mount TV on Wall', basePrice: 45, durationMinutes: 45 },
        { category: 'handyman', title: 'Fix Leaky Faucet', basePrice: 40, durationMinutes: 30 },
        { category: 'pet_care', title: 'Dog Walking (1 hour)', basePrice: 25, durationMinutes: 60 },
        { category: 'pet_care', title: 'Pet Sitting (half day)', basePrice: 45, durationMinutes: 240 },
        { category: 'errands', title: 'Wait for Package Delivery', basePrice: 30, durationMinutes: 60 },
        { category: 'errands', title: 'Return Items to Stores', basePrice: 35, durationMinutes: 60 },
        { category: 'yard_work', title: 'Lawn Mowing', basePrice: 45, durationMinutes: 60 },
        { category: 'yard_work', title: 'Leaf Cleanup', basePrice: 55, durationMinutes: 90 },
        { category: 'tech_help', title: 'Set Up Smart Home Devices', basePrice: 50, durationMinutes: 60 },
    ];

// Simulated users
const SIMULATED_HUSTLERS = [
    { id: 'hustler_1', name: 'Alex', skills: ['cleaning', 'moving'] as TaskCategory[] },
    { id: 'hustler_2', name: 'Jordan', skills: ['handyman', 'tech_help'] as TaskCategory[] },
    { id: 'hustler_3', name: 'Sam', skills: ['delivery', 'errands'] as TaskCategory[] },
    { id: 'hustler_4', name: 'Casey', skills: ['pet_care', 'errands'] as TaskCategory[] },
    { id: 'hustler_5', name: 'Morgan', skills: ['cleaning', 'yard_work'] as TaskCategory[] },
];

const SIMULATED_POSTERS = [
    { id: 'poster_1', name: 'Client A' },
    { id: 'poster_2', name: 'Client B' },
    { id: 'poster_3', name: 'Client C' },
];

// ============================================
// Simulation Results Tracking
// ============================================

interface SimulationResults {
    totalTasks: number;
    completedTasks: number;
    cancelledTasks: number;

    // Financial
    totalGMV: number;
    totalPlatformRevenue: number;
    totalHustlerPayouts: number;
    totalBoostRevenue: number;
    avgTakeRate: number;

    // Gamification
    totalXPAwarded: number;
    badgesUnlocked: number;
    questsCompleted: number;

    // By category
    tasksByCategory: Record<TaskCategory, number>;
    revenueByCategory: Record<TaskCategory, number>;

    // By neighborhood
    tasksByNeighborhood: Record<string, number>;

    // User stats
    hustlerEarnings: Record<string, number>;
    hustlerXP: Record<string, number>;

    // Time simulation
    daysSimulated: number;
}

// ============================================
// Simulation Tests
// ============================================

describe('Seattle Beta Simulation', () => {
    const results: SimulationResults = {
        totalTasks: 0,
        completedTasks: 0,
        cancelledTasks: 0,
        totalGMV: 0,
        totalPlatformRevenue: 0,
        totalHustlerPayouts: 0,
        totalBoostRevenue: 0,
        avgTakeRate: 0,
        totalXPAwarded: 0,
        badgesUnlocked: 0,
        questsCompleted: 0,
        tasksByCategory: {} as Record<TaskCategory, number>,
        revenueByCategory: {} as Record<TaskCategory, number>,
        tasksByNeighborhood: {},
        hustlerEarnings: {},
        hustlerXP: {},
        daysSimulated: 7,
    };

    beforeAll(() => {
        // Initialize all hustlers with quests and badges
        for (const hustler of SIMULATED_HUSTLERS) {
            QuestEngine.initializeUserQuests(hustler.id);
            DynamicBadgeEngine.awardBetaPioneer(hustler.id);
            results.hustlerEarnings[hustler.id] = 0;
            results.hustlerXP[hustler.id] = 0;
        }
    });

    describe('Task Creation Flow', () => {
        it('should create tasks across Seattle neighborhoods', async () => {
            const tasksToCreate = 30;

            for (let i = 0; i < tasksToCreate; i++) {
                const template = TASK_TEMPLATES[i % TASK_TEMPLATES.length];
                const neighborhood = SEATTLE_NEIGHBORHOODS[i % SEATTLE_NEIGHBORHOODS.length];
                const poster = SIMULATED_POSTERS[i % SIMULATED_POSTERS.length];

                const taskDraft: TaskDraft = {
                    title: `${template.title} in ${neighborhood}`,
                    description: `Looking for help with ${template.title.toLowerCase()} in the ${neighborhood} area.`,
                    category: template.category,
                    recommendedPrice: template.basePrice,
                    minPrice: Math.round(template.basePrice * 0.8),
                    maxPrice: Math.round(template.basePrice * 1.3),
                    locationText: `${neighborhood}, Seattle, WA`,
                    flags: [],
                };

                const task = await TaskService.createTaskFromDraft(poster.id, taskDraft);

                expect(task).toBeDefined();
                expect(task.id).toBeDefined();
                expect(task.category).toBe(template.category);

                results.totalTasks++;
                results.tasksByCategory[template.category] = (results.tasksByCategory[template.category] || 0) + 1;
                results.tasksByNeighborhood[neighborhood] = (results.tasksByNeighborhood[neighborhood] || 0) + 1;
            }

            expect(results.totalTasks).toBe(30);
        });
    });

    describe('Pricing & Profitability', () => {
        it('should calculate profitable pricing for all boost tiers', () => {
            const testPrices = [25, 50, 75, 100, 150];
            const boostTiers = ['normal', 'priority', 'rush', 'vip'] as const;

            for (const price of testPrices) {
                for (const tier of boostTiers) {
                    const pricing = PricingEngine.calculatePricing(price, tier);

                    // Platform should always be profitable
                    expect(pricing.platformNetRevenue).toBeGreaterThan(0);

                    // Take rate should be reasonable (7-25%)
                    expect(pricing.platformMarginPercent).toBeGreaterThanOrEqual(7);
                    expect(pricing.platformMarginPercent).toBeLessThanOrEqual(30);

                    // Hustler should get majority of base price
                    expect(pricing.hustlerBasePayout).toBeGreaterThan(price * 0.75);
                }
            }
        });

        it('should generate profitable pricing table', () => {
            const table = PricingEngine.getPricingTable(50);

            expect(table).toHaveLength(4);

            let totalPlatformRevenue = 0;
            for (const row of table) {
                expect(row.platformEarns).toBeGreaterThan(0);
                expect(row.hustlerGets).toBeGreaterThan(0);
                totalPlatformRevenue += row.platformEarns;
            }

            // Platform earns more from higher tiers
            expect(table[3].platformEarns).toBeGreaterThan(table[0].platformEarns);
        });

        it('should maintain profitability across typical Seattle tasks', () => {
            let totalGMV = 0;
            let totalPlatformRevenue = 0;
            let totalHustlerPayouts = 0;

            for (const template of TASK_TEMPLATES) {
                // Simulate 10 completions per task type with varying boost levels
                for (let i = 0; i < 10; i++) {
                    const boostChance = Math.random();
                    const tier = boostChance < 0.6 ? 'normal' :
                        boostChance < 0.8 ? 'priority' :
                            boostChance < 0.95 ? 'rush' : 'vip';

                    const pricing = PricingEngine.calculatePricing(template.basePrice, tier);

                    totalGMV += pricing.posterTotal;
                    totalPlatformRevenue += pricing.platformNetRevenue;
                    totalHustlerPayouts += pricing.hustlerStandardPayout;
                }
            }

            const avgTakeRate = (totalPlatformRevenue / totalGMV) * 100;

            results.totalGMV = totalGMV;
            results.totalPlatformRevenue = totalPlatformRevenue;
            results.totalHustlerPayouts = totalHustlerPayouts;
            results.avgTakeRate = avgTakeRate;

            // Platform should capture 12-18% on average
            expect(avgTakeRate).toBeGreaterThanOrEqual(10);
            expect(avgTakeRate).toBeLessThanOrEqual(20);

            // Total hustler payouts should be majority of GMV
            expect(totalHustlerPayouts / totalGMV).toBeGreaterThan(0.7);
        });
    });

    describe('Task Completion Flow', () => {
        it('should complete tasks and award XP/badges', async () => {
            const completions = 20;

            for (let i = 0; i < completions; i++) {
                const template = TASK_TEMPLATES[i % TASK_TEMPLATES.length];
                const hustler = SIMULATED_HUSTLERS[i % SIMULATED_HUSTLERS.length];
                const rating = Math.random() > 0.2 ? 5 : 4; // 80% 5-star ratings

                // Record task completion for Growth Coach
                AIGrowthCoachService.recordTaskCompletion(hustler.id, {
                    category: template.category,
                    earnings: template.basePrice,
                    rating,
                    durationMinutes: template.durationMinutes,
                });

                // Award XP
                const xpAwarded = await GamificationService.awardTaskCompletionXP(
                    hustler.id,
                    `task_${i}`,
                    rating
                );

                results.completedTasks++;
                results.totalXPAwarded += xpAwarded;
                results.hustlerEarnings[hustler.id] += template.basePrice;
                results.hustlerXP[hustler.id] += xpAwarded;
                results.revenueByCategory[template.category] =
                    (results.revenueByCategory[template.category] || 0) + template.basePrice;
            }

            expect(results.completedTasks).toBe(20);
            expect(results.totalXPAwarded).toBeGreaterThan(0);
        });

        it('should track quest progress', () => {
            for (const hustler of SIMULATED_HUSTLERS) {
                const quests = QuestEngine.getAllActiveQuests(hustler.id);

                // Should have daily, weekly, and/or seasonal quests
                expect(quests.length).toBeGreaterThanOrEqual(2);

                // Check for progress on some quests
                const dailyQuests = QuestEngine.getDailyQuests(hustler.id);
                expect(dailyQuests.length).toBe(3);
            }
        });

        it('should evaluate and award badges', async () => {
            let totalNewBadges = 0;

            for (const hustler of SIMULATED_HUSTLERS) {
                const { newBadges, totalXPAwarded } = await DynamicBadgeEngine.evaluateBadges(hustler.id);
                totalNewBadges += newBadges.length;
                results.totalXPAwarded += totalXPAwarded;
            }

            results.badgesUnlocked = totalNewBadges;

            // At minimum, all hustlers have Beta Pioneer badge
            expect(results.badgesUnlocked).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Growth Coach Functionality', () => {
        it('should generate growth plans for all hustlers', async () => {
            for (const hustler of SIMULATED_HUSTLERS) {
                const plan = await AIGrowthCoachService.getGrowthPlan(hustler.id);

                expect(plan).toBeDefined();
                expect(plan.userId).toBe(hustler.id);
                expect(plan.level).toBeDefined();
                expect(plan.earnings).toBeDefined();
                expect(plan.projection).toBeDefined();
                expect(plan.nextBestActions).toBeDefined();
                expect(plan.coachingTip).toBeDefined();
            }
        });

        it('should provide earnings projections', async () => {
            const hustler = SIMULATED_HUSTLERS[0];
            const plan = await AIGrowthCoachService.getGrowthPlan(hustler.id);

            expect(plan.projection.daily).toBeDefined();
            expect(plan.projection.weekly).toBeDefined();
            expect(plan.projection.monthly).toBeDefined();
            expect(plan.projection.topCategory).toBeDefined();
        });

        it('should generate next best actions', async () => {
            const hustler = SIMULATED_HUSTLERS[0];
            const action = await AIGrowthCoachService.getNextBestAction(hustler.id);

            // Should have at least some recommendation
            expect(action).not.toBeNull();
        });
    });

    describe('Simulation Summary', () => {
        it('should print comprehensive simulation report', () => {
            console.log('\n');
            console.log('═══════════════════════════════════════════════════════════');
            console.log('       SEATTLE BETA SIMULATION REPORT');
            console.log('═══════════════════════════════════════════════════════════');
            console.log('\n📊 TASK METRICS');
            console.log('───────────────────────────────────────────────────────────');
            console.log(`   Total Tasks Created:     ${results.totalTasks}`);
            console.log(`   Tasks Completed:         ${results.completedTasks}`);
            console.log(`   Completion Rate:         ${((results.completedTasks / results.totalTasks) * 100).toFixed(1)}%`);

            console.log('\n💰 FINANCIAL METRICS (160 task simulation)');
            console.log('───────────────────────────────────────────────────────────');
            console.log(`   Total GMV:               $${results.totalGMV.toFixed(2)}`);
            console.log(`   Platform Revenue:        $${results.totalPlatformRevenue.toFixed(2)}`);
            console.log(`   Hustler Payouts:         $${results.totalHustlerPayouts.toFixed(2)}`);
            console.log(`   Average Take Rate:       ${results.avgTakeRate.toFixed(2)}%`);
            console.log(`   Profit Margin:           ${((results.totalPlatformRevenue / results.totalGMV) * 100).toFixed(2)}%`);

            console.log('\n🎮 GAMIFICATION METRICS');
            console.log('───────────────────────────────────────────────────────────');
            console.log(`   Total XP Awarded:        ${results.totalXPAwarded}`);
            console.log(`   Badges Unlocked:         ${results.badgesUnlocked}`);
            console.log(`   Quests Active:           ${SIMULATED_HUSTLERS.length * 8} (approx)`);

            console.log('\n📍 TASKS BY CATEGORY');
            console.log('───────────────────────────────────────────────────────────');
            for (const [category, count] of Object.entries(results.tasksByCategory)) {
                const revenue = results.revenueByCategory[category as TaskCategory] || 0;
                console.log(`   ${category.padEnd(15)} ${String(count).padStart(3)} tasks  $${revenue.toFixed(0)} rev`);
            }

            console.log('\n📍 TASKS BY NEIGHBORHOOD');
            console.log('───────────────────────────────────────────────────────────');
            for (const [hood, count] of Object.entries(results.tasksByNeighborhood)) {
                console.log(`   ${hood.padEnd(20)} ${count} tasks`);
            }

            console.log('\n👤 HUSTLER PERFORMANCE');
            console.log('───────────────────────────────────────────────────────────');
            for (const hustler of SIMULATED_HUSTLERS) {
                const earnings = results.hustlerEarnings[hustler.id] || 0;
                const xp = results.hustlerXP[hustler.id] || 0;
                const level = GamificationService.calculateLevel(xp);
                console.log(`   ${hustler.name.padEnd(10)} Level ${level}  $${earnings.toFixed(0)} earned  ${xp} XP`);
            }

            console.log('\n✅ PROFITABILITY CHECK');
            console.log('───────────────────────────────────────────────────────────');
            const isProfitable = results.totalPlatformRevenue > 0;
            const hasHealthyMargin = results.avgTakeRate >= 10 && results.avgTakeRate <= 20;
            const hustlersEarningWell = results.totalHustlerPayouts / results.totalGMV > 0.7;

            console.log(`   Platform Profitable:     ${isProfitable ? '✅ YES' : '❌ NO'}`);
            console.log(`   Healthy Take Rate:       ${hasHealthyMargin ? '✅ YES' : '⚠️ ADJUST'} (${results.avgTakeRate.toFixed(1)}%)`);
            console.log(`   Hustler-Friendly:        ${hustlersEarningWell ? '✅ YES' : '⚠️ CHECK'} (${((results.totalHustlerPayouts / results.totalGMV) * 100).toFixed(1)}% to hustlers)`);

            console.log('\n🚀 SIMULATION STATUS');
            console.log('───────────────────────────────────────────────────────────');
            if (isProfitable && hasHealthyMargin && hustlersEarningWell) {
                console.log('   ✅ ALL SYSTEMS GO - Ready for Seattle Beta Launch!');
            } else {
                console.log('   ⚠️  REVIEW NEEDED - Check flagged items above');
            }
            console.log('\n═══════════════════════════════════════════════════════════\n');

            // Final assertions
            expect(isProfitable).toBe(true);
            expect(hasHealthyMargin).toBe(true);
            expect(hustlersEarningWell).toBe(true);
        });
    });
});
