/**
 * STRATEGIC OUTPUT ENGINE (Phase 15B)
 * 
 * Dominance Layer - ASYMMETRIC MARKET ADVANTAGE
 * 
 * Purpose: Convert intelligence into non-destructive leverage.
 * 
 * Four Strategic Outputs:
 * 1. Poster Pricing Guidance - Help posters price correctly
 * 2. Hustler Opportunity Routing - Surface best opportunities
 * 3. Adaptive Trust Friction - UX-only friction adjustments
 * 4. Growth & Expansion Targeting - Ops-facing expansion intel
 * 
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies task/money state
 * - NO KERNEL: Never touches ledger/payout/disputes
 * - ADVISORY: All outputs are suggestions, not commands
 * - DETERMINISTIC: No AI in request path
 * - REVERSIBLE: Zero system risk
 */

import { serviceLogger } from '../utils/logger.js';
import { MarketSignalEngine, CategoryHealth, GeoHealth, PricingPressure, TrustDistribution } from '../control-plane/MarketSignalEngine.js';
import { RiskScoreService, RiskTier } from '../services/RiskScoreService.js';

const logger = serviceLogger.child({ module: 'StrategicOutput' });

// ============================================================
// OUTPUT TYPES
// ============================================================

export interface PricingGuidanceOutput {
    category: string;
    zone?: string;

    // Market context
    marketRate: {
        min: number;
        median: number;
        max: number;
        suggested: number;
    };

    // Actionable guidance
    guidance: {
        message: string;
        confidence: 'high' | 'medium' | 'low';
        dataPoints: number;
    };

    // Risk awareness
    riskSignals: {
        underpricedRisk: string | null;    // "Pricing 20% below median increases dispute risk"
        overpricedRisk: string | null;     // "Pricing 30% above median reduces acceptance"
        categoryNote: string | null;        // Category-specific guidance
    };

    // Why this matters
    competitiveAdvantage: string;
}

export interface HustlerOpportunityOutput {
    userId: string;
    zone: string;

    // Opportunity signals
    opportunities: {
        category: string;
        opportunityScore: number;     // 0-100
        reason: string;
        avgPayout: number;
        completionRate: number;
        disputeRate: number;
    }[];

    // Zone context
    zoneHealth: {
        status: string;
        demand: 'high' | 'medium' | 'low';
        avgCompletionTime: string;
    };

    // Retention signal
    retentionAdvice: string | null;

    competitiveAdvantage: string;
}

export interface TrustFrictionOutput {
    taskId: string;

    // Risk context
    riskProfile: {
        taskRisk: number;
        posterRisk: number;
        hustlerRisk: number | null;
        combinedRisk: number;
        tier: RiskTier;
    };

    // Recommended friction (UX only - NO payout blocking)
    recommendedFriction: {
        proofTiming: 'before_completion' | 'after_completion' | 'not_required';
        confirmationStep: boolean;
        visibilityDelay: number;      // Minutes before visible to all
        taskSizeLimit?: number;       // Suggested max value for high-risk
        additionalInstructions: string[];
    };

    // Explanation (for transparency)
    explanation: {
        whyThisFriction: string;
        userFacingMessage: string;
        internalNote: string;
    };

    // What this explicitly CANNOT do
    constraints: {
        cannotBlockPayout: true;
        cannotModifyLedger: true;
        cannotTriggerKillSwitch: true;
        isAdvisoryOnly: true;
    };
}

export interface GrowthTargetOutput {
    // Zone-level recommendations
    zones: {
        zone: string;
        recommendation: 'expand' | 'hold' | 'reduce_spend' | 'monitor';
        priority: number;            // 1-10
        signals: {
            healthScore: number;
            supplyStatus: string;
            demandTrend: string;
            disputeRisk: string;
        };
        action: string;              // Specific recommended action
        blockers: string[];
    }[];

    // Category-level opportunities
    categoryOpportunities: {
        category: string;
        opportunity: string;
        zones: string[];             // Where this opportunity exists
        investmentRecommendation: 'high' | 'medium' | 'low' | 'avoid';
    }[];

    // Overall market position
    marketPosition: {
        strengths: string[];
        weaknesses: string[];
        nextMoves: string[];
    };

    competitiveAdvantage: string;
}

// ============================================================
// STRATEGIC OUTPUT ENGINE
// ============================================================

export class StrategicOutputEngine {

