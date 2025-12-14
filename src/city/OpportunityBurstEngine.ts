/**
 * OPPORTUNITY BURST ENGINE (Phase 16 - Component 3)
 * 
 * Purpose: Create non-monetary nudges that concentrate liquidity.
 * 
 * This service:
 * - Detects opportunities before users find them
 * - Creates contextual nudges for hustlers
 * - Drives behavior without forcing routing
 * 
 * CONSTRAINTS:
 * - ADVISORY ONLY: No forced routing
 * - NO PAYOUT EFFECTS: Doesn't affect earnings
 * - NO KERNEL: Financial layer frozen
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { LiquidityHeatEngine } from './LiquidityHeatEngine.js';
import { CityGridService } from './CityGridService.js';

const logger = serviceLogger.child({ module: 'OpportunityBurst' });

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

export type BurstType =
    | 'high_demand'          // Many tasks, few hustlers
    | 'price_opportunity'    // Above-average prices
    | 'speed_bonus'          // Fast completion = better metrics
    | 'category_shortage'    // Specific category undersupplied
    | 'trust_zone'           // High trust = lower friction
    | 'momentum'             // Building streak opportunity

export interface OpportunityBurst {
    id: string;
    city: string;
    zone: string;
    microZone?: string;

    type: BurstType;

    // The nudge
    headline: string;            // "3 high-paying tasks nearby"
    detail: string;              // "Moving tasks in Capitol Hill paying $20+ above average"
    urgency: 'now' | 'soon' | 'opportunity';

    // Context
    context: {
        category?: string;
        estimatedEarnings?: number;
        competitionLevel: 'low' | 'medium' | 'high';
        trustBonus?: string;
    };

    // Targeting
    targeting: {
        forUserId?: string;      // Specific user or null for broadcast
        userZone?: string;       // Near user's location
        userCategories?: string[]; // User's preferred categories
    };

    // Lifecycle
    expiresAt: Date;
    createdAt: Date;
    viewed: boolean;
    actedOn: boolean;
}

export interface UserOpportunities {
    userId: string;
    zone: string;
    opportunities: OpportunityBurst[];
    summary: {
        totalOpportunities: number;
        urgentCount: number;
        estimatedExtraEarnings: number;
        topCategory: string | null;
    };
}

// ============================================================
// OPPORTUNITY BURST ENGINE
// ============================================================

export class OpportunityBurstEngine {

    /**
     * GENERATE OPPORTUNITIES FOR USER
     */
    static async getOpportunities(userId: string, zone: string): Promise<UserOpportunities> {
        const city = 'seattle'; // Would be derived from zone

        // Get heat data
        const heat = await LiquidityHeatEngine.getZoneHeat(city, zone);

        // Get user context (would fetch real user data)
        const userContext = await this.getUserContext(userId);

        // Generate relevant bursts
        const opportunities = await this.generateBursts(city, zone, heat, userContext);

        // Calculate summary
        const urgentCount = opportunities.filter(o => o.urgency === 'now').length;
        const estimatedExtra = opportunities.reduce((sum, o) =>
            sum + (o.context.estimatedEarnings || 0), 0
        );

        const categories = opportunities
            .filter(o => o.context.category)
            .map(o => o.context.category!);
        const topCategory = this.getMostFrequent(categories);

        return {
            userId,
            zone,
            opportunities,
            summary: {
                totalOpportunities: opportunities.length,
                urgentCount,
                estimatedExtraEarnings: estimatedExtra,
                topCategory
            }
        };
    }

    /**
     * GENERATE CITY-WIDE BURSTS
     */
    static async generateCityBursts(city: string): Promise<OpportunityBurst[]> {
        const snapshot = await LiquidityHeatEngine.generateSnapshot(city);
        const bursts: OpportunityBurst[] = [];

        // High demand bursts
        for (const zone of snapshot.summary.criticalShortages) {
            bursts.push(this.createBurst({
                city,
                zone,
                type: 'high_demand',
                headline: `High demand in ${zone}`,
                detail: `Few hustlers available - tasks accepting quickly`,
                urgency: 'now',
                competitionLevel: 'low',
                estimatedEarnings: 50
            }));
        }

        // Hotspot opportunities
        for (const hotspot of snapshot.summary.hotspots.slice(0, 3)) {
            bursts.push(this.createBurst({
                city,
                zone: hotspot.zone,
                type: 'momentum',
                headline: `Hot zone: ${hotspot.zone}`,
                detail: `Activity surge - build your streak here`,
                urgency: 'soon',
                competitionLevel: 'medium',
                trustBonus: 'High completion rate zone'
            }));
        }

        // Persist bursts
        for (const burst of bursts) {
            await this.persistBurst(burst);
        }

        logger.info({ city, burstCount: bursts.length }, 'City bursts generated');

        return bursts;
    }

    /**
     * MARK BURST AS VIEWED
     */
    static async markViewed(burstId: string): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                UPDATE opportunity_bursts 
                SET viewed = true, viewed_at = NOW()
                WHERE id = ${burstId}
            `;
        } catch (error) {
            logger.warn({ error, burstId }, 'Failed to mark burst viewed');
        }
    }

    /**
     * MARK BURST AS ACTED ON
     */
    static async markActedOn(burstId: string): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                UPDATE opportunity_bursts 
                SET acted_on = true, acted_on_at = NOW()
                WHERE id = ${burstId}
            `;

            // Log engagement metric
            logger.info({ burstId, event: 'burst_engagement' }, 'Opportunity burst engagement');
        } catch (error) {
            logger.warn({ error, burstId }, 'Failed to mark burst acted on');
        }
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static async getUserContext(userId: string): Promise<{
        preferredCategories: string[];
        avgEarnings: number;
        trustTier: string;
    }> {
        // Would fetch real user data
        return {
            preferredCategories: ['moving', 'handyman', 'delivery'],
            avgEarnings: 45,
            trustTier: 'low'
        };
    }

    private static async generateBursts(
        city: string,
        zone: string,
        heatCells: any[],
        userContext: any
    ): Promise<OpportunityBurst[]> {
        const bursts: OpportunityBurst[] = [];

        // Find cells with opportunities
        const highDemand = heatCells.filter(c => c.demandHeat > 60 && c.supplyHeat > 50);
        const lowCompetition = heatCells.filter(c => c.supplyHeat < 40);

        // High demand opportunity
        if (highDemand.length > 0) {
            bursts.push(this.createBurst({
                city,
                zone,
                microZone: highDemand[0].microZone,
                type: 'high_demand',
                headline: `${highDemand.length * 3} tasks need hustlers`,
                detail: `Low competition in your area right now`,
                urgency: 'now',
                competitionLevel: 'low',
                estimatedEarnings: 60
            }));
        }

        // Category-specific opportunity
        for (const category of userContext.preferredCategories.slice(0, 1)) {
            bursts.push(this.createBurst({
                city,
                zone,
                type: 'category_shortage',
                headline: `${category.charAt(0).toUpperCase() + category.slice(1)} jobs available`,
                detail: `Shortage of ${category} help in ${zone}`,
                urgency: 'soon',
                category,
                competitionLevel: 'low',
                estimatedEarnings: userContext.avgEarnings * 1.2
            }));
        }

        // Trust zone opportunity
        if (userContext.trustTier === 'low' || userContext.trustTier === 'minimal') {
            bursts.push(this.createBurst({
                city,
                zone,
                type: 'trust_zone',
                headline: 'Trusted hustler bonus',
                detail: 'High trust hustlers earn 22% more in this zone',
                urgency: 'opportunity',
                competitionLevel: 'medium',
                trustBonus: 'Lower friction, faster payouts'
            }));
        }

        return bursts;
    }

    private static createBurst(params: {
        city: string;
        zone: string;
        microZone?: string;
        type: BurstType;
        headline: string;
        detail: string;
        urgency: 'now' | 'soon' | 'opportunity';
        competitionLevel: 'low' | 'medium' | 'high';
        category?: string;
        estimatedEarnings?: number;
        trustBonus?: string;
        forUserId?: string;
    }): OpportunityBurst {
        return {
            id: ulid(),
            city: params.city,
            zone: params.zone,
            microZone: params.microZone,
            type: params.type,
            headline: params.headline,
            detail: params.detail,
            urgency: params.urgency,
            context: {
                category: params.category,
                estimatedEarnings: params.estimatedEarnings,
                competitionLevel: params.competitionLevel,
                trustBonus: params.trustBonus
            },
            targeting: {
                forUserId: params.forUserId
            },
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours
            createdAt: new Date(),
            viewed: false,
            actedOn: false
        };
    }

    private static getMostFrequent(arr: string[]): string | null {
        if (arr.length === 0) return null;
        const counts = new Map<string, number>();
        for (const item of arr) {
            counts.set(item, (counts.get(item) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    private static async persistBurst(burst: OpportunityBurst): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO opportunity_bursts (
                    id, city, zone, type, urgency, 
                    data, expires_at, created_at
                ) VALUES (
                    ${burst.id}, ${burst.city}, ${burst.zone}, ${burst.type},
                    ${burst.urgency}, ${JSON.stringify(burst)}, ${burst.expiresAt}, ${burst.createdAt}
                )
            `;
        } catch (error) {
            logger.warn({ error }, 'Failed to persist burst');
        }
    }
}
