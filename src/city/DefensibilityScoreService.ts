/**
 * DEFENSIBILITY SCORE SERVICE (Phase 16 - Component 4)
 * 
 * Purpose: Calculate how hard HustleXP is to displace in each zone.
 * 
 * A zone is "locked" when:
 * - High repeat user rate
 * - Low time-to-fill
 * - Strong trust scores
 * - Stable dispute rate
 * - Dense task network
 * 
 * CONSTRAINTS:
 * - READ-ONLY: Analysis only
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Powers strategy, not execution
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { CityGridService } from './CityGridService.js';
import { LiquidityHeatEngine } from './LiquidityHeatEngine.js';

const logger = serviceLogger.child({ module: 'Defensibility' });

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

export type DefensibilityClass = 'fragile' | 'contestable' | 'dominant' | 'locked';

export interface ZoneDefensibility {
    zone: string;

    // Core metrics (0-100)
    taskDensity: number;          // Tasks per week per hustler
    repeatUserRate: number;       // % of returning users
    timeToFillHours: number;      // Avg time to accept
    trustScore: number;           // Aggregate trust level
    disputeStability: number;     // Inverse of dispute variance

    // Composite
    defensibilityScore: number;   // 0-100
    classification: DefensibilityClass;

    // Competitive analysis
    vulnerabilities: string[];
    moatStrengths: string[];

    // Delta tracking
    scoreChange30d: number;
    trend: 'strengthening' | 'stable' | 'weakening';
}

export interface CityDefensibility {
    id: string;
    city: string;
    generatedAt: Date;

    zones: ZoneDefensibility[];

    // City-level summary
    cityScore: number;
    cityClassification: DefensibilityClass;

    // Strategic summary
    summary: {
        lockedZones: string[];
        dominantZones: string[];
        contestableZones: string[];
        fragileZones: string[];
    };

    // Competitive position
    competitivePosition: {
        overallMoat: string;
        primaryVulnerability: string;
        defensePriority: string[];
    };
}

// ============================================================
// DEFENSIBILITY SCORE SERVICE
// ============================================================

export class DefensibilityScoreService {

    /**
     * GET CITY DEFENSIBILITY
     */
    static async getCityDefensibility(city: string): Promise<CityDefensibility> {
        const id = ulid();

        // Get grid and heat data
        const grid = await CityGridService.getGrid(city);
        const heat = await LiquidityHeatEngine.getLatest(city);

        // Calculate defensibility for each zone
        const zoneNames = [...new Set(grid.cells.map(c => c.zone))];
        const zones = await Promise.all(
            zoneNames.map(zone => this.calculateZoneDefensibility(zone, grid, heat))
        );

        // City-level aggregation
        const cityScore = Math.round(
            zones.reduce((sum, z) => sum + z.defensibilityScore, 0) / zones.length
        );
        const cityClassification = this.classifyScore(cityScore);

        // Group by classification
        const summary = {
            lockedZones: zones.filter(z => z.classification === 'locked').map(z => z.zone),
            dominantZones: zones.filter(z => z.classification === 'dominant').map(z => z.zone),
            contestableZones: zones.filter(z => z.classification === 'contestable').map(z => z.zone),
            fragileZones: zones.filter(z => z.classification === 'fragile').map(z => z.zone)
        };

        // Competitive position
        const competitivePosition = this.assessCompetitivePosition(zones, summary);

        const result: CityDefensibility = {
            id,
            city,
            generatedAt: new Date(),
            zones,
            cityScore,
            cityClassification,
            summary,
            competitivePosition
        };

        // Persist
        await this.persistSnapshot(result);

        logger.info({
            city,
            cityScore,
            locked: summary.lockedZones.length,
            fragile: summary.fragileZones.length
        }, 'Defensibility calculated');

        return result;
    }

    /**
     * GET ZONE DEFENSIBILITY
     */
    static async getZoneDefensibility(zone: string): Promise<ZoneDefensibility> {
        const grid = await CityGridService.getGrid('seattle');
        const heat = await LiquidityHeatEngine.getLatest('seattle');
        return this.calculateZoneDefensibility(zone, grid, heat);
    }

    /**
     * GET COMPETITIVE THREATS
     */
    static async getCompetitiveThreats(city: string): Promise<{
        zone: string;
        threatLevel: 'high' | 'medium' | 'low';
        reason: string;
        recommendedAction: string;
    }[]> {
        const defensibility = await this.getCityDefensibility(city);

        return defensibility.zones
            .filter(z => z.classification === 'fragile' || z.classification === 'contestable')
            .map(z => ({
                zone: z.zone,
                threatLevel: z.classification === 'fragile' ? 'high' as const : 'medium' as const,
                reason: z.vulnerabilities[0] || 'Low defensibility score',
                recommendedAction: z.classification === 'fragile'
                    ? 'Increase hustler incentives and marketing'
                    : 'Monitor weekly and maintain presence'
            }))
            .sort((a, b) => a.threatLevel === 'high' ? -1 : 1);
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static async calculateZoneDefensibility(
        zone: string,
        grid: any,
        heat: any
    ): Promise<ZoneDefensibility> {
        const zoneCells = grid.cells.filter((c: any) => c.zone === zone);

        // Calculate metrics from zone data
        const avgSupply = zoneCells.reduce((sum: number, c: any) => sum + c.supplyIndex, 0) / zoneCells.length;
        const avgDemand = zoneCells.reduce((sum: number, c: any) => sum + c.demandIndex, 0) / zoneCells.length;
        const avgCompletion = zoneCells.reduce((sum: number, c: any) => sum + c.completionRate, 0) / zoneCells.length;
        const avgDispute = zoneCells.reduce((sum: number, c: any) => sum + c.disputeRate, 0) / zoneCells.length;
        const avgFulfillment = zoneCells.reduce((sum: number, c: any) => sum + c.fulfillmentLatencyHours, 0) / zoneCells.length;

        // Task density: tasks per hustler
        const taskDensity = Math.min(100, (avgDemand / Math.max(avgSupply, 1)) * 50);

        // Repeat user rate (simulated - would come from real data)
        const repeatUserRate = Math.min(100, 40 + avgCompletion * 50);

        // Time to fill (inverse - faster is better)
        const timeToFillHours = avgFulfillment;
        const timeToFillScore = Math.max(0, 100 - avgFulfillment * 10);

        // Trust score
        const trustScore = Math.min(100, avgCompletion * 100 - avgDispute * 500);

        // Dispute stability (inverse of rate)
        const disputeStability = Math.max(0, 100 - avgDispute * 1000);

        // Calculate composite score (weighted)
        const defensibilityScore = Math.round(
            taskDensity * 0.2 +
            repeatUserRate * 0.25 +
            timeToFillScore * 0.2 +
            trustScore * 0.2 +
            disputeStability * 0.15
        );

        const classification = this.classifyScore(defensibilityScore);

        // Identify vulnerabilities and strengths
        const vulnerabilities = this.identifyVulnerabilities(
            taskDensity, repeatUserRate, timeToFillScore, trustScore, disputeStability
        );
        const moatStrengths = this.identifyStrengths(
            taskDensity, repeatUserRate, timeToFillScore, trustScore, disputeStability
        );

        // Trend (simulated - would use historical data)
        const scoreChange30d = Math.round((Math.random() - 0.3) * 10);
        const trend = scoreChange30d > 3 ? 'strengthening' as const
            : scoreChange30d < -3 ? 'weakening' as const
                : 'stable' as const;

        return {
            zone,
            taskDensity,
            repeatUserRate,
            timeToFillHours,
            trustScore,
            disputeStability,
            defensibilityScore,
            classification,
            vulnerabilities,
            moatStrengths,
            scoreChange30d,
            trend
        };
    }

    private static classifyScore(score: number): DefensibilityClass {
        if (score >= 80) return 'locked';
        if (score >= 60) return 'dominant';
        if (score >= 40) return 'contestable';
        return 'fragile';
    }

    private static identifyVulnerabilities(
        density: number,
        repeat: number,
        speed: number,
        trust: number,
        stability: number
    ): string[] {
        const vulns: string[] = [];

        if (density < 40) vulns.push('Low task density - thin market');
        if (repeat < 50) vulns.push('Low repeat rate - weak user lock-in');
        if (speed < 50) vulns.push('Slow time-to-fill - poor UX');
        if (trust < 50) vulns.push('Trust issues - friction may drive users away');
        if (stability < 50) vulns.push('High dispute variance - unstable experience');

        return vulns;
    }

    private static identifyStrengths(
        density: number,
        repeat: number,
        speed: number,
        trust: number,
        stability: number
    ): string[] {
        const strengths: string[] = [];

        if (density > 70) strengths.push('High task liquidity');
        if (repeat > 70) strengths.push('Strong user retention');
        if (speed > 70) strengths.push('Fast task matching');
        if (trust > 70) strengths.push('Excellent trust network');
        if (stability > 70) strengths.push('Stable, predictable marketplace');

        return strengths;
    }

    private static assessCompetitivePosition(
        zones: ZoneDefensibility[],
        summary: CityDefensibility['summary']
    ): CityDefensibility['competitivePosition'] {
        const locked = summary.lockedZones.length;
        const fragile = summary.fragileZones.length;
        const total = zones.length;

        let overallMoat: string;
        if (locked > total * 0.3) {
            overallMoat = 'Strong - significant market lock-in achieved';
        } else if (fragile < total * 0.2) {
            overallMoat = 'Building - competitive but not yet defensible';
        } else {
            overallMoat = 'Weak - vulnerable to well-funded competitor entry';
        }

        const allVulns = zones.flatMap(z => z.vulnerabilities);
        const vulnCounts = new Map<string, number>();
        for (const v of allVulns) {
            vulnCounts.set(v, (vulnCounts.get(v) || 0) + 1);
        }
        const primaryVuln = [...vulnCounts.entries()]
            .sort((a, b) => b[1] - a[1])[0];

        const defensePriority = summary.fragileZones.slice(0, 3);
        if (defensePriority.length === 0 && summary.contestableZones.length > 0) {
            defensePriority.push(...summary.contestableZones.slice(0, 2));
        }

        return {
            overallMoat,
            primaryVulnerability: primaryVuln ? primaryVuln[0] : 'None identified',
            defensePriority: defensePriority.length > 0
                ? defensePriority
                : ['Maintain current strong position']
        };
    }

    private static async persistSnapshot(snapshot: CityDefensibility): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO market_defensibility_snapshots (
                    id, city, city_score, classification, data, generated_at
                ) VALUES (
                    ${snapshot.id}, ${snapshot.city}, ${snapshot.cityScore},
                    ${snapshot.cityClassification}, ${JSON.stringify(snapshot)}, ${snapshot.generatedAt}
                )
            `;
        } catch (error) {
            logger.warn({ error }, 'Failed to persist defensibility snapshot');
        }
    }
}