    /**
     * 1. POSTER PRICING GUIDANCE
     * 
     * Why it outperforms competitors:
     * - Competitors give static price suggestions
     * - We give zone-aware, risk-adjusted, data-backed guidance
     * 
     * Failure mode prevented:
     * - Underpricing → disputes → churn
     * - Overpricing → low acceptance → poster frustration
     */
    static async getPricingGuidance(
        category: string,
        zone?: string
    ): Promise<PricingGuidanceOutput> {
        // Get market data
        const pricing = await MarketSignalEngine.getPricingGuidance(category, zone);
        const categoryHealth = await MarketSignalEngine.getCategoryHealth(category);

        const marketRate = pricing?.marketRate || {
            min: 25, median: 50, max: 100, suggested: 55
        };

        // Determine confidence based on data availability
        const dataPoints = categoryHealth?.signals.taskVolume || 0;
        const confidence: 'high' | 'medium' | 'low' =
            dataPoints > 50 ? 'high' : dataPoints > 20 ? 'medium' : 'low';

        // Build guidance message
        const zoneText = zone ? ` in ${zone}` : '';
        const message = `Tasks like this complete fastest at $${marketRate.suggested - 5}–$${marketRate.suggested + 5}${zoneText}`;

        // Risk signals
        const disputeMultiplier = pricing && pricing.signals.underpricedPct > 0.3
            ? (1 + pricing.signals.underpricedPct).toFixed(1)
            : null;

        return {
            category,
            zone,
            marketRate,
            guidance: {
                message,
                confidence,
                dataPoints
            },
            riskSignals: {
                underpricedRisk: disputeMultiplier
                    ? `Pricing below market increases dispute risk by ${disputeMultiplier}×`
                    : null,
                overpricedRisk: pricing && pricing.signals.overpricedPct > 0.2
                    ? `Pricing 30%+ above median reduces acceptance rate`
                    : null,
                categoryNote: categoryHealth?.alerts[0] || null
            },
            competitiveAdvantage: 'Zone-aware pricing guidance based on actual completion data and dispute patterns'
        };
    }

    /**
     * 2. HUSTLER OPPORTUNITY ROUTING
     * 
     * Why it outperforms competitors:
     * - Competitors show all tasks equally
     * - We surface high-quality, low-dispute opportunities
     * 
     * Failure mode prevented:
     * - Hustlers take bad tasks → disputes → churn
     * - Hustlers miss good opportunities → lower earnings → churn
     */
    static async getHustlerOpportunities(
        userId: string,
        zone: string
    ): Promise<HustlerOpportunityOutput> {
        // Get zone health
        const zoneHealth = await MarketSignalEngine.getZoneHealth(zone);

        // Get all category health to rank opportunities
        const snapshot = await MarketSignalEngine.getLatest();
        const categories = snapshot?.categories || [];

        // Rank opportunities by health score + low dispute rate
        const opportunities = categories
            .filter(c => c.healthScore > 40) // Only healthy categories
            .sort((a, b) => {
                // Prioritize: high completion, low disputes
                const scoreA = a.signals.completionRate * 100 - a.signals.disputeRate * 200;
                const scoreB = b.signals.completionRate * 100 - b.signals.disputeRate * 200;
                return scoreB - scoreA;
            })
            .slice(0, 5) // Top 5
            .map(c => ({
                category: c.category,
                opportunityScore: Math.round(c.healthScore),
                reason: this.getOpportunityReason(c),
                avgPayout: c.signals.avgPayoutUsd,
                completionRate: c.signals.completionRate,
                disputeRate: c.signals.disputeRate
            }));

        // Zone context
        const demand = zoneHealth
            ? zoneHealth.supplyStatus === 'undersupplied' || zoneHealth.supplyStatus === 'critical_shortage'
                ? 'high'
                : zoneHealth.supplyStatus === 'balanced' ? 'medium' : 'low'
            : 'medium';

        return {
            userId,
            zone,
            opportunities,
            zoneHealth: {
                status: zoneHealth?.supplyStatus || 'balanced',
                demand,
                avgCompletionTime: `${zoneHealth?.signals.avgCompletionTimeHours.toFixed(1) || '4'}h avg`
            },
            retentionAdvice: demand === 'high'
                ? 'High demand in your area - more tasks available than hustlers'
                : null,
            competitiveAdvantage: 'Opportunity routing based on completion rates and dispute patterns competitors cannot see'
        };
    }

