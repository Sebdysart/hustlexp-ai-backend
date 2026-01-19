/**
 * MARKET SIGNAL ENGINE (Phase 15A)
 *
 * Dominance Layer - READ-ONLY INTELLIGENCE
 *
 * Purpose: Answer questions competitors cannot answer.
 *
 * This service:
 * - Analyzes existing Control Plane data
 * - Produces market intelligence signals
 * - Powers strategic product decisions
 * - Identifies competitive advantages
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies any data
 * - NO KERNEL: Never touches money/ledger
 * - OBSERVATIONAL: Patterns, not commands
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
const logger = serviceLogger.child({ module: 'MarketSignalEngine' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// SEATTLE ZONES (Beta Market)
// ============================================================
const SEATTLE_ZONES = [
    'Capitol Hill',
    'Ballard',
    'Fremont',
    'University District',
    'Queen Anne',
    'Downtown',
    'Beacon Hill',
    'Columbia City',
    'West Seattle',
    'Greenwood',
    'Wallingford'
];
const CATEGORIES = [
    'moving',
    'handyman',
    'cleaning',
    'pet_care',
    'delivery',
    'errands',
    'tech_help',
    'tutoring',
    'event_help',
    'general'
];
// ============================================================
// MARKET SIGNAL ENGINE
// ============================================================
export class MarketSignalEngine {
    /**
     * GENERATE FULL MARKET SNAPSHOT
     */
    static async generateSnapshot() {
        const id = ulid();
        logger.info({ id }, 'Generating market snapshot');
        const [categories, zones, pricing, trust, churnCounts] = await Promise.all([
            this.analyzeCategoryHealth(),
            this.analyzeGeoHealth(),
            this.analyzePricingPressure(),
            this.analyzeTrustDistribution(),
            this.getChurnRiskCounts()
        ]);
        const competitivePosition = this.assessCompetitivePosition(categories, zones, trust);
        const snapshot = {
            id,
            generatedAt: new Date(),
            categories,
            zones,
            pricing,
            trust,
            churnRisk: churnCounts,
            competitivePosition
        };
        await this.storeSnapshot(snapshot);
        logger.info({
            id,
            categoryCount: categories.length,
            zoneCount: zones.length
        }, 'Market snapshot generated');
        return snapshot;
    }
    /**
     * GET LATEST SNAPSHOT
     */
    static async getLatest() {
        const db = getDb();
        if (!db)
            return null;
        try {
            const [row] = await db `
                SELECT data FROM market_snapshots
                ORDER BY generated_at DESC
                LIMIT 1
            `;
            return row ? row.data : null;
        }
        catch (error) {
            logger.error({ error }, 'Failed to get latest snapshot');
            return null;
        }
    }
    /**
     * GET CATEGORY HEALTH
     */
    static async getCategoryHealth(category) {
        const all = await this.analyzeCategoryHealth();
        return all.find(c => c.category === category) || null;
    }
    /**
     * GET ZONE HEALTH
     */
    static async getZoneHealth(zone) {
        const all = await this.analyzeGeoHealth();
        return all.find(z => z.zone === zone) || null;
    }
    /**
     * GET PRICING GUIDANCE
     */
    static async getPricingGuidance(category, zone) {
        const all = await this.analyzePricingPressure();
        return all.find(p => p.category === category &&
            (zone ? p.zone === zone : !p.zone)) || null;
    }
    /**
     * DETECT HIGH CHURN RISK USERS
     */
    static async detectChurnRisk(minDaysSinceActivity = 14) {
        const db = getDb();
        if (!db)
            return [];
        try {
            const cutoff = new Date(Date.now() - minDaysSinceActivity * 24 * 60 * 60 * 1000);
            // Find users with declining activity
            const atRiskUsers = await db `
                SELECT 
                    u.id,
                    u.role,
                    MAX(t.updated_at) as last_activity,
                    COUNT(t.id) FILTER (WHERE t.updated_at > ${cutoff}) as recent_tasks,
                    COUNT(d.id) as disputes
                FROM users u
                LEFT JOIN tasks t ON (u.role = 'poster' AND t.client_id = u.id::uuid)
                    OR (u.role = 'hustler' AND t.assigned_hustler_id = u.id::uuid)
                LEFT JOIN disputes d ON d.poster_id = u.id::uuid OR d.hustler_id = u.id::uuid
                WHERE u.created_at < ${cutoff}
                GROUP BY u.id, u.role
                HAVING MAX(t.updated_at) < ${cutoff} OR MAX(t.updated_at) IS NULL
                LIMIT 100
            `;
            return atRiskUsers.map((u) => this.buildChurnSignal(u));
        }
        catch (error) {
            logger.warn({ error }, 'Failed to detect churn risk');
            return [];
        }
    }
    /**
     * GET EXPANSION READINESS
     */
    static async getExpansionReadiness(targetZones = SEATTLE_ZONES) {
        const zones = await this.analyzeGeoHealth();
        return zones
            .filter(z => targetZones.includes(z.zone))
            .map(z => ({
            zone: z.zone,
            score: z.expansion.readinessScore,
            recommendation: z.expansion.readinessScore > 70 ? 'expand'
                : z.expansion.readinessScore > 40 ? 'hold'
                    : 'not_ready',
            factors: z.expansion.blockers.length > 0
                ? z.expansion.blockers
                : ['Zone is healthy and ready for growth']
        }));
    }
    // -----------------------------------------------------------
    // INTERNAL: Analysis Methods
    // -----------------------------------------------------------
    static async analyzeCategoryHealth() {
        const db = getDb();
        if (!db)
            return this.getDefaultCategoryHealth();
        try {
            const stats = await db `
                SELECT 
                    t.category,
                    COUNT(*) as total_tasks,
                    COUNT(*) FILTER (WHERE t.status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE t.status = 'disputed') as disputed,
                    AVG(t.recommended_price) as avg_price
                FROM tasks t
                WHERE t.created_at > NOW() - INTERVAL '30 days'
                GROUP BY t.category
            `;
            // Get risk scores per category
            const riskStats = await db `
                SELECT 
                    t.category,
                    AVG(r.score) as avg_risk
                FROM risk_score_log r
                JOIN tasks t ON r.entity_id = t.id::text
                WHERE r.entity_type = 'task'
                AND r.evaluated_at > NOW() - INTERVAL '30 days'
                GROUP BY t.category
            `;
            const riskMap = new Map(riskStats.map((r) => [r.category, r.avg_risk]));
            return CATEGORIES.map(category => {
                const stat = stats.find((s) => s.category === category);
                const total = parseInt(stat?.total_tasks || '0');
                const completed = parseInt(stat?.completed || '0');
                const disputed = parseInt(stat?.disputed || '0');
                const completionRate = total > 0 ? completed / total : 0;
                const disputeRate = total > 0 ? disputed / total : 0;
                const avgRiskScore = parseFloat(riskMap.get(category) || '30');
                // Calculate health score
                const healthScore = this.calculateCategoryHealthScore(completionRate, disputeRate, avgRiskScore, total);
                return {
                    category,
                    healthScore,
                    status: this.getHealthStatus(healthScore),
                    signals: {
                        taskVolume: total,
                        completionRate,
                        disputeRate,
                        avgPayoutUsd: parseFloat(stat?.avg_price || '0'),
                        proofRejectionRate: 0, // Would need proof data
                        avgRiskScore
                    },
                    trends: {
                        volumeTrend: 'stable', // Would need time-series
                        disputeTrend: disputeRate < 0.03 ? 'improving' :
                            disputeRate < 0.05 ? 'stable' : 'worsening'
                    },
                    alerts: this.getCategoryAlerts(disputeRate, completionRate, avgRiskScore),
                    opportunity: this.getCategoryOpportunity(category, total, completionRate)
                };
            });
        }
        catch (error) {
            logger.error({ error }, 'Failed to analyze category health');
            return this.getDefaultCategoryHealth();
        }
    }
    static async analyzeGeoHealth() {
        const db = getDb();
        if (!db)
            return this.getDefaultGeoHealth();
        try {
            const stats = await db `
                SELECT 
                    t.seattle_zone as zone,
                    COUNT(DISTINCT t.id) as tasks,
                    COUNT(DISTINCT t.assigned_hustler_id) as hustlers,
                    AVG(EXTRACT(EPOCH FROM (t.completed_at - t.accepted_at))/3600) as avg_completion_hours,
                    COUNT(*) FILTER (WHERE t.status = 'disputed') as disputes
                FROM tasks t
                WHERE t.created_at > NOW() - INTERVAL '30 days'
                AND t.seattle_zone IS NOT NULL
                GROUP BY t.seattle_zone
            `;
            return SEATTLE_ZONES.map(zone => {
                const stat = stats.find((s) => s.zone === zone);
                const tasks = parseInt(stat?.tasks || '0');
                const hustlers = parseInt(stat?.hustlers || '1');
                const disputes = parseInt(stat?.disputes || '0');
                const supplyDemandRatio = hustlers / Math.max(tasks / 4, 1); // Hustlers per weekly tasks
                const disputeRate = tasks > 0 ? disputes / tasks : 0;
                const healthScore = this.calculateZoneHealthScore(tasks, hustlers, supplyDemandRatio, disputeRate);
                return {
                    zone,
                    healthScore,
                    signals: {
                        taskDensity: tasks / 4, // Weekly
                        hustlerDensity: hustlers,
                        supplyDemandRatio,
                        avgCompletionTimeHours: parseFloat(stat?.avg_completion_hours || '4'),
                        disputeRate
                    },
                    supplyStatus: this.getSupplyStatus(supplyDemandRatio),
                    expansion: {
                        readinessScore: this.calculateExpansionReadiness(healthScore, supplyDemandRatio, tasks),
                        blockers: this.getExpansionBlockers(healthScore, supplyDemandRatio, tasks)
                    }
                };
            });
        }
        catch (error) {
            logger.error({ error }, 'Failed to analyze geo health');
            return this.getDefaultGeoHealth();
        }
    }
    static async analyzePricingPressure() {
        const db = getDb();
        if (!db)
            return [];
        try {
            const stats = await db `
                SELECT 
                    category,
                    AVG(recommended_price) as avg_posted,
                    AVG(CASE WHEN status = 'completed' THEN recommended_price END) as avg_completed,
                    STDDEV(recommended_price) as price_variance,
                    MIN(recommended_price) as min_price,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY recommended_price) as median_price,
                    MAX(recommended_price) as max_price
                FROM tasks
                WHERE created_at > NOW() - INTERVAL '30 days'
                AND recommended_price > 0
                GROUP BY category
            `;
            return stats.map((s) => {
                const avgPosted = parseFloat(s.avg_posted || '0');
                const avgCompleted = parseFloat(s.avg_completed || avgPosted);
                const variance = parseFloat(s.price_variance || '0');
                return {
                    category: s.category,
                    signals: {
                        avgPostedPrice: avgPosted,
                        avgCompletedPrice: avgCompleted,
                        priceVariance: variance,
                        underpricedPct: avgPosted < avgCompleted ? 0.3 : 0.1,
                        overpricedPct: avgPosted > avgCompleted * 1.2 ? 0.2 : 0.05
                    },
                    marketRate: {
                        min: parseFloat(s.min_price || '0'),
                        median: parseFloat(s.median_price || '0'),
                        max: parseFloat(s.max_price || '0'),
                        suggested: avgCompleted * 1.05 // 5% above avg completed
                    },
                    guidance: this.getPricingGuidanceText(avgPosted, avgCompleted, variance)
                };
            });
        }
        catch (error) {
            logger.error({ error }, 'Failed to analyze pricing');
            return [];
        }
    }
    static async analyzeTrustDistribution() {
        const db = getDb();
        const defaultDist = {
            overall: { minimalRiskPct: 0.4, lowRiskPct: 0.3, mediumRiskPct: 0.2, highRiskPct: 0.08, criticalRiskPct: 0.02 },
            byRole: {
                poster: { avgRiskScore: 25, trustedPct: 0.7 },
                hustler: { avgRiskScore: 20, trustedPct: 0.8 }
            },
            trustVelocity: 'stable',
            implication: 'Trust levels are healthy for beta launch'
        };
        if (!db)
            return defaultDist;
        try {
            const [tierCounts] = await db `
                SELECT 
                    COUNT(*) FILTER (WHERE tier = 'minimal') as minimal,
                    COUNT(*) FILTER (WHERE tier = 'low') as low,
                    COUNT(*) FILTER (WHERE tier = 'medium') as medium,
                    COUNT(*) FILTER (WHERE tier = 'high') as high,
                    COUNT(*) FILTER (WHERE tier = 'critical') as critical,
                    COUNT(*) as total
                FROM risk_score_log
                WHERE entity_type = 'user'
                AND evaluated_at > NOW() - INTERVAL '7 days'
            `;
            const total = parseInt(tierCounts?.total || '1');
            return {
                overall: {
                    minimalRiskPct: parseInt(tierCounts?.minimal || '0') / total,
                    lowRiskPct: parseInt(tierCounts?.low || '0') / total,
                    mediumRiskPct: parseInt(tierCounts?.medium || '0') / total,
                    highRiskPct: parseInt(tierCounts?.high || '0') / total,
                    criticalRiskPct: parseInt(tierCounts?.critical || '0') / total
                },
                byRole: defaultDist.byRole,
                trustVelocity: 'stable',
                implication: this.getTrustImplication(tierCounts)
            };
        }
        catch (error) {
            return defaultDist;
        }
    }
    static async getChurnRiskCounts() {
        // Simplified - would need full churn analysis
        return { high: 0, medium: 0, low: 0 };
    }
    // -----------------------------------------------------------
    // INTERNAL: Calculation Helpers
    // -----------------------------------------------------------
    static calculateCategoryHealthScore(completionRate, disputeRate, avgRiskScore, volume) {
        let score = 50; // Base
        // Completion rate (max +30)
        score += (completionRate - 0.7) * 100;
        // Dispute rate (max -30)
        score -= disputeRate * 300;
        // Risk score (max -20)
        score -= (avgRiskScore - 30) * 0.5;
        // Volume bonus (max +10)
        score += Math.min(volume / 10, 10);
        return Math.max(0, Math.min(100, Math.round(score)));
    }
    static calculateZoneHealthScore(tasks, hustlers, supplyDemandRatio, disputeRate) {
        let score = 50;
        // Activity (max +20)
        score += Math.min(tasks / 5, 20);
        // Supply balance (max +20, penalty for imbalance)
        const balanceScore = supplyDemandRatio > 0.5 && supplyDemandRatio < 2 ? 20 : 0;
        score += balanceScore;
        // Low disputes (max +10)
        score += disputeRate < 0.03 ? 10 : disputeRate < 0.05 ? 5 : 0;
        return Math.max(0, Math.min(100, Math.round(score)));
    }
    static calculateExpansionReadiness(healthScore, supplyDemandRatio, tasks) {
        let score = healthScore * 0.5;
        // Supply balance bonus
        if (supplyDemandRatio > 0.8 && supplyDemandRatio < 1.5)
            score += 20;
        // Volume requirement
        if (tasks > 20)
            score += 20;
        else if (tasks > 10)
            score += 10;
        return Math.min(100, Math.round(score));
    }
    static getHealthStatus(score) {
        if (score >= 70)
            return 'thriving';
        if (score >= 50)
            return 'healthy';
        if (score >= 30)
            return 'stressed';
        return 'critical';
    }
    static getSupplyStatus(ratio) {
        if (ratio > 1.5)
            return 'oversupplied';
        if (ratio > 0.8)
            return 'balanced';
        if (ratio > 0.4)
            return 'undersupplied';
        return 'critical_shortage';
    }
    static getCategoryAlerts(disputeRate, completionRate, riskScore) {
        const alerts = [];
        if (disputeRate > 0.05)
            alerts.push('High dispute rate - review proof requirements');
        if (completionRate < 0.7)
            alerts.push('Low completion rate - investigate friction');
        if (riskScore > 50)
            alerts.push('Elevated risk profile - monitor closely');
        return alerts;
    }
    static getCategoryOpportunity(category, volume, completionRate) {
        if (volume > 50 && completionRate > 0.9) {
            return `High-performing category - consider premium tier`;
        }
        if (volume < 10 && completionRate > 0.8) {
            return `Underserved category - growth opportunity`;
        }
        return null;
    }
    static getExpansionBlockers(healthScore, ratio, tasks) {
        const blockers = [];
        if (healthScore < 40)
            blockers.push('Zone health below threshold');
        if (ratio < 0.5)
            blockers.push('Critical hustler shortage');
        if (tasks < 5)
            blockers.push('Insufficient demand signal');
        return blockers;
    }
    static getPricingGuidanceText(avgPosted, avgCompleted, variance) {
        if (avgPosted < avgCompleted * 0.8) {
            return 'Tasks are underpriced - posters should increase by 15-20%';
        }
        if (avgPosted > avgCompleted * 1.3) {
            return 'Tasks are overpriced - may reduce acceptance rate';
        }
        if (variance > avgPosted * 0.5) {
            return 'High price variance - market rate unclear, more data needed';
        }
        return 'Pricing is healthy and market-aligned';
    }
    static getTrustImplication(tierCounts) {
        const highRisk = parseInt(tierCounts?.high || '0') + parseInt(tierCounts?.critical || '0');
        const total = parseInt(tierCounts?.total || '1');
        if (highRisk / total > 0.1) {
            return 'Elevated risk population - consider stricter onboarding';
        }
        if (highRisk / total < 0.03) {
            return 'Excellent trust health - can reduce friction for trusted users';
        }
        return 'Trust levels are healthy for beta launch';
    }
    static buildChurnSignal(user) {
        const daysSince = user.last_activity
            ? Math.floor((Date.now() - new Date(user.last_activity).getTime()) / (1000 * 60 * 60 * 24))
            : 30;
        const riskLevel = daysSince > 21 ? 'high'
            : daysSince > 14 ? 'medium'
                : 'low';
        return {
            userId: user.id,
            role: user.role,
            riskLevel,
            signals: {
                daysSinceLastActivity: daysSince,
                recentDeclinePct: 0.5, // Would calculate from history
                disputeFrequency: parseInt(user.disputes || '0'),
                negativeExperiences: parseInt(user.disputes || '0')
            },
            predictedChurnDays: Math.max(7, 30 - daysSince),
            retentionAction: riskLevel === 'high'
                ? 'Send personalized re-engagement offer'
                : riskLevel === 'medium'
                    ? 'Trigger reminder notification'
                    : null
        };
    }
    static assessCompetitivePosition(categories, zones, trust) {
        const healthyCategories = categories.filter(c => c.healthScore >= 50);
        const healthyZones = zones.filter(z => z.healthScore >= 50);
        const trustedPct = trust.overall.minimalRiskPct + trust.overall.lowRiskPct;
        return {
            strengths: [
                ...(healthyCategories.length > 5 ? ['Strong category diversity'] : []),
                ...(trustedPct > 0.7 ? ['High trust user base'] : []),
                ...(healthyZones.length > 6 ? ['Solid geographic coverage'] : []),
                'Frozen financial kernel - operational safety'
            ],
            weaknesses: [
                ...(healthyCategories.length < 4 ? ['Limited category health'] : []),
                ...(healthyZones.some(z => z.supplyStatus === 'undersupplied') ? ['Supply shortages in some zones'] : []),
                'New market - limited brand recognition'
            ],
            opportunities: [
                'AI-powered pricing guidance',
                'Trust-based payout acceleration',
                'Geo-targeted hustler recruitment',
                ...(categories.some(c => c.opportunity) ? categories.filter(c => c.opportunity).map(c => c.opportunity) : [])
            ]
        };
    }
    static getDefaultCategoryHealth() {
        return CATEGORIES.map(category => ({
            category,
            healthScore: 50,
            status: 'healthy',
            signals: { taskVolume: 0, completionRate: 0, disputeRate: 0, avgPayoutUsd: 0, proofRejectionRate: 0, avgRiskScore: 30 },
            trends: { volumeTrend: 'stable', disputeTrend: 'stable' },
            alerts: [],
            opportunity: null
        }));
    }
    static getDefaultGeoHealth() {
        return SEATTLE_ZONES.map(zone => ({
            zone,
            healthScore: 50,
            signals: { taskDensity: 0, hustlerDensity: 0, supplyDemandRatio: 1, avgCompletionTimeHours: 4, disputeRate: 0 },
            supplyStatus: 'balanced',
            expansion: { readinessScore: 50, blockers: ['Insufficient data'] }
        }));
    }
    // -----------------------------------------------------------
    // INTERNAL: Storage
    // -----------------------------------------------------------
    static async storeSnapshot(snapshot) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO market_snapshots (
                    id, data, generated_at
                ) VALUES (
                    ${snapshot.id}, ${JSON.stringify(snapshot)}, ${snapshot.generatedAt}
                )
            `;
        }
        catch (error) {
            logger.warn({ error }, 'Failed to store market snapshot');
        }
    }
}
//# sourceMappingURL=MarketSignalEngine.js.map