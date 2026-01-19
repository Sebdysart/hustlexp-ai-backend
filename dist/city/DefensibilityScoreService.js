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
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// DEFENSIBILITY SCORE SERVICE
// ============================================================
export class DefensibilityScoreService {
    /**
     * GET CITY DEFENSIBILITY
     */
    static async getCityDefensibility(city) {
        const id = ulid();
        // Get grid and heat data
        const grid = await CityGridService.getGrid(city);
        const heat = await LiquidityHeatEngine.getLatest(city);
        // Calculate defensibility for each zone
        const zoneNames = [...new Set(grid.cells.map(c => c.zone))];
        const zones = await Promise.all(zoneNames.map(zone => this.calculateZoneDefensibility(zone, grid, heat)));
        // City-level aggregation
        const cityScore = Math.round(zones.reduce((sum, z) => sum + z.defensibilityScore, 0) / zones.length);
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
        const result = {
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
    static async getZoneDefensibility(zone) {
        const grid = await CityGridService.getGrid('seattle');
        const heat = await LiquidityHeatEngine.getLatest('seattle');
        return this.calculateZoneDefensibility(zone, grid, heat);
    }
    /**
     * GET COMPETITIVE THREATS
     */
    static async getCompetitiveThreats(city) {
        const defensibility = await this.getCityDefensibility(city);
        return defensibility.zones
            .filter(z => z.classification === 'fragile' || z.classification === 'contestable')
            .map(z => ({
            zone: z.zone,
            threatLevel: z.classification === 'fragile' ? 'high' : 'medium',
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
    static async calculateZoneDefensibility(zone, grid, heat) {
        const zoneCells = grid.cells.filter((c) => c.zone === zone);
        // Calculate metrics from zone data
        const avgSupply = zoneCells.reduce((sum, c) => sum + c.supplyIndex, 0) / zoneCells.length;
        const avgDemand = zoneCells.reduce((sum, c) => sum + c.demandIndex, 0) / zoneCells.length;
        const avgCompletion = zoneCells.reduce((sum, c) => sum + c.completionRate, 0) / zoneCells.length;
        const avgDispute = zoneCells.reduce((sum, c) => sum + c.disputeRate, 0) / zoneCells.length;
        const avgFulfillment = zoneCells.reduce((sum, c) => sum + c.fulfillmentLatencyHours, 0) / zoneCells.length;
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
        const defensibilityScore = Math.round(taskDensity * 0.2 +
            repeatUserRate * 0.25 +
            timeToFillScore * 0.2 +
            trustScore * 0.2 +
            disputeStability * 0.15);
        const classification = this.classifyScore(defensibilityScore);
        // Identify vulnerabilities and strengths
        const vulnerabilities = this.identifyVulnerabilities(taskDensity, repeatUserRate, timeToFillScore, trustScore, disputeStability);
        const moatStrengths = this.identifyStrengths(taskDensity, repeatUserRate, timeToFillScore, trustScore, disputeStability);
        // Trend (simulated - would use historical data)
        const scoreChange30d = Math.round((Math.random() - 0.3) * 10);
        const trend = scoreChange30d > 3 ? 'strengthening'
            : scoreChange30d < -3 ? 'weakening'
                : 'stable';
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
    static classifyScore(score) {
        if (score >= 80)
            return 'locked';
        if (score >= 60)
            return 'dominant';
        if (score >= 40)
            return 'contestable';
        return 'fragile';
    }
    static identifyVulnerabilities(density, repeat, speed, trust, stability) {
        const vulns = [];
        if (density < 40)
            vulns.push('Low task density - thin market');
        if (repeat < 50)
            vulns.push('Low repeat rate - weak user lock-in');
        if (speed < 50)
            vulns.push('Slow time-to-fill - poor UX');
        if (trust < 50)
            vulns.push('Trust issues - friction may drive users away');
        if (stability < 50)
            vulns.push('High dispute variance - unstable experience');
        return vulns;
    }
    static identifyStrengths(density, repeat, speed, trust, stability) {
        const strengths = [];
        if (density > 70)
            strengths.push('High task liquidity');
        if (repeat > 70)
            strengths.push('Strong user retention');
        if (speed > 70)
            strengths.push('Fast task matching');
        if (trust > 70)
            strengths.push('Excellent trust network');
        if (stability > 70)
            strengths.push('Stable, predictable marketplace');
        return strengths;
    }
    static assessCompetitivePosition(zones, summary) {
        const locked = summary.lockedZones.length;
        const fragile = summary.fragileZones.length;
        const total = zones.length;
        let overallMoat;
        if (locked > total * 0.3) {
            overallMoat = 'Strong - significant market lock-in achieved';
        }
        else if (fragile < total * 0.2) {
            overallMoat = 'Building - competitive but not yet defensible';
        }
        else {
            overallMoat = 'Weak - vulnerable to well-funded competitor entry';
        }
        const allVulns = zones.flatMap(z => z.vulnerabilities);
        const vulnCounts = new Map();
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
    static async persistSnapshot(snapshot) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO market_defensibility_snapshots (
                    id, city, city_score, classification, data, generated_at
                ) VALUES (
                    ${snapshot.id}, ${snapshot.city}, ${snapshot.cityScore},
                    ${snapshot.cityClassification}, ${JSON.stringify(snapshot)}, ${snapshot.generatedAt}
                )
            `;
        }
        catch (error) {
            logger.warn({ error }, 'Failed to persist defensibility snapshot');
        }
    }
}
//# sourceMappingURL=DefensibilityScoreService.js.map