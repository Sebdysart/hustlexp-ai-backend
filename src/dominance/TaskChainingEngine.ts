/**
 * TASK CHAINING ENGINE (Phase 17 - Component 2)
 * 
 * Purpose: Detect when HustleXP becomes a workday, not a task.
 * 
 * Multi-task chaining happens when hustlers naturally perform
 * sequences of tasks:
 *   Moving → Cleanup → Furniture Assembly
 * 
 * This creates:
 * - Compound earnings loops
 * - Psychological commitment
 * - Switching cost through routine
 * 
 * CONSTRAINTS:
 * - ADVISORY ONLY: No forced routing
 * - NO KERNEL: Financial layer frozen
 * - READ-ONLY: Detection and measurement only
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';

const logger = serviceLogger.child({ module: 'TaskChaining' });

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// TYPES
// ============================================================

export interface TaskChain {
    id: string;
    hustlerId: string;
    zone: string;
    date: Date;

    // Chain details
    tasks: {
        taskId: string;
        category: string;
        earnings: number;
        completedAt: Date;
    }[];

    chainLength: number;
    totalEarnings: number;
    durationHours: number;

    // Analysis
    categorySequence: string[];
    isRecurringPattern: boolean;
}

export interface ZoneChainingMetrics {
    zone: string;
    generatedAt: Date;

    // Aggregate metrics
    chainStrength: number;          // 0-100
    avgChainLength: number;
    maxChainLength: number;
    earningsUpliftPct: number;      // % more earned via chaining

    // Patterns
    topPatterns: {
        sequence: string[];
        frequency: number;
        avgEarnings: number;
    }[];

    // Hustler distribution
    chainingHustlerPct: number;     // % of hustlers who chain
    superChainerCount: number;      // Hustlers with 4+ task chains

    // Implications
    workdayConversion: string;      // How many treat HustleXP as job
    dominanceContribution: string;  // How chaining helps lock-in
}

// ============================================================
// TASK CHAINING ENGINE
// ============================================================

export class TaskChainingEngine {

    /**
     * DETECT CHAINS FOR ZONE
     */
    static async getZoneChainingMetrics(zone: string): Promise<ZoneChainingMetrics> {
        const chains = await this.detectChains(zone);

        // Calculate chain strength
        const totalHustlers = await this.getTotalHustlers(zone);
        const chainingHustlers = new Set(chains.map(c => c.hustlerId)).size;
        const chainingPct = totalHustlers > 0 ? (chainingHustlers / totalHustlers) * 100 : 0;

        // Chain length stats
        const avgLength = chains.length > 0
            ? chains.reduce((sum, c) => sum + c.chainLength, 0) / chains.length
            : 0;
        const maxLength = chains.length > 0
            ? Math.max(...chains.map(c => c.chainLength))
            : 0;

        // Earnings uplift
        const avgChainEarnings = chains.length > 0
            ? chains.reduce((sum, c) => sum + c.totalEarnings, 0) / chains.length
            : 0;
        const singleTaskAvg = await this.getSingleTaskAvgEarnings(zone);
        const uplift = singleTaskAvg > 0
            ? ((avgChainEarnings / avgLength - singleTaskAvg) / singleTaskAvg) * 100
            : 0;

        // Chain strength (composite)
        const chainStrength = Math.round(
            (chainingPct * 0.4) +
            (Math.min(avgLength / 4, 1) * 100 * 0.3) +
            (Math.min(uplift / 50, 1) * 100 * 0.3)
        );

        // Top patterns
        const topPatterns = this.findTopPatterns(chains);

        // Super chainers
        const superChainerCount = chains.filter(c => c.chainLength >= 4).length;

        return {
            zone,
            generatedAt: new Date(),
            chainStrength,
            avgChainLength: Math.round(avgLength * 10) / 10,
            maxChainLength: maxLength,
            earningsUpliftPct: Math.round(uplift),
            topPatterns,
            chainingHustlerPct: Math.round(chainingPct),
            superChainerCount,
            workdayConversion: this.assessWorkdayConversion(chainingPct, avgLength),
            dominanceContribution: this.assessDominanceContribution(chainStrength)
        };
    }

    /**
     * GET HUSTLER CHAINS
     */
    static async getHustlerChains(hustlerId: string): Promise<{
        totalChains: number;
        avgChainLength: number;
        totalChainEarnings: number;
        favoritePattern: string[];
        isWorkdayHustler: boolean;
    }> {
        const chains = await this.detectHustlerChains(hustlerId);

        if (chains.length === 0) {
            return {
                totalChains: 0,
                avgChainLength: 0,
                totalChainEarnings: 0,
                favoritePattern: [],
                isWorkdayHustler: false
            };
        }

        const avgLength = chains.reduce((sum, c) => sum + c.chainLength, 0) / chains.length;
        const totalEarnings = chains.reduce((sum, c) => sum + c.totalEarnings, 0);
        const patterns = this.findTopPatterns(chains);

        return {
            totalChains: chains.length,
            avgChainLength: Math.round(avgLength * 10) / 10,
            totalChainEarnings: totalEarnings,
            favoritePattern: patterns[0]?.sequence || [],
            isWorkdayHustler: chains.length >= 10 || avgLength >= 3
        };
    }

    /**
     * SUGGEST CHAIN OPPORTUNITIES
     */
    static async suggestChainOpportunities(hustlerId: string, zone: string): Promise<{
        currentTasks: string[];
        suggestedNext: {
            category: string;
            reason: string;
            estimatedEarnings: number;
        }[];
    }> {
        const metrics = await this.getZoneChainingMetrics(zone);
        const hustlerChains = await this.getHustlerChains(hustlerId);

        // Find complementary categories from top patterns
        const suggestions: { category: string; reason: string; estimatedEarnings: number }[] = [];

        for (const pattern of metrics.topPatterns.slice(0, 2)) {
            if (pattern.sequence.length > 1) {
                for (let i = 1; i < pattern.sequence.length; i++) {
                    suggestions.push({
                        category: pattern.sequence[i],
                        reason: `Common follow-up after ${pattern.sequence[i - 1]} tasks`,
                        estimatedEarnings: pattern.avgEarnings / pattern.sequence.length
                    });
                }
            }
        }

        return {
            currentTasks: hustlerChains.favoritePattern,
            suggestedNext: suggestions.slice(0, 3)
        };
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static async detectChains(zone: string): Promise<TaskChain[]> {
        const db = getDb();
        if (!db) return this.generateMockChains(zone);

        try {
            // Get tasks grouped by hustler and day
            const rows = await db`
                SELECT 
                    assigned_hustler_id,
                    DATE(completed_at) as task_date,
                    ARRAY_AGG(id ORDER BY completed_at) as task_ids,
                    ARRAY_AGG(category ORDER BY completed_at) as categories,
                    ARRAY_AGG(COALESCE(final_amount, 50) ORDER BY completed_at) as earnings,
                    COUNT(*) as chain_length
                FROM tasks
                WHERE seattle_zone = ${zone}
                AND completed_at IS NOT NULL
                AND assigned_hustler_id IS NOT NULL
                AND completed_at > NOW() - INTERVAL '30 days'
                GROUP BY assigned_hustler_id, DATE(completed_at)
                HAVING COUNT(*) >= 2
                ORDER BY task_date DESC
                LIMIT 500
            ` as any[];

            return rows.map((row: any) => ({
                id: ulid(),
                hustlerId: row.assigned_hustler_id,
                zone,
                date: row.task_date,
                tasks: (row.task_ids as string[]).map((id: string, i: number) => ({
                    taskId: id,
                    category: row.categories[i],
                    earnings: parseFloat(row.earnings[i]) || 50,
                    completedAt: row.task_date
                })),
                chainLength: parseInt(row.chain_length),
                totalEarnings: (row.earnings as number[]).reduce((a: number, b: number) => a + b, 0),
                durationHours: 4, // Would calculate from actual times
                categorySequence: row.categories,
                isRecurringPattern: false // Would detect from historical data
            }));
        } catch (error) {
            logger.warn({ error, zone }, 'Failed to detect chains, using mock data');
            return this.generateMockChains(zone);
        }
    }

    private static async detectHustlerChains(hustlerId: string): Promise<TaskChain[]> {
        const db = getDb();
        if (!db) return [];

        try {
            const rows = await db`
                SELECT 
                    seattle_zone as zone,
                    DATE(completed_at) as task_date,
                    ARRAY_AGG(id ORDER BY completed_at) as task_ids,
                    ARRAY_AGG(category ORDER BY completed_at) as categories,
                    ARRAY_AGG(COALESCE(final_amount, 50) ORDER BY completed_at) as earnings,
                    COUNT(*) as chain_length
                FROM tasks
                WHERE assigned_hustler_id = ${hustlerId}::uuid
                AND completed_at IS NOT NULL
                AND completed_at > NOW() - INTERVAL '60 days'
                GROUP BY seattle_zone, DATE(completed_at)
                HAVING COUNT(*) >= 2
                ORDER BY task_date DESC
                LIMIT 100
            ` as any[];

            return rows.map((row: any) => ({
                id: ulid(),
                hustlerId,
                zone: row.zone,
                date: row.task_date,
                tasks: (row.task_ids as string[]).map((id: string, i: number) => ({
                    taskId: id,
                    category: row.categories[i],
                    earnings: parseFloat(row.earnings[i]) || 50,
                    completedAt: row.task_date
                })),
                chainLength: parseInt(row.chain_length),
                totalEarnings: (row.earnings as number[]).reduce((a: number, b: number) => a + b, 0),
                durationHours: 4,
                categorySequence: row.categories,
                isRecurringPattern: false
            }));
        } catch (error) {
            return [];
        }
    }

    private static async getTotalHustlers(zone: string): Promise<number> {
        const db = getDb();
        if (!db) return 50;

        try {
            const [result] = await db`
                SELECT COUNT(DISTINCT assigned_hustler_id) as count
                FROM tasks
                WHERE seattle_zone = ${zone}
                AND completed_at > NOW() - INTERVAL '30 days'
            ` as any[];
            return parseInt(result?.count || '50');
        } catch (error) {
            return 50;
        }
    }

    private static async getSingleTaskAvgEarnings(zone: string): Promise<number> {
        const db = getDb();
        if (!db) return 50;

        try {
            const [result] = await db`
                SELECT AVG(COALESCE(final_amount, 50)) as avg
                FROM tasks
                WHERE seattle_zone = ${zone}
                AND completed_at > NOW() - INTERVAL '30 days'
            ` as any[];
            return parseFloat(result?.avg || '50');
        } catch (error) {
            return 50;
        }
    }

    private static findTopPatterns(chains: TaskChain[]): ZoneChainingMetrics['topPatterns'] {
        const patternCounts = new Map<string, { count: number; totalEarnings: number }>();

        for (const chain of chains) {
            const key = chain.categorySequence.join(' → ');
            const existing = patternCounts.get(key) || { count: 0, totalEarnings: 0 };
            patternCounts.set(key, {
                count: existing.count + 1,
                totalEarnings: existing.totalEarnings + chain.totalEarnings
            });
        }

        return [...patternCounts.entries()]
            .map(([key, data]) => ({
                sequence: key.split(' → '),
                frequency: data.count,
                avgEarnings: Math.round(data.totalEarnings / data.count)
            }))
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 5);
    }

    private static assessWorkdayConversion(chainingPct: number, avgLength: number): string {
        if (chainingPct > 40 && avgLength > 3) {
            return 'High - many hustlers treat HustleXP as full workday';
        }
        if (chainingPct > 20 || avgLength > 2.5) {
            return 'Moderate - some hustlers building routines';
        }
        return 'Low - most hustlers doing single tasks';
    }

    private static assessDominanceContribution(strength: number): string {
        if (strength > 60) {
            return 'Strong - chaining creates significant switching cost';
        }
        if (strength > 30) {
            return 'Building - chaining patterns emerging';
        }
        return 'Minimal - little chaining behavior detected';
    }

    private static generateMockChains(zone: string): TaskChain[] {
        const chains: TaskChain[] = [];
        const categories = ['moving', 'cleaning', 'handyman', 'delivery', 'assembly'];

        for (let i = 0; i < 20; i++) {
            const chainLength = 2 + Math.floor(Math.random() * 3);
            const sequence = [];
            for (let j = 0; j < chainLength; j++) {
                sequence.push(categories[Math.floor(Math.random() * categories.length)]);
            }

            chains.push({
                id: ulid(),
                hustlerId: `mock-hustler-${i % 10}`,
                zone,
                date: new Date(),
                tasks: sequence.map((cat, idx) => ({
                    taskId: `task-${i}-${idx}`,
                    category: cat,
                    earnings: 40 + Math.random() * 40,
                    completedAt: new Date()
                })),
                chainLength,
                totalEarnings: chainLength * (40 + Math.random() * 40),
                durationHours: chainLength * 1.5,
                categorySequence: sequence,
                isRecurringPattern: Math.random() > 0.7
            });
        }

        return chains;
    }
}
