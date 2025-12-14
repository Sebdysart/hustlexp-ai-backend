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

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';

const logger = serviceLogger.child({ module: 'CityGrid' });

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

export interface CityGridCell {
    id: string;
    city: string;
    zone: string;              // Neighborhood (Capitol Hill, Ballard, etc)
    microZone: string;         // Hex/grid ID within zone

    // Supply/Demand Indices (0-100)
    supplyIndex: number;       // Hustler availability
    demandIndex: number;       // Task volume
    liquidityRatio: number;    // supply/demand balance

    // Performance Metrics
    fulfillmentLatencyHours: number;   // Avg time to accept
    completionRate: number;
    disputeRate: number;
    churnRisk: number;         // 0-100, hustler churn probability

    // Time patterns
    peakHours: number[];       // Hours with highest activity
    lowHours: number[];        // Hours with lowest activity

    updatedAt: Date;
}

export interface CityGrid {
    city: string;
    generatedAt: Date;
    totalCells: number;
    activeZones: number;
    cells: CityGridCell[];

    // City-level aggregates
    aggregates: {
        avgSupplyIndex: number;
        avgDemandIndex: number;
        avgLiquidityRatio: number;
        hotspots: string[];        // Zones with high activity
        coldspots: string[];       // Zones needing attention
    };
}

// Seattle micro-zone definitions (hex grid approximation)
const SEATTLE_ZONES = {
    'Capitol Hill': ['CH-N', 'CH-S', 'CH-E', 'CH-W', 'CH-C'],
    'Ballard': ['BA-N', 'BA-S', 'BA-E', 'BA-W', 'BA-C'],
    'Fremont': ['FR-N', 'FR-S', 'FR-E', 'FR-W'],
    'University District': ['UD-N', 'UD-S', 'UD-E', 'UD-W', 'UD-C'],
    'Queen Anne': ['QA-N', 'QA-S', 'QA-E', 'QA-W'],
    'Downtown': ['DT-N', 'DT-S', 'DT-E', 'DT-W', 'DT-C', 'DT-WF'],
    'Beacon Hill': ['BH-N', 'BH-S', 'BH-C'],
    'Columbia City': ['CC-N', 'CC-S', 'CC-C'],
    'West Seattle': ['WS-N', 'WS-S', 'WS-E', 'WS-W'],
    'Greenwood': ['GW-N', 'GW-S', 'GW-C'],
    'Wallingford': ['WF-N', 'WF-S', 'WF-E', 'WF-W']
};

// ============================================================
// CITY GRID SERVICE
// ============================================================

export class CityGridService {

    /**
     * GET FULL CITY GRID
     */
    static async getGrid(city: string): Promise<CityGrid> {
        const cells = await this.generateGridCells(city);

        const activeZones = new Set(cells.map(c => c.zone)).size;

        const avgSupply = cells.reduce((sum, c) => sum + c.supplyIndex, 0) / cells.length;
        const avgDemand = cells.reduce((sum, c) => sum + c.demandIndex, 0) / cells.length;
        const avgLiquidity = cells.reduce((sum, c) => sum + c.liquidityRatio, 0) / cells.length;

        const hotspots = cells
            .filter(c => c.demandIndex > 70)
            .map(c => c.zone)
            .filter((v, i, a) => a.indexOf(v) === i);

        const coldspots = cells
            .filter(c => c.supplyIndex < 30 && c.demandIndex > 40)
            .map(c => c.zone)
            .filter((v, i, a) => a.indexOf(v) === i);

        return {
            city,
            generatedAt: new Date(),
            totalCells: cells.length,
            activeZones,
            cells,
            aggregates: {
                avgSupplyIndex: Math.round(avgSupply),
                avgDemandIndex: Math.round(avgDemand),
                avgLiquidityRatio: Math.round(avgLiquidity * 100) / 100,
                hotspots,
                coldspots
            }
        };
    }

    /**
     * GET ZONE DETAIL
     */
    static async getZoneDetail(city: string, zone: string): Promise<CityGridCell[]> {
        const grid = await this.getGrid(city);
        return grid.cells.filter(c => c.zone === zone);
    }

    /**
     * GET CELLS NEEDING ATTENTION
     */
    static async getCriticalCells(city: string): Promise<{
        supplyShortage: CityGridCell[];
        highDispute: CityGridCell[];
        highChurn: CityGridCell[];
    }> {
        const grid = await this.getGrid(city);

        return {
            supplyShortage: grid.cells.filter(c =>
                c.supplyIndex < 30 && c.demandIndex > 50
            ),
            highDispute: grid.cells.filter(c =>
                c.disputeRate > 0.05
            ),
            highChurn: grid.cells.filter(c =>
                c.churnRisk > 60
            )
        };
    }

