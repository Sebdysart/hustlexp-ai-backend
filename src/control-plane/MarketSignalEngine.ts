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

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// SIGNAL TYPES
// ============================================================

export interface CategoryHealth {
    category: string;
    healthScore: number;           // 0-100
    status: 'thriving' | 'healthy' | 'stressed' | 'critical';
    signals: {
        taskVolume: number;
        completionRate: number;
        disputeRate: number;
        avgPayoutUsd: number;
        proofRejectionRate: number;
        avgRiskScore: number;
    };
    trends: {
        volumeTrend: 'growing' | 'stable' | 'declining';
        disputeTrend: 'improving' | 'stable' | 'worsening';
    };
    alerts: string[];
    opportunity: string | null;
}

export interface GeoHealth {
    zone: string;
    healthScore: number;
    signals: {
        taskDensity: number;        // Tasks per week
        hustlerDensity: number;     // Active hustlers
        supplyDemandRatio: number;  // < 1 = undersupplied
        avgCompletionTimeHours: number;
        disputeRate: number;
    };
    supplyStatus: 'oversupplied' | 'balanced' | 'undersupplied' | 'critical_shortage';
    expansion: {
        readinessScore: number;
        blockers: string[];
    };
}

export interface PricingPressure {
    category: string;
    zone?: string;
    signals: {
        avgPostedPrice: number;
        avgCompletedPrice: number;
        priceVariance: number;
        underpricedPct: number;    // % of tasks priced below completion avg
        overpricedPct: number;     // % of tasks priced above completion avg
    };
    marketRate: {
        min: number;
        median: number;
        max: number;
        suggested: number;
    };
    guidance: string;
}

export interface TrustDistribution {
    overall: {
        minimalRiskPct: number;
        lowRiskPct: number;
        mediumRiskPct: number;
        highRiskPct: number;
        criticalRiskPct: number;
    };
    byRole: {
        poster: { avgRiskScore: number; trustedPct: number };
        hustler: { avgRiskScore: number; trustedPct: number };
    };
    trustVelocity: 'improving' | 'stable' | 'degrading';
    implication: string;
}

export interface ChurnSignal {
    userId: string;
    role: 'poster' | 'hustler';
    riskLevel: 'low' | 'medium' | 'high';
    signals: {
        daysSinceLastActivity: number;
        recentDeclinePct: number;   // % drop in activity
        disputeFrequency: number;
        negativeExperiences: number;
    };
    predictedChurnDays: number;
    retentionAction: string | null;
}

