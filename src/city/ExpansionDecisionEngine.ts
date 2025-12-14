/**
 * EXPANSION DECISION ENGINE (Phase 16 - Component 5)
 * 
 * Purpose: Determine where to push, hold, or retreat.
 * 
 * Answers:
 * - Where to push marketing
 * - Where NOT to expand
 * - Where to slow growth
 * 
 * CONSTRAINTS:
 * - READ-ONLY: Intelligence only
 * - NO AUTOMATION: Human operators decide
 * - NO KERNEL: Financial layer frozen
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { DefensibilityScoreService, CityDefensibility, ZoneDefensibility } from './DefensibilityScoreService.js';
import { LiquidityHeatEngine, LiquidityHeatSnapshot } from './LiquidityHeatEngine.js';
import { CityGridService } from './CityGridService.js';

const logger = serviceLogger.child({ module: 'ExpansionDecision' });

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

export type ExpansionAction = 'expand' | 'hold' | 'retreat' | 'fortify';

export interface ZoneExpansionDecision {
    zone: string;
    action: ExpansionAction;
    confidence: number;           // 0-100

    // Reasoning
    reasoning: {
        primaryFactor: string;
        supportingFactors: string[];
        risks: string[];
        opportunities: string[];
    };

    // Inputs that drove this decision
    signals: {
        defensibility: number;
        liquidityHeat: number;
        supplyDemandRatio: number;
        churnRisk: number;
        competitionLevel: 'low' | 'medium' | 'high';
    };

    // Actions
    recommendedActions: string[];
    budgetRecommendation: 'increase' | 'maintain' | 'reduce' | 'pause';
}

export interface CityExpansionPlan {
    id: string;
    city: string;
    generatedAt: Date;

    decisions: ZoneExpansionDecision[];

    // City-level strategy
    strategy: {
        phase: 'launch' | 'growth' | 'consolidation' | 'defense';
        primaryFocus: string;
        weeklyBudgetAllocation: Record<string, number>;  // Zone -> % of budget
    };

    // Summary
    summary: {
        expandZones: string[];
        holdZones: string[];
        retreatZones: string[];
        fortifyZones: string[];
    };

    // Key metrics
    metrics: {
        totalZones: number;
        avgDefensibility: number;
        avgLiquidity: number;
        projectedGrowth: string;
    };
}

// ============================================================
// EXPANSION DECISION ENGINE
// ============================================================

export class ExpansionDecisionEngine {

    /**
     * GET EXPANSION PLAN FOR CITY
     */
    static async getExpansionPlan(city: string): Promise<CityExpansionPlan> {
        const id = ulid();

        // Gather intelligence
        const [defensibility, heat, grid] = await Promise.all([
            DefensibilityScoreService.getCityDefensibility(city),
            LiquidityHeatEngine.getLatest(city) || LiquidityHeatEngine.generateSnapshot(city),
            CityGridService.getGrid(city)
        ]);

        // Generate decisions for each zone
        const decisions = defensibility.zones.map(zone =>
            this.generateZoneDecision(zone, heat, grid)
        );

        // Determine city-level strategy
        const strategy = this.determineStrategy(decisions, defensibility);

        // Build summary
        const summary = {
            expandZones: decisions.filter(d => d.action === 'expand').map(d => d.zone),
            holdZones: decisions.filter(d => d.action === 'hold').map(d => d.zone),
            retreatZones: decisions.filter(d => d.action === 'retreat').map(d => d.zone),
            fortifyZones: decisions.filter(d => d.action === 'fortify').map(d => d.zone)
        };

        // Metrics
        const avgDef = Math.round(
            decisions.reduce((sum, d) => sum + d.signals.defensibility, 0) / decisions.length
        );
        const avgLiq = Math.round(
            decisions.reduce((sum, d) => sum + d.signals.liquidityHeat, 0) / decisions.length
        );

        const plan: CityExpansionPlan = {
            id,
            city,
            generatedAt: new Date(),
            decisions,
            strategy,
            summary,
            metrics: {
                totalZones: decisions.length,
                avgDefensibility: avgDef,
                avgLiquidity: avgLiq,
                projectedGrowth: this.projectGrowth(summary)
            }
        };

        // Persist
        await this.persistPlan(plan);

        logger.info({
            city,
            expand: summary.expandZones.length,
            hold: summary.holdZones.length,
            retreat: summary.retreatZones.length,
            fortify: summary.fortifyZones.length
        }, 'Expansion plan generated');

        return plan;
    }

    /**
     * GET ZONE DECISION DETAIL
     */
    static async getZoneDecision(zone: string): Promise<ZoneExpansionDecision> {
        const city = 'seattle';

        const [defensibility, heat, grid] = await Promise.all([
            DefensibilityScoreService.getZoneDefensibility(zone),
            LiquidityHeatEngine.getLatest(city),
            CityGridService.getGrid(city)
        ]);

        return this.generateZoneDecision(defensibility, heat, grid);
    }

    /**
     * GET PRIORITY ACTIONS
     */
    static async getPriorityActions(city: string): Promise<{
        immediate: { zone: string; action: string; reason: string }[];
        thisWeek: { zone: string; action: string; reason: string }[];
        monitor: { zone: string; action: string; reason: string }[];
    }> {
        const plan = await this.getExpansionPlan(city);

        const immediate = plan.decisions
            .filter(d => d.action === 'retreat' || (d.action === 'fortify' && d.confidence > 70))
            .map(d => ({
                zone: d.zone,
                action: d.recommendedActions[0] || d.action,
                reason: d.reasoning.primaryFactor
            }));

        const thisWeek = plan.decisions
            .filter(d => d.action === 'expand' && d.confidence > 60)
            .map(d => ({
                zone: d.zone,
                action: d.recommendedActions[0] || 'Increase marketing',
                reason: d.reasoning.primaryFactor
            }));

        const monitor = plan.decisions
            .filter(d => d.action === 'hold' || d.confidence < 50)
            .slice(0, 5)
            .map(d => ({
                zone: d.zone,
                action: 'Monitor weekly',
                reason: d.reasoning.risks[0] || 'Uncertain conditions'
            }));

        return { immediate, thisWeek, monitor };
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static generateZoneDecision(
        zone: ZoneDefensibility,
        heat: LiquidityHeatSnapshot | null,
        grid: any
    ): ZoneExpansionDecision {
        // Get zone heat
        const zoneHeat = heat?.cells.find(c => c.zone === zone.zone);
        const heatScore = zoneHeat?.heatScore || 50;

        // Get zone grid data
        const gridCells = grid.cells.filter((c: any) => c.zone === zone.zone);
        const avgSupply = gridCells.reduce((sum: number, c: any) => sum + c.supplyIndex, 0) / gridCells.length;
        const avgDemand = gridCells.reduce((sum: number, c: any) => sum + c.demandIndex, 0) / gridCells.length;
        const supplyDemandRatio = avgDemand > 0 ? avgSupply / avgDemand : 1;
        const churnRisk = gridCells.reduce((sum: number, c: any) => sum + c.churnRisk, 0) / gridCells.length;

        // Determine action
        const { action, confidence, reasoning } = this.decideAction(
            zone, heatScore, supplyDemandRatio, churnRisk
        );

        // Competition level
        const competitionLevel = zone.defensibilityScore > 60 ? 'low' as const
            : zone.defensibilityScore > 40 ? 'medium' as const
                : 'high' as const;

        // Recommended actions
        const recommendedActions = this.getRecommendedActions(action, zone, supplyDemandRatio);

        // Budget recommendation
        const budgetRecommendation = this.getBudgetRecommendation(action, confidence);

        return {
            zone: zone.zone,
            action,
            confidence,
            reasoning,
            signals: {
                defensibility: zone.defensibilityScore,
                liquidityHeat: heatScore,
                supplyDemandRatio: Math.round(supplyDemandRatio * 100) / 100,
                churnRisk: Math.round(churnRisk),
                competitionLevel
            },
            recommendedActions,
            budgetRecommendation
        };
    }

    private static decideAction(
        zone: ZoneDefensibility,
        heat: number,
        supplyDemand: number,
        churn: number
    ): { action: ExpansionAction; confidence: number; reasoning: ZoneExpansionDecision['reasoning'] } {
        let action: ExpansionAction;
        let confidence = 50;
        let primaryFactor: string;
        const supportingFactors: string[] = [];
        const risks: string[] = [];
        const opportunities: string[] = [];

        // Decision logic
        if (zone.classification === 'locked') {
            action = 'fortify';
            primaryFactor = 'Zone is locked - protect the moat';
            confidence = 85;
            supportingFactors.push('High defensibility score', 'Strong repeat rate');

        } else if (zone.classification === 'dominant') {
            if (heat > 60 && supplyDemand > 0.8) {
                action = 'expand';
                primaryFactor = 'Dominant with growth opportunity';
                confidence = 70;
                opportunities.push('Strong demand', 'Good supply balance');
            } else {
                action = 'fortify';
                primaryFactor = 'Dominant but needs supply-side work';
                confidence = 65;
                supportingFactors.push('Need to improve supply before expanding');
            }

        } else if (zone.classification === 'contestable') {
            if (churn > 50 || zone.vulnerabilities.length > 2) {
                action = 'hold';
                primaryFactor = 'Contestable with high risk factors';
                confidence = 60;
                risks.push(...zone.vulnerabilities.slice(0, 2));
            } else {
                action = 'expand';
                primaryFactor = 'Contestable with expansion potential';
                confidence = 55;
                opportunities.push('Market share available', 'Competition not entrenched');
                risks.push('May attract competitor response');
            }

        } else {
            // Fragile
            if (heat < 30 && supplyDemand < 0.5) {
                action = 'retreat';
                primaryFactor = 'Fragile with poor fundamentals';
                confidence = 75;
                risks.push('Low demand', 'Poor supply ratio', 'High cost of defense');
            } else {
                action = 'hold';
                primaryFactor = 'Fragile but showing potential';
                confidence = 50;
                opportunities.push('May improve with time');
                risks.push('High competition risk');
            }
        }

        return {
            action,
            confidence,
            reasoning: { primaryFactor, supportingFactors, risks, opportunities }
        };
    }

    private static getRecommendedActions(
        action: ExpansionAction,
        zone: ZoneDefensibility,
        supplyDemand: number
    ): string[] {
        const actions: string[] = [];

        switch (action) {
            case 'expand':
                actions.push('Increase poster acquisition marketing');
                if (supplyDemand < 0.8) {
                    actions.push('Run hustler recruitment campaign');
                }
                actions.push('Consider promotional pricing');
                break;

            case 'hold':
                actions.push('Maintain current marketing spend');
                actions.push('Focus on user retention');
                actions.push('Monitor weekly metrics');
                break;

            case 'retreat':
                actions.push('Pause new user acquisition');
                actions.push('Reduce marketing spend by 50%');
                actions.push('Focus on existing user experience');
                break;

            case 'fortify':
                actions.push('Invest in user retention');
                if (zone.vulnerabilities.length > 0) {
                    actions.push(`Address: ${zone.vulnerabilities[0]}`);
                }
                actions.push('Build trust network density');
                break;
        }

        return actions;
    }

    private static getBudgetRecommendation(
        action: ExpansionAction,
        confidence: number
    ): ZoneExpansionDecision['budgetRecommendation'] {
        if (action === 'retreat') return 'pause';
        if (action === 'expand' && confidence > 60) return 'increase';
        if (action === 'fortify') return 'maintain';
        return 'maintain';
    }

    private static determineStrategy(
        decisions: ZoneExpansionDecision[],
        defensibility: CityDefensibility
    ): CityExpansionPlan['strategy'] {
        const expandCount = decisions.filter(d => d.action === 'expand').length;
        const fortifyCount = decisions.filter(d => d.action === 'fortify').length;
        const retreatCount = decisions.filter(d => d.action === 'retreat').length;
        const total = decisions.length;

        let phase: 'launch' | 'growth' | 'consolidation' | 'defense';
        let primaryFocus: string;

        if (defensibility.cityScore < 40) {
            phase = 'launch';
            primaryFocus = 'Establish presence in high-potential zones';
        } else if (expandCount > total * 0.3 && retreatCount < total * 0.1) {
            phase = 'growth';
            primaryFocus = 'Aggressive expansion in strong zones';
        } else if (fortifyCount > total * 0.4) {
            phase = 'consolidation';
            primaryFocus = 'Lock existing zones before expanding';
        } else {
            phase = 'defense';
            primaryFocus = 'Protect market share from competition';
        }

        // Budget allocation
        const budgetAllocation: Record<string, number> = {};
        const totalWeight = decisions.reduce((sum, d) => {
            const weight = d.action === 'expand' ? 30 : d.action === 'fortify' ? 20 : d.action === 'hold' ? 5 : 0;
            return sum + weight;
        }, 0);

        for (const d of decisions) {
            const weight = d.action === 'expand' ? 30 : d.action === 'fortify' ? 20 : d.action === 'hold' ? 5 : 0;
            budgetAllocation[d.zone] = Math.round((weight / totalWeight) * 100);
        }

        return { phase, primaryFocus, weeklyBudgetAllocation: budgetAllocation };
    }

    private static projectGrowth(summary: CityExpansionPlan['summary']): string {
        const expandRatio = summary.expandZones.length /
            (summary.expandZones.length + summary.holdZones.length + summary.retreatZones.length + summary.fortifyZones.length);

        if (expandRatio > 0.4) return '+15-25% MoM projected';
        if (expandRatio > 0.2) return '+5-15% MoM projected';
        if (summary.retreatZones.length > 2) return 'Flat to -5% MoM projected';
        return '+0-5% MoM projected';
    }

    private static async persistPlan(plan: CityExpansionPlan): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO expansion_plans (
                    id, city, phase, data, generated_at
                ) VALUES (
                    ${plan.id}, ${plan.city}, ${plan.strategy.phase},
                    ${JSON.stringify(plan)}, ${plan.generatedAt}
                )
            `;
        } catch (error) {
            logger.warn({ error }, 'Failed to persist expansion plan');
        }
    }
}
