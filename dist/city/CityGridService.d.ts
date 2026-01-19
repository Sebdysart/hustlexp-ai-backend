/**
 * CITY GRID SERVICE (Phase 16 - Component 1)
 *
 * Purpose: Partition cities into controllable micro-markets.
 *
 * HustleXP wins by controlling micro-markets, not cities.
 * This service models:
 * - Zones (neighborhood level)
 * - Micro-zones (hex/grid level)
 * - Time buckets (hour/day patterns)
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies task/money state
 * - NO KERNEL: Frozen financial layer not touched
 * - ADVISORY: All outputs feed intelligence, not execution
 */
export interface CityGridCell {
    id: string;
    city: string;
    zone: string;
    microZone: string;
    supplyIndex: number;
    demandIndex: number;
    liquidityRatio: number;
    fulfillmentLatencyHours: number;
    completionRate: number;
    disputeRate: number;
    churnRisk: number;
    peakHours: number[];
    lowHours: number[];
    updatedAt: Date;
}
export interface CityGrid {
    city: string;
    generatedAt: Date;
    totalCells: number;
    activeZones: number;
    cells: CityGridCell[];
    aggregates: {
        avgSupplyIndex: number;
        avgDemandIndex: number;
        avgLiquidityRatio: number;
        hotspots: string[];
        coldspots: string[];
    };
}
export declare class CityGridService {
    /**
     * GET FULL CITY GRID
     */
    static getGrid(city: string): Promise<CityGrid>;
    /**
     * GET ZONE DETAIL
     */
    static getZoneDetail(city: string, zone: string): Promise<CityGridCell[]>;
    /**
     * GET CELLS NEEDING ATTENTION
     */
    static getCriticalCells(city: string): Promise<{
        supplyShortage: CityGridCell[];
        highDispute: CityGridCell[];
        highChurn: CityGridCell[];
    }>;
    /**
     * GET TIME PATTERN FOR ZONE
     */
    static getTimePattern(city: string, zone: string): Promise<{
        zone: string;
        hourlyDemand: number[];
        hourlySupply: number[];
        bestHours: number[];
        worstHours: number[];
    }>;
    private static generateGridCells;
    private static getZoneData;
    private static buildCell;
    private static generateHourlyPattern;
}
//# sourceMappingURL=CityGridService.d.ts.map