    /**
     * 3. ADAPTIVE TRUST FRICTION
     * 
     * Why it outperforms competitors:
     * - Competitors apply same friction to everyone
     * - We apply risk-proportional friction
     * 
     * Failure mode prevented:
     * - Low-risk users frustrated by unnecessary friction
     * - High-risk scenarios slip through without checks
     * 
     * CRITICAL: This is UX-only. Cannot block payouts.
     */
    static async getTrustFriction(
        taskId: string,
        category: string,
        price: number,
        posterId: string,
        hustlerId?: string
    ): Promise<TrustFrictionOutput> {
        // Get risk assessment
        const assessment = await RiskScoreService.assessFullRisk({
            taskId,
            category,
            price,
            posterId,
            hustlerId,
            isFirstTimeMatch: true
        });

        // Determine friction based on risk
        const friction = this.calculateFriction(assessment.combinedRisk.tier, price);

        // Build explanation
        const explanation = this.explainFriction(
            assessment.combinedRisk.tier,
            assessment.combinedRisk.score,
            friction
        );

        return {
            taskId,
            riskProfile: {
                taskRisk: assessment.taskRisk.score,
                posterRisk: assessment.posterRisk.score,
                hustlerRisk: assessment.hustlerRisk?.score || null,
                combinedRisk: assessment.combinedRisk.score,
                tier: assessment.combinedRisk.tier
            },
            recommendedFriction: friction,
            explanation,
            constraints: {
                cannotBlockPayout: true,
                cannotModifyLedger: true,
                cannotTriggerKillSwitch: true,
                isAdvisoryOnly: true
            }
        };
    }

    /**
     * 4. GROWTH & EXPANSION TARGETING
     * 
     * Why it outperforms competitors:
     * - Competitors expand by gut feel
     * - We expand by supply/demand data + health metrics
     * 
     * Failure mode prevented:
     * - Expanding into zones without hustler supply
     * - Ignoring high-potential zones
     */
    static async getGrowthTargets(): Promise<GrowthTargetOutput> {
        const snapshot = await MarketSignalEngine.getLatest();

        if (!snapshot) {
            return this.getDefaultGrowthTargets();
        }

        // Rank zones by expansion readiness
        const zones = snapshot.zones
            .map(z => ({
                zone: z.zone,
                recommendation: this.getZoneRecommendation(z),
                priority: this.calculateZonePriority(z),
                signals: {
                    healthScore: z.healthScore,
                    supplyStatus: z.supplyStatus,
                    demandTrend: z.signals.taskDensity > 10 ? 'growing' : 'stable',
                    disputeRisk: z.signals.disputeRate > 0.05 ? 'elevated' : 'normal'
                },
                action: this.getZoneAction(z),
                blockers: z.expansion.blockers
            }))
            .sort((a, b) => b.priority - a.priority);

        // Category opportunities
        const categoryOpportunities = snapshot.categories
            .filter(c => c.opportunity)
            .map(c => ({
                category: c.category,
                opportunity: c.opportunity!,
                zones: snapshot.zones
                    .filter(z => z.healthScore > 50)
                    .map(z => z.zone)
                    .slice(0, 3),
                investmentRecommendation: this.getCategoryInvestment(c) as 'high' | 'medium' | 'low' | 'avoid'
            }));

        return {
            zones,
            categoryOpportunities,
            marketPosition: {
                strengths: snapshot.competitivePosition.strengths,
                weaknesses: snapshot.competitivePosition.weaknesses,
                nextMoves: this.getNextMoves(zones, categoryOpportunities)
            },
            competitiveAdvantage: 'Data-driven expansion based on supply/demand signals and health metrics'
        };
    }

    // -----------------------------------------------------------
    // INTERNAL: Calculation Helpers
    // -----------------------------------------------------------

    private static getOpportunityReason(category: CategoryHealth): string {
        if (category.signals.completionRate > 0.9) {
            return `${Math.round(category.signals.completionRate * 100)}% completion rate`;
        }
        if (category.signals.disputeRate < 0.02) {
            return 'Very low dispute rate';
        }
        if (category.signals.avgPayoutUsd > 75) {
            return `Higher payouts (avg $${category.signals.avgPayoutUsd.toFixed(0)})`;
        }
        return 'Healthy category with consistent demand';
    }

    private static calculateFriction(
        tier: RiskTier,
        price: number
    ): TrustFrictionOutput['recommendedFriction'] {
        // UX friction matrix - NO payout blocking
        const frictionMap: Record<RiskTier, TrustFrictionOutput['recommendedFriction']> = {
            minimal: {
                proofTiming: 'not_required',
                confirmationStep: false,
                visibilityDelay: 0,
                additionalInstructions: []
            },
            low: {
                proofTiming: 'after_completion',
                confirmationStep: false,
                visibilityDelay: 0,
                additionalInstructions: []
            },
            medium: {
                proofTiming: 'after_completion',
                confirmationStep: true,
                visibilityDelay: 5,
                additionalInstructions: [
                    'Take a clear photo of completed work'
                ]
            },
            high: {
                proofTiming: 'before_completion',
                confirmationStep: true,
                visibilityDelay: 15,
                taskSizeLimit: price > 150 ? 150 : undefined,
                additionalInstructions: [
                    'Capture before/after photos',
                    'Include timestamp in photo'
                ]
            },
            critical: {
                proofTiming: 'before_completion',
                confirmationStep: true,
                visibilityDelay: 30,
                taskSizeLimit: 100,
                additionalInstructions: [
                    'Capture before/after photos with timestamp',
                    'Include GPS location if possible',
                    'Wait for poster confirmation before completing'
                ]
            }
        };

        return frictionMap[tier];
    }