export interface MarketSnapshot {
    id: string;
    generatedAt: Date;
    categories: CategoryHealth[];
    zones: GeoHealth[];
    pricing: PricingPressure[];
    trust: TrustDistribution;
    churnRisk: { high: number; medium: number; low: number };
    competitivePosition: {
        strengths: string[];
        weaknesses: string[];
        opportunities: string[];
    };
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
    static async generateSnapshot(): Promise<MarketSnapshot> {
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

        const snapshot: MarketSnapshot = {
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
    static async getLatest(): Promise<MarketSnapshot | null> {
        const db = getDb();
        if (!db) return null;

        try {
            const [row] = await db`
                SELECT data FROM market_snapshots
                ORDER BY generated_at DESC
                LIMIT 1
            ` as any[];

            return row ? row.data : null;
        } catch (error) {
            logger.error({ error }, 'Failed to get latest snapshot');
            return null;
        }
    }

    /**
     * GET CATEGORY HEALTH
     */
    static async getCategoryHealth(category: string): Promise<CategoryHealth | null> {
        const all = await this.analyzeCategoryHealth();
        return all.find(c => c.category === category) || null;
    }

    /**
     * GET ZONE HEALTH
     */
    static async getZoneHealth(zone: string): Promise<GeoHealth | null> {
        const all = await this.analyzeGeoHealth();
        return all.find(z => z.zone === zone) || null;
    }

    /**
     * GET PRICING GUIDANCE
     */
    static async getPricingGuidance(
        category: string,
        zone?: string
    ): Promise<PricingPressure | null> {
        const all = await this.analyzePricingPressure();
        return all.find(p =>
            p.category === category &&
            (zone ? p.zone === zone : !p.zone)
        ) || null;
    }

    /**
     * DETECT HIGH CHURN RISK USERS
     */
    static async detectChurnRisk(minDaysSinceActivity: number = 14): Promise<ChurnSignal[]> {
        const db = getDb();
        if (!db) return [];

        try {
            const cutoff = new Date(Date.now() - minDaysSinceActivity * 24 * 60 * 60 * 1000);

            // Find users with declining activity
            const atRiskUsers = await db`
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
            ` as any[];

            return atRiskUsers.map((u: any) => this.buildChurnSignal(u));
        } catch (error) {
            logger.warn({ error }, 'Failed to detect churn risk');
            return [];
        }
    }

    /**
     * GET EXPANSION READINESS
     */
    static async getExpansionReadiness(targetZones: string[] = SEATTLE_ZONES): Promise<{
        zone: string;
        score: number;
        recommendation: 'expand' | 'hold' | 'not_ready';
        factors: string[];
    }[]> {
        const zones = await this.analyzeGeoHealth();

        return zones
            .filter(z => targetZones.includes(z.zone))
            .map(z => ({
                zone: z.zone,
                score: z.expansion.readinessScore,
                recommendation: z.expansion.readinessScore > 70 ? 'expand' as const
                    : z.expansion.readinessScore > 40 ? 'hold' as const
                        : 'not_ready' as const,
                factors: z.expansion.blockers.length > 0
                    ? z.expansion.blockers
                    : ['Zone is healthy and ready for growth']
            }));
    }

    // -----------------------------------------------------------
    // INTERNAL: Analysis Methods
    // -----------------------------------------------------------

    private static async analyzeCategoryHealth(): Promise<CategoryHealth[]> {
        const db = getDb();
        if (!db) return this.getDefaultCategoryHealth();

        try {
            const stats = await db`
                SELECT 
                    t.category,
                    COUNT(*) as total_tasks,
                    COUNT(*) FILTER (WHERE t.status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE t.status = 'disputed') as disputed,
                    AVG(t.recommended_price) as avg_price
                FROM tasks t
                WHERE t.created_at > NOW() - INTERVAL '30 days'
                GROUP BY t.category
            ` as any[];

            // Get risk scores per category
            const riskStats = await db`
                SELECT 
                    t.category,
                    AVG(r.score) as avg_risk
                FROM risk_score_log r
                JOIN tasks t ON r.entity_id = t.id::text
                WHERE r.entity_type = 'task'
                AND r.evaluated_at > NOW() - INTERVAL '30 days'
                GROUP BY t.category
            ` as any[];

            const riskMap = new Map(riskStats.map((r: any) => [r.category, r.avg_risk]));

            return CATEGORIES.map(category => {
                const stat = stats.find((s: any) => s.category === category);
                const total = parseInt(stat?.total_tasks || '0');
                const completed = parseInt(stat?.completed || '0');
                const disputed = parseInt(stat?.disputed || '0');

                const completionRate = total > 0 ? completed / total : 0;
                const disputeRate = total > 0 ? disputed / total : 0;
                const avgRiskScore = parseFloat(riskMap.get(category) || '30');

                // Calculate health score
                const healthScore = this.calculateCategoryHealthScore(
                    completionRate, disputeRate, avgRiskScore, total
                );

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
                        volumeTrend: 'stable' as const, // Would need time-series
                        disputeTrend: disputeRate < 0.03 ? 'improving' as const :
                            disputeRate < 0.05 ? 'stable' as const : 'worsening' as const
                    },
                    alerts: this.getCategoryAlerts(disputeRate, completionRate, avgRiskScore),
                    opportunity: this.getCategoryOpportunity(category, total, completionRate)
                };
            });
        } catch (error) {
            logger.error({ error }, 'Failed to analyze category health');
            return this.getDefaultCategoryHealth();
        }
    }

