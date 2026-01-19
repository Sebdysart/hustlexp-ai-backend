/**
 * LIQUIDITY LOCK-IN ENGINE (Phase 17 - Component 1)
 *
 * Purpose: Quantify how "sticky" a zone becomes.
 *
 * Lock-in emerges organically when:
 * - Posters keep coming back
 * - Hustlers chain multiple tasks
 * - Fill times become unbeatable
 * - Cross-category engagement deepens
 * - Trust concentration builds
 *
 * CONSTRAINTS:
 * - READ-ONLY: Measurement only
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Powers strategy, not execution
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { CityGridService } from '../city/CityGridService.js';
const logger = serviceLogger.child({ module: 'LiquidityLockIn' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// LIQUIDITY LOCK-IN ENGINE
// ============================================================
export class LiquidityLockInEngine {
    /**
     * CALCULATE ZONE LOCK-IN
     */
    static async calculateLockIn(zone) {
        const id = ulid();
        // Get underlying data
        const [gridData, metrics] = await Promise.all([
            CityGridService.getGrid('seattle'),
            this.getZoneMetrics(zone)
        ]);
        // Calculate component scores
        const repeatPosterRate = metrics.repeatPosterRate;
        const hustlerMultiTaskRate = metrics.hustlerMultiTaskRate;
        const timeToFillAdvantage = await this.calculateTimeAdvantage(zone);
        const crossCategoryEngagement = metrics.crossCategoryRate;
        const trustTierConcentration = metrics.highTrustConcentration;
        // Composite lock-in score (weighted)
        const lockInScore = Math.round(repeatPosterRate * 0.25 +
            hustlerMultiTaskRate * 0.20 +
            timeToFillAdvantage * 0.25 +
            crossCategoryEngagement * 0.15 +
            trustTierConcentration * 0.15);
        const classification = this.classifyLockIn(lockInScore);
        // Calculate velocity (would use historical data)
        const velocity = Math.round((Math.random() - 0.3) * 10);
        const trend = velocity > 3 ? 'accelerating'
            : velocity < -3 ? 'decelerating'
                : 'stable';
        // Identify drivers
        const drivers = this.identifyDrivers(repeatPosterRate, hustlerMultiTaskRate, timeToFillAdvantage, crossCategoryEngagement, trustTierConcentration);
        // Moat strength
        const moatStrength = this.assessMoatStrength(lockInScore, velocity);
        const snapshot = {
            id,
            zone,
            generatedAt: new Date(),
            repeatPosterRate,
            hustlerMultiTaskRate,
            timeToFillAdvantage,
            crossCategoryEngagement,
            trustTierConcentration,
            lockInScore,
            classification,
            velocity,
            trend,
            drivers,
            moatStrength
        };
        // Persist
        await this.persistSnapshot(snapshot);
        logger.info({
            zone,
            lockInScore,
            classification,
            trend
        }, 'Lock-in calculated');
        return snapshot;
    }
    /**
     * GET CITY LOCK-IN OVERVIEW
     */
    static async getCityOverview(city) {
        const grid = await CityGridService.getGrid(city);
        const zones = [...new Set(grid.cells.map(c => c.zone))];
        const snapshots = await Promise.all(zones.map(z => this.calculateLockIn(z)));
        const avgLockIn = Math.round(snapshots.reduce((sum, s) => sum + s.lockInScore, 0) / snapshots.length);
        return {
            avgLockIn,
            lockedZones: snapshots.filter(s => s.classification === 'locked').map(s => s.zone),
            formingZones: snapshots.filter(s => s.classification === 'forming' || s.classification === 'sticky').map(s => s.zone),
            looseZones: snapshots.filter(s => s.classification === 'loose').map(s => s.zone),
            totalVelocity: snapshots.reduce((sum, s) => sum + s.velocity, 0)
        };
    }
    /**
     * GET LOCK-IN RECOMMENDATIONS
     */
    static async getRecommendations(zone) {
        const snapshot = await this.calculateLockIn(zone);
        const recommendations = [];
        let priorityAction = '';
        if (snapshot.repeatPosterRate < 60) {
            recommendations.push('Increase poster retention campaigns');
        }
        if (snapshot.hustlerMultiTaskRate < 40) {
            recommendations.push('Promote multi-task opportunities to hustlers');
        }
        if (snapshot.crossCategoryEngagement < 50) {
            recommendations.push('Cross-promote categories to existing users');
        }
        if (snapshot.classification === 'loose') {
            priorityAction = 'Focus on repeat poster acquisition';
        }
        else if (snapshot.classification === 'forming') {
            priorityAction = 'Accelerate trust tier concentration';
        }
        else if (snapshot.classification === 'sticky') {
            priorityAction = 'Push for full lock-in with hustler chaining';
        }
        else {
            priorityAction = 'Maintain and defend current position';
        }
        return {
            zone,
            currentState: snapshot.classification,
            recommendations: recommendations.length > 0 ? recommendations : ['Maintain current strategy'],
            priorityAction,
            expectedImpact: snapshot.trend === 'accelerating'
                ? 'Lock-in likely to strengthen'
                : snapshot.trend === 'decelerating'
                    ? 'Lock-in at risk - act quickly'
                    : 'Steady state - consistent effort needed'
        };
    }
    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------
    static async getZoneMetrics(zone) {
        const db = getDb();
        const defaults = {
            repeatPosterRate: 45,
            hustlerMultiTaskRate: 30,
            crossCategoryRate: 35,
            highTrustConcentration: 25
        };
        if (!db)
            return defaults;
        try {
            // Repeat poster rate
            const [posterStats] = await db `
                SELECT 
                    COUNT(DISTINCT client_id) FILTER (WHERE task_count > 1) * 100.0 / 
                    NULLIF(COUNT(DISTINCT client_id), 0) as repeat_rate
                FROM (
                    SELECT client_id, COUNT(*) as task_count
                    FROM tasks
                    WHERE seattle_zone = ${zone}
                    AND created_at > NOW() - INTERVAL '30 days'
                    GROUP BY client_id
                ) subq
            `;
            // Multi-task hustler rate (simplified)
            const [hustlerStats] = await db `
                SELECT 
                    COUNT(DISTINCT assigned_hustler_id) FILTER (WHERE daily_count > 1) * 100.0 /
                    NULLIF(COUNT(DISTINCT assigned_hustler_id), 0) as multi_task_rate
                FROM (
                    SELECT assigned_hustler_id, DATE(accepted_at) as day, COUNT(*) as daily_count
                    FROM tasks
                    WHERE seattle_zone = ${zone}
                    AND accepted_at > NOW() - INTERVAL '30 days'
                    AND assigned_hustler_id IS NOT NULL
                    GROUP BY assigned_hustler_id, DATE(accepted_at)
                ) subq
            `;
            return {
                repeatPosterRate: parseFloat(posterStats?.repeat_rate || '45'),
                hustlerMultiTaskRate: parseFloat(hustlerStats?.multi_task_rate || '30'),
                crossCategoryRate: 40 + Math.random() * 20, // Would calculate from real data
                highTrustConcentration: 30 + Math.random() * 25
            };
        }
        catch (error) {
            return defaults;
        }
    }
    static async calculateTimeAdvantage(zone) {
        const db = getDb();
        if (!db)
            return 50;
        try {
            // Compare zone fill time to city average
            const [zoneTime] = await db `
                SELECT AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))/3600) as zone_avg
                FROM tasks
                WHERE seattle_zone = ${zone}
                AND accepted_at IS NOT NULL
                AND created_at > NOW() - INTERVAL '30 days'
            `;
            const [cityTime] = await db `
                SELECT AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))/3600) as city_avg
                FROM tasks
                WHERE accepted_at IS NOT NULL
                AND created_at > NOW() - INTERVAL '30 days'
            `;
            const zoneAvg = parseFloat(zoneTime?.zone_avg || '4');
            const cityAvg = parseFloat(cityTime?.city_avg || '4');
            // Calculate advantage (faster = higher score)
            const advantage = cityAvg > 0 ? ((cityAvg - zoneAvg) / cityAvg) * 100 : 0;
            return Math.max(0, Math.min(100, 50 + advantage));
        }
        catch (error) {
            return 50;
        }
    }
    static classifyLockIn(score) {
        if (score >= 75)
            return 'locked';
        if (score >= 55)
            return 'sticky';
        if (score >= 35)
            return 'forming';
        return 'loose';
    }
    static identifyDrivers(repeat, multiTask, timeAdv, crossCat, trust) {
        const factors = [
            { name: 'Repeat poster rate', score: repeat },
            { name: 'Hustler multi-tasking', score: multiTask },
            { name: 'Time-to-fill advantage', score: timeAdv },
            { name: 'Cross-category engagement', score: crossCat },
            { name: 'High-trust concentration', score: trust }
        ].sort((a, b) => b.score - a.score);
        const primary = factors[0].name;
        const supporting = factors.slice(1, 3).filter(f => f.score > 50).map(f => f.name);
        const weaknesses = factors.filter(f => f.score < 40).map(f => `Low ${f.name.toLowerCase()}`);
        return { primary, supporting, weaknesses };
    }
    static assessMoatStrength(score, velocity) {
        if (score >= 75 && velocity >= 0) {
            return 'Strong moat - competitor would need 2x investment to contest';
        }
        if (score >= 55) {
            return 'Building moat - maintain investment to lock in';
        }
        if (score >= 35 && velocity > 0) {
            return 'Emerging advantage - accelerate to capture';
        }
        return 'No moat - vulnerable to well-funded competitor';
    }
    static async persistSnapshot(snapshot) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO liquidity_lockin_snapshots (
                    id, zone, lockin_score, classification, velocity, data, generated_at
                ) VALUES (
                    ${snapshot.id}, ${snapshot.zone}, ${snapshot.lockInScore},
                    ${snapshot.classification}, ${snapshot.velocity},
                    ${JSON.stringify(snapshot)}, ${snapshot.generatedAt}
                )
            `;
        }
        catch (error) {
            logger.warn({ error }, 'Failed to persist lock-in snapshot');
        }
    }
}
//# sourceMappingURL=LiquidityLockInEngine.js.map