    /**
     * GET TIME PATTERN FOR ZONE
     */
    static async getTimePattern(city: string, zone: string): Promise<{
        zone: string;
        hourlyDemand: number[];     // 24-hour demand pattern
        hourlySupply: number[];     // 24-hour supply pattern
        bestHours: number[];
        worstHours: number[];
    }> {
        // Simulated hourly patterns (would be calculated from real data)
        const hourlyDemand = this.generateHourlyPattern('demand');
        const hourlySupply = this.generateHourlyPattern('supply');

        const bestHours = hourlyDemand
            .map((d, i) => ({ hour: i, ratio: hourlySupply[i] / Math.max(d, 1) }))
            .sort((a, b) => b.ratio - a.ratio)
            .slice(0, 3)
            .map(h => h.hour);

        const worstHours = hourlyDemand
            .map((d, i) => ({ hour: i, ratio: hourlySupply[i] / Math.max(d, 1) }))
            .sort((a, b) => a.ratio - b.ratio)
            .slice(0, 3)
            .map(h => h.hour);

        return { zone, hourlyDemand, hourlySupply, bestHours, worstHours };
    }

    // -----------------------------------------------------------
    // INTERNAL: Grid Generation
    // -----------------------------------------------------------

    private static async generateGridCells(city: string): Promise<CityGridCell[]> {
        const db = getDb();
        const cells: CityGridCell[] = [];

        const zones = city.toLowerCase() === 'seattle' ? SEATTLE_ZONES : {};

        for (const [zone, microZones] of Object.entries(zones)) {
            // Get real data for zone if available
            const zoneData = await this.getZoneData(zone);

            for (const microZone of microZones) {
                const cell = this.buildCell(city, zone, microZone, zoneData);
                cells.push(cell);
            }
        }

        return cells;
    }

    private static async getZoneData(zone: string): Promise<{
        taskCount: number;
        hustlerCount: number;
        avgFulfillmentHours: number;
        completionRate: number;
        disputeRate: number;
    }> {
        const db = getDb();

        const defaultData = {
            taskCount: 10,
            hustlerCount: 5,
            avgFulfillmentHours: 4,
            completionRate: 0.85,
            disputeRate: 0.03
        };

        if (!db) return defaultData;

        try {
            const [stats] = await db`
                SELECT 
                    COUNT(DISTINCT t.id) as task_count,
                    COUNT(DISTINCT t.assigned_hustler_id) as hustler_count,
                    AVG(EXTRACT(EPOCH FROM (t.accepted_at - t.created_at))/3600) as avg_fulfillment,
                    COUNT(*) FILTER (WHERE t.status = 'completed') * 1.0 / NULLIF(COUNT(*), 0) as completion_rate,
                    COUNT(*) FILTER (WHERE t.status = 'disputed') * 1.0 / NULLIF(COUNT(*), 0) as dispute_rate
                FROM tasks t
                WHERE t.seattle_zone = ${zone}
                AND t.created_at > NOW() - INTERVAL '30 days'
            ` as any[];

            return {
                taskCount: parseInt(stats?.task_count || '10'),
                hustlerCount: parseInt(stats?.hustler_count || '5'),
                avgFulfillmentHours: parseFloat(stats?.avg_fulfillment || '4'),
                completionRate: parseFloat(stats?.completion_rate || '0.85'),
                disputeRate: parseFloat(stats?.dispute_rate || '0.03')
            };
        } catch (error) {
            return defaultData;
        }
    }

    private static buildCell(
        city: string,
        zone: string,
        microZone: string,
        zoneData: any
    ): CityGridCell {
        // Distribute zone data across micro-zones with variance
        const variance = 0.2 + Math.random() * 0.6; // 20-80% of zone total

        const supplyIndex = Math.min(100, Math.round(
            (zoneData.hustlerCount / Math.max(zoneData.taskCount / 4, 1)) * 50 * variance
        ));

        const demandIndex = Math.min(100, Math.round(
            (zoneData.taskCount / 10) * 20 * variance
        ));

        const liquidityRatio = demandIndex > 0 ? supplyIndex / demandIndex : 1;

        // Churn risk based on completion rate and disputes
        const churnRisk = Math.min(100, Math.round(
            (1 - zoneData.completionRate) * 50 + zoneData.disputeRate * 500
        ));

        return {
            id: ulid(),
            city,
            zone,
            microZone,
            supplyIndex,
            demandIndex,
            liquidityRatio,
            fulfillmentLatencyHours: zoneData.avgFulfillmentHours,
            completionRate: zoneData.completionRate,
            disputeRate: zoneData.disputeRate,
            churnRisk,
            peakHours: [9, 10, 11, 14, 15, 16],
            lowHours: [2, 3, 4, 5],
            updatedAt: new Date()
        };
    }

    private static generateHourlyPattern(type: 'demand' | 'supply'): number[] {
        const pattern = [];
        for (let hour = 0; hour < 24; hour++) {
            let base = 20;

            // Morning ramp
            if (hour >= 7 && hour <= 10) base = 50 + (hour - 7) * 15;
            // Midday peak
            else if (hour >= 11 && hour <= 14) base = 80;
            // Afternoon
            else if (hour >= 15 && hour <= 18) base = 70 - (hour - 15) * 5;
            // Evening decline
            else if (hour >= 19 && hour <= 22) base = 50 - (hour - 19) * 10;
            // Night
            else base = 15;

            // Supply lags demand slightly
            if (type === 'supply') base = base * 0.9;

            pattern.push(Math.round(base + Math.random() * 10));
        }
        return pattern;
    }
}
