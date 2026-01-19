/**
 * ZONE TAKEOVER ENGINE (Phase 17 - Component 5)
 *
 * Purpose: Declare when a zone crosses winner-take-most threshold.
 *
 * Takeover criteria:
 * - ≥65% task share
 * - ≥80% repeat usage
 * - ≥30% faster fill time
 * - ≥2× trust velocity vs city average
 *
 * This engine answers: "Have we won this zone?"
 *
 * CONSTRAINTS:
 * - READ-ONLY: Declaration only
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Strategic intelligence
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { LiquidityLockInEngine } from './LiquidityLockInEngine.js';
import { TaskChainingEngine } from './TaskChainingEngine.js';
import { ReputationCompoundingService } from './ReputationCompoundingService.js';
import { ExitFrictionAnalyzer } from './ExitFrictionAnalyzer.js';
const logger = serviceLogger.child({ module: 'ZoneTakeover' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// ZONE TAKEOVER ENGINE
// ============================================================
export class ZoneTakeoverEngine {
    /**
     * GET ZONE TAKEOVER STATE
     */
    static async getZoneState(zone) {
        const id = ulid();
        // Get all underlying metrics
        const [lockIn, chaining, reputation, exitFriction] = await Promise.all([
            LiquidityLockInEngine.calculateLockIn(zone),
            TaskChainingEngine.getZoneChainingMetrics(zone),
            ReputationCompoundingService.getZoneMetrics(zone),
            ExitFrictionAnalyzer.analyzeZone(zone)
        ]);
        // Calculate takeover criteria
        const criteria = await this.calculateCriteria(zone, lockIn, chaining, reputation);
        const criteriaStatus = this.evaluateCriteria(criteria);
        // Determine status
        const status = this.determineStatus(criteriaStatus);
        // Calculate moat depth
        const moatDepth = this.calculateMoatDepth(lockIn, exitFriction, criteriaStatus);
        // Determine defense priority
        const defensePriority = this.determineDefensePriority(status, moatDepth);
        // Context
        const context = await this.buildContext(zone, status, criteriaStatus);
        // Recommendations
        const recommendations = this.generateRecommendations(status, criteriaStatus, moatDepth);
        const state = {
            id,
            zone,
            generatedAt: new Date(),
            status,
            moatDepth,
            defensePriority,
            criteria,
            criteriaStatus,
            context,
            recommendations
        };
        // Persist
        await this.persistState(state);
        logger.info({
            zone,
            status,
            moatDepth,
            criteriaMet: criteriaStatus.totalMet
        }, 'Zone takeover state calculated');
        return state;
    }
    /**
     * GET CITY TAKEOVER SUMMARY
     */
    static async getCityTakeoverSummary(city) {
        // Get all zones
        const zones = await this.getCityZones(city);
        // Get state for each zone
        const states = await Promise.all(zones.map(zone => this.getZoneState(zone)));
        // Categorize
        const capturedZones = states.filter(s => s.status === 'captured').map(s => s.zone);
        const tippingZones = states.filter(s => s.status === 'tipping').map(s => s.zone);
        const contestedZones = states.filter(s => s.status === 'contested').map(s => s.zone);
        // City-level metrics
        const avgMoatDepth = Math.round(states.reduce((sum, s) => sum + s.moatDepth, 0) / states.length);
        const totalCriteriaMet = Math.round(states.reduce((sum, s) => sum + s.criteriaStatus.totalMet, 0) / states.length * 25);
        // Determine overall status
        const overallStatus = this.determineOverallStatus(capturedZones.length, zones.length);
        // Project capture
        const projectedCapture = this.projectFullCapture(states);
        // Strategic priorities
        const priorities = this.determinePriorities(states);
        return {
            city,
            generatedAt: new Date(),
            capturedZones,
            tippingZones,
            contestedZones,
            cityDominance: {
                overallStatus,
                avgMoatDepth,
                totalCriteriaMet,
                projectedFullCapture: projectedCapture
            },
            priorities
        };
    }
    /**
     * CHECK IF ZONE IS CAPTURED
     */
    static async isZoneCaptured(zone) {
        const state = await this.getZoneState(zone);
        const missingCriteria = [];
        if (!state.criteriaStatus.taskShareMet)
            missingCriteria.push('task share');
        if (!state.criteriaStatus.repeatUsageMet)
            missingCriteria.push('repeat usage');
        if (!state.criteriaStatus.fillTimeAdvantageMet)
            missingCriteria.push('fill time advantage');
        if (!state.criteriaStatus.trustVelocityMet)
            missingCriteria.push('trust velocity');
        return {
            captured: state.status === 'captured',
            status: state.status,
            moatDepth: state.moatDepth,
            missingCriteria
        };
    }
    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------
    static async calculateCriteria(zone, lockIn, chaining, reputation) {
        const db = getDb();
        // Task share (would need competitor data in production)
        const taskSharePct = 45 + lockIn.lockInScore * 0.35;
        // Repeat usage
        const repeatUsagePct = lockIn.repeatPosterRate;
        // Fill time advantage
        const fillTimeAdvantagePct = lockIn.timeToFillAdvantage - 50; // Relative to baseline
        // Trust velocity multiple
        const cityAvgVelocity = 5; // Would calculate from city data
        const trustVelocityMultiple = reputation.avgTrustVelocity / cityAvgVelocity;
        return {
            taskSharePct: Math.round(taskSharePct),
            repeatUsagePct: Math.round(repeatUsagePct),
            fillTimeAdvantagePct: Math.round(fillTimeAdvantagePct),
            trustVelocityMultiple: Math.round(trustVelocityMultiple * 10) / 10
        };
    }
    static evaluateCriteria(criteria) {
        const taskShareMet = criteria.taskSharePct >= 65;
        const repeatUsageMet = criteria.repeatUsagePct >= 80;
        const fillTimeAdvantageMet = criteria.fillTimeAdvantagePct >= 30;
        const trustVelocityMet = criteria.trustVelocityMultiple >= 2.0;
        return {
            taskShareMet,
            repeatUsageMet,
            fillTimeAdvantageMet,
            trustVelocityMet,
            totalMet: [taskShareMet, repeatUsageMet, fillTimeAdvantageMet, trustVelocityMet].filter(Boolean).length
        };
    }
    static determineStatus(criteriaStatus) {
        if (criteriaStatus.totalMet >= 4)
            return 'captured';
        if (criteriaStatus.totalMet >= 2)
            return 'tipping';
        return 'contested';
    }
    static calculateMoatDepth(lockIn, exitFriction, criteria) {
        // Moat depth based on lock-in, exit friction, and criteria met
        return Math.round((lockIn.lockInScore * 0.4) +
            (exitFriction.avgExitCostIndex * 0.35) +
            (criteria.totalMet * 10));
    }
    static determineDefensePriority(status, moatDepth) {
        if (status === 'captured' && moatDepth > 70)
            return 'low';
        if (status === 'captured')
            return 'medium';
        if (status === 'tipping' && moatDepth > 50)
            return 'medium';
        if (status === 'tipping')
            return 'high';
        return 'critical';
    }
    static async buildContext(zone, status, criteria) {
        // Would track historical status in production
        const threatLevel = status === 'captured' ? 'Low - moat established'
            : status === 'tipping' ? 'Medium - vulnerable to well-funded entrant'
                : 'High - zone still contestable';
        const competitorPresence = 'Unknown - no competitor data yet';
        const projectedCaptureDate = status === 'tipping' && criteria.totalMet >= 3
            ? 'Est. 4-6 weeks'
            : status === 'tipping'
                ? 'Est. 8-12 weeks'
                : 'Not yet projectable';
        return {
            timeSinceTipping: status !== 'contested' ? 'Recent transition' : undefined,
            projectedCaptureDate: status !== 'captured' ? projectedCaptureDate : undefined,
            threatLevel,
            competitorPresence
        };
    }
    static generateRecommendations(status, criteria, moatDepth) {
        const recs = [];
        if (status === 'captured') {
            recs.push('Maintain current investment level');
            if (moatDepth < 70) {
                recs.push('Deepen moat through trust velocity improvement');
            }
            return recs;
        }
        if (!criteria.taskShareMet) {
            recs.push('Increase poster acquisition to grow task share');
        }
        if (!criteria.repeatUsageMet) {
            recs.push('Focus on retention campaigns for existing posters');
        }
        if (!criteria.fillTimeAdvantageMet) {
            recs.push('Recruit more hustlers to reduce fill time');
        }
        if (!criteria.trustVelocityMet) {
            recs.push('Accelerate trust tier progression through quality focus');
        }
        if (status === 'tipping') {
            recs.push('PRIORITY: Accelerate before competitor notices tipping point');
        }
        return recs;
    }
    static async getCityZones(city) {
        // Seattle zones
        if (city.toLowerCase() === 'seattle') {
            return [
                'Capitol Hill', 'Ballard', 'Fremont', 'University District',
                'Queen Anne', 'Downtown', 'Beacon Hill', 'Columbia City',
                'West Seattle', 'Greenwood', 'Wallingford'
            ];
        }
        return [];
    }
    static determineOverallStatus(captured, total) {
        const ratio = captured / total;
        if (ratio >= 0.7)
            return 'City dominance achieved';
        if (ratio >= 0.4)
            return 'City dominance forming';
        if (ratio > 0)
            return 'City presence established';
        return 'City still contested';
    }
    static projectFullCapture(states) {
        const tipping = states.filter(s => s.status === 'tipping').length;
        const captured = states.filter(s => s.status === 'captured').length;
        const total = states.length;
        if (captured === total)
            return 'Complete';
        if (captured + tipping >= total * 0.8)
            return 'Est. 2-4 weeks';
        if (captured + tipping >= total * 0.5)
            return 'Est. 6-10 weeks';
        return 'Est. 3+ months';
    }
    static determinePriorities(states) {
        return {
            defend: states
                .filter(s => s.status === 'captured' && s.moatDepth < 60)
                .map(s => s.zone)
                .slice(0, 3),
            accelerate: states
                .filter(s => s.status === 'tipping')
                .map(s => s.zone)
                .slice(0, 3),
            contest: states
                .filter(s => s.status === 'contested' && s.criteriaStatus.totalMet >= 1)
                .map(s => s.zone)
                .slice(0, 3)
        };
    }
    static async persistState(state) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO zone_takeover_states (
                    id, zone, status, moat_depth, criteria_met, data, generated_at
                ) VALUES (
                    ${state.id}, ${state.zone}, ${state.status},
                    ${state.moatDepth}, ${state.criteriaStatus.totalMet},
                    ${JSON.stringify(state)}, ${state.generatedAt}
                )
            `;
        }
        catch (error) {
            logger.warn({ error }, 'Failed to persist takeover state');
        }
    }
}
//# sourceMappingURL=ZoneTakeoverEngine.js.map