    private static explainFriction(
        tier: RiskTier,
        score: number,
        friction: TrustFrictionOutput['recommendedFriction']
    ): TrustFrictionOutput['explanation'] {
        const explanations: Record<RiskTier, { why: string; user: string }> = {
            minimal: {
                why: 'Minimal risk profile - reduce friction to improve experience',
                user: 'You have a great track record! Simplified verification.'
            },
            low: {
                why: 'Low risk - standard verification sufficient',
                user: 'Standard task flow applies.'
            },
            medium: {
                why: 'Medium risk signals - add confirmation step for protection',
                user: 'Please confirm task details before starting.'
            },
            high: {
                why: 'Elevated risk factors - increase verification to protect both parties',
                user: 'This task requires additional verification for your protection.'
            },
            critical: {
                why: 'Critical risk indicators - maximum verification without blocking',
                user: 'Enhanced verification required. This helps ensure smooth completion.'
            }
        };

        return {
            whyThisFriction: explanations[tier].why,
            userFacingMessage: explanations[tier].user,
            internalNote: `Risk score: ${score}. Friction level: ${tier}. Advisory only - cannot block payouts.`
        };
    }

    private static getZoneRecommendation(zone: GeoHealth): 'expand' | 'hold' | 'reduce_spend' | 'monitor' {
        if (zone.expansion.readinessScore > 70 && zone.supplyStatus === 'balanced') return 'expand';
        if (zone.healthScore < 40) return 'reduce_spend';
        if (zone.supplyStatus === 'critical_shortage') return 'hold';
        return 'monitor';
    }

    private static calculateZonePriority(zone: GeoHealth): number {
        let priority = zone.healthScore / 10; // 0-10 base

        // Boost for expansion readiness
        if (zone.expansion.readinessScore > 70) priority += 2;

        // Boost for supply balance
        if (zone.supplyStatus === 'balanced') priority += 1;

        // Penalty for disputes
        if (zone.signals.disputeRate > 0.05) priority -= 2;

        return Math.max(1, Math.min(10, Math.round(priority)));
    }

    private static getZoneAction(zone: GeoHealth): string {
        if (zone.supplyStatus === 'critical_shortage') {
            return 'Recruit more hustlers before expanding marketing';
        }
        if (zone.expansion.readinessScore > 70) {
            return 'Ready for poster acquisition campaigns';
        }
        if (zone.healthScore < 40) {
            return 'Pause spend and investigate dispute patterns';
        }
        return 'Maintain current investment level';
    }

    private static getCategoryInvestment(category: CategoryHealth): string {
        if (category.healthScore > 70 && category.signals.taskVolume > 30) return 'high';
        if (category.healthScore > 50) return 'medium';
        if (category.signals.disputeRate > 0.05) return 'avoid';
        return 'low';
    }

    private static getNextMoves(
        zones: GrowthTargetOutput['zones'],
        categoryOpps: GrowthTargetOutput['categoryOpportunities']
    ): string[] {
        const moves: string[] = [];

        // Top zone recommendation
        const topZone = zones.find(z => z.recommendation === 'expand');
        if (topZone) {
            moves.push(`Expand marketing in ${topZone.zone} (priority ${topZone.priority}/10)`);
        }

        // Top category opportunity
        const topCategory = categoryOpps.find(c => c.investmentRecommendation === 'high');
        if (topCategory) {
            moves.push(`Invest in ${topCategory.category}: ${topCategory.opportunity}`);
        }

        // Supply concern
        const shortageZone = zones.find(z => z.signals.supplyStatus === 'critical_shortage');
        if (shortageZone) {
            moves.push(`Address hustler shortage in ${shortageZone.zone}`);
        }

        return moves.length > 0 ? moves : ['Maintain current operations - no urgent actions'];
    }

    private static getDefaultGrowthTargets(): GrowthTargetOutput {
        return {
            zones: [],
            categoryOpportunities: [],
            marketPosition: {
                strengths: ['Insufficient data'],
                weaknesses: ['Need more market snapshots'],
                nextMoves: ['Generate market snapshot first']
            },
            competitiveAdvantage: 'Data-driven expansion based on supply/demand signals and health metrics'
        };
    }
}