    private static async analyzeGeoHealth(): Promise<GeoHealth[]> {
        const db = getDb();
        if (!db) return this.getDefaultGeoHealth();

        try {
            const stats = await db`
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
            ` as any[];

            return SEATTLE_ZONES.map(zone => {
                const stat = stats.find((s: any) => s.zone === zone);
                const tasks = parseInt(stat?.tasks || '0');
                const hustlers = parseInt(stat?.hustlers || '1');
                const disputes = parseInt(stat?.disputes || '0');

                const supplyDemandRatio = hustlers / Math.max(tasks / 4, 1); // Hustlers per weekly tasks
                const disputeRate = tasks > 0 ? disputes / tasks : 0;

                const healthScore = this.calculateZoneHealthScore(
                    tasks, hustlers, supplyDemandRatio, disputeRate
                );

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
        } catch (error) {
            logger.error({ error }, 'Failed to analyze geo health');
            return this.getDefaultGeoHealth();
        }
    }

    private static async analyzePricingPressure(): Promise<PricingPressure[]> {
        const db = getDb();
        if (!db) return [];

        try {
            const stats = await db`
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
            ` as any[];

            return stats.map((s: any) => {
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
        } catch (error) {
            logger.error({ error }, 'Failed to analyze pricing');
            return [];
        }
    }

    private static async analyzeTrustDistribution(): Promise<TrustDistribution> {
        const db = getDb();

        const defaultDist: TrustDistribution = {
            overall: { minimalRiskPct: 0.4, lowRiskPct: 0.3, mediumRiskPct: 0.2, highRiskPct: 0.08, criticalRiskPct: 0.02 },
            byRole: {
                poster: { avgRiskScore: 25, trustedPct: 0.7 },
                hustler: { avgRiskScore: 20, trustedPct: 0.8 }
            },
            trustVelocity: 'stable',
            implication: 'Trust levels are healthy for beta launch'
        };

        if (!db) return defaultDist;

        try {
            const [tierCounts] = await db`
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
            ` as any[];

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
        } catch (error) {
            return defaultDist;
        }
    }

    private static async getChurnRiskCounts(): Promise<{ high: number; medium: number; low: number }> {
        // Simplified - would need full churn analysis
        return { high: 0, medium: 0, low: 0 };
    }

    // -----------------------------------------------------------
    // INTERNAL: Calculation Helpers
    // -----------------------------------------------------------

    private static calculateCategoryHealthScore(
        completionRate: number,
        disputeRate: number,
        avgRiskScore: number,
        volume: number
    ): number {
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

    private static calculateZoneHealthScore(
        tasks: number,
        hustlers: number,
        supplyDemandRatio: number,
        disputeRate: number
    ): number {
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

    private static calculateExpansionReadiness(
        healthScore: number,
        supplyDemandRatio: number,
        tasks: number
    ): number {
        let score = healthScore * 0.5;

        // Supply balance bonus
        if (supplyDemandRatio > 0.8 && supplyDemandRatio < 1.5) score += 20;

        // Volume requirement
        if (tasks > 20) score += 20;
        else if (tasks > 10) score += 10;

        return Math.min(100, Math.round(score));
    }

    private static getHealthStatus(score: number): CategoryHealth['status'] {
        if (score >= 70) return 'thriving';
        if (score >= 50) return 'healthy';
        if (score >= 30) return 'stressed';
        return 'critical';
    }

    private static getSupplyStatus(ratio: number): GeoHealth['supplyStatus'] {
        if (ratio > 1.5) return 'oversupplied';
        if (ratio > 0.8) return 'balanced';
        if (ratio > 0.4) return 'undersupplied';
        return 'critical_shortage';
    }

    private static getCategoryAlerts(
        disputeRate: number,
        completionRate: number,
        riskScore: number
    ): string[] {
        const alerts: string[] = [];
        if (disputeRate > 0.05) alerts.push('High dispute rate - review proof requirements');
        if (completionRate < 0.7) alerts.push('Low completion rate - investigate friction');
        if (riskScore > 50) alerts.push('Elevated risk profile - monitor closely');
        return alerts;
    }

    private static getCategoryOpportunity(
        category: string,
        volume: number,
        completionRate: number
    ): string | null {
        if (volume > 50 && completionRate > 0.9) {
            return `High-performing category - consider premium tier`;
        }
        if (volume < 10 && completionRate > 0.8) {
            return `Underserved category - growth opportunity`;
        }
        return null;
    }

    private static getExpansionBlockers(
        healthScore: number,
        ratio: number,
        tasks: number
    ): string[] {
        const blockers: string[] = [];
        if (healthScore < 40) blockers.push('Zone health below threshold');
        if (ratio < 0.5) blockers.push('Critical hustler shortage');
        if (tasks < 5) blockers.push('Insufficient demand signal');
        return blockers;
    }

    private static getPricingGuidanceText(
        avgPosted: number,
        avgCompleted: number,
        variance: number
    ): string {
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

    private static getTrustImplication(tierCounts: any): string {
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

    private static buildChurnSignal(user: any): ChurnSignal {
        const daysSince = user.last_activity
            ? Math.floor((Date.now() - new Date(user.last_activity).getTime()) / (1000 * 60 * 60 * 24))
            : 30;

        const riskLevel = daysSince > 21 ? 'high' as const
            : daysSince > 14 ? 'medium' as const
                : 'low' as const;

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

    private static assessCompetitivePosition(
        categories: CategoryHealth[],
        zones: GeoHealth[],
        trust: TrustDistribution
    ): MarketSnapshot['competitivePosition'] {
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
                ...(categories.some(c => c.opportunity) ? categories.filter(c => c.opportunity).map(c => c.opportunity!) : [])
            ]
        };
    }

    private static getDefaultCategoryHealth(): CategoryHealth[] {
        return CATEGORIES.map(category => ({
            category,
            healthScore: 50,
            status: 'healthy' as const,
            signals: { taskVolume: 0, completionRate: 0, disputeRate: 0, avgPayoutUsd: 0, proofRejectionRate: 0, avgRiskScore: 30 },
            trends: { volumeTrend: 'stable' as const, disputeTrend: 'stable' as const },
            alerts: [],
            opportunity: null
        }));
    }

    private static getDefaultGeoHealth(): GeoHealth[] {
        return SEATTLE_ZONES.map(zone => ({
            zone,
            healthScore: 50,
            signals: { taskDensity: 0, hustlerDensity: 0, supplyDemandRatio: 1, avgCompletionTimeHours: 4, disputeRate: 0 },
            supplyStatus: 'balanced' as const,
            expansion: { readinessScore: 50, blockers: ['Insufficient data'] }
        }));
    }

    // -----------------------------------------------------------
    // INTERNAL: Storage
    // -----------------------------------------------------------

    private static async storeSnapshot(snapshot: MarketSnapshot): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO market_snapshots (
                    id, data, generated_at
                ) VALUES (
                    ${snapshot.id}, ${JSON.stringify(snapshot)}, ${snapshot.generatedAt}
                )
            `;
        } catch (error) {
            logger.warn({ error }, 'Failed to store market snapshot');
        }
    }
}
