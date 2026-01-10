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
export type BurstType = 'high_demand' | 'price_opportunity' | 'speed_bonus' | 'category_shortage' | 'trust_zone' | 'momentum';
export interface OpportunityBurst {
    id: string;
    city: string;
    zone: string;
    microZone?: string;
    type: BurstType;
    headline: string;
    detail: string;
    urgency: 'now' | 'soon' | 'opportunity';
    context: {
        category?: string;
        estimatedEarnings?: number;
        competitionLevel: 'low' | 'medium' | 'high';
        trustBonus?: string;
    };
    targeting: {
        forUserId?: string;
        userZone?: string;
        userCategories?: string[];
    };
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
export declare class OpportunityBurstEngine {
    /**
     * GENERATE OPPORTUNITIES FOR USER
     */
    static getOpportunities(userId: string, zone: string): Promise<UserOpportunities>;
    /**
     * GENERATE CITY-WIDE BURSTS
     */
    static generateCityBursts(city: string): Promise<OpportunityBurst[]>;
    /**
     * MARK BURST AS VIEWED
     */
    static markViewed(burstId: string): Promise<void>;
    /**
     * MARK BURST AS ACTED ON
     */
    static markActedOn(burstId: string): Promise<void>;
    private static getUserContext;
    private static generateBursts;
    private static createBurst;
    private static getMostFrequent;
    private static persistBurst;
}
//# sourceMappingURL=OpportunityBurstEngine.d.ts.map