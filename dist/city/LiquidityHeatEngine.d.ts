/**
 * LIQUIDITY HEAT ENGINE (Phase 16 - Component 2)
 *
 * Purpose: Visualize market liquidity in real-time.
 *
 * Calculates:
 * - Where tasks pile up (demand heat)
 * - Where hustlers idle (supply cold)
 * - Where pricing is broken
 * - Where trust friction is excessive
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies state
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Powers visualization and nudges, not execution
 */
export type HeatStatus = 'cold' | 'warming' | 'liquid' | 'overheated';
export interface LiquidityHeatCell {
    zone: string;
    microZone: string;
    demandHeat: number;
    supplyHeat: number;
    priceHeat: number;
    frictionHeat: number;
    heatScore: number;
    status: HeatStatus;
    heatDelta24h: number;
    trend: 'heating' | 'stable' | 'cooling';
}
export interface LiquidityHeatSnapshot {
    id: string;
    city: string;
    generatedAt: Date;
    cells: LiquidityHeatCell[];
    summary: {
        avgHeat: number;
        hotspots: {
            zone: string;
            heatScore: number;
        }[];
        coldspots: {
            zone: string;
            heatScore: number;
        }[];
        overheatedZones: string[];
        criticalShortages: string[];
    };
    insights: {
        immediateAttention: string[];
        opportunities: string[];
        risks: string[];
    };
}
export declare class LiquidityHeatEngine {
    /**
     * GENERATE HEAT SNAPSHOT
     */
    static generateSnapshot(city: string): Promise<LiquidityHeatSnapshot>;
    /**
     * GET LATEST SNAPSHOT
     */
    static getLatest(city: string): Promise<LiquidityHeatSnapshot | null>;
    /**
     * GET ZONE HEAT
     */
    static getZoneHeat(city: string, zone: string): Promise<LiquidityHeatCell[]>;
    /**
     * GET CRITICAL ZONES
     */
    static getCriticalZones(city: string): Promise<{
        overheated: LiquidityHeatCell[];
        frozen: LiquidityHeatCell[];
        imbalanced: LiquidityHeatCell[];
    }>;
    private static calculateHeat;
    private static classifyStatus;
    private static generateSummary;
    private static generateInsights;
    private static persistSnapshot;
}
//# sourceMappingURL=LiquidityHeatEngine.d.ts.map