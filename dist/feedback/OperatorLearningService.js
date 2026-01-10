/**
 * OPERATOR LEARNING SERVICE (Phase 15C-1 - Flywheel 4)
 *
 * Purpose: Learn where AI vs humans perform better.
 *
 * This service:
 * - Tracks AI recommendations vs human decisions
 * - Measures agreement/disagreement rates
 * - Identifies where humans outperform AI
 * - Identifies where AI outperforms humans
 *
 * CONSTRAINTS:
 * - READ-ONLY analysis
 * - APPEND-ONLY persistence
 * - NO auto-execution
 * - All insights are advisory
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
const logger = serviceLogger.child({ module: 'OperatorLearning' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// OPERATOR LEARNING SERVICE
// ============================================================
export class OperatorLearningService {
    /**
     * RECORD DECISION
     * Called when operator makes a decision on AI recommendation
     */
    static async recordDecision(params) {
        const { eventType, entityId, operatorId, aiAction, aiConfidence, aiReasoning, humanAction, humanReasoning } = params;
        // Determine agreement
        const agreement = this.calculateAgreement(aiAction, humanAction);
        const event = {
            id: ulid(),
            eventType,
            entityId,
            operatorId,
            aiRecommendation: {
                action: aiAction,
                confidence: aiConfidence,
                reasoning: aiReasoning
            },
            humanDecision: {
                action: humanAction,
                reasoning: humanReasoning
            },
            agreement,
            createdAt: new Date()
        };
        // Persist
        await this.persistEvent(event);
        // Emit metric (log for now - would integrate with metrics system)
        logger.info({
            eventType,
            agreement,
            aiConfidence
        });
        logger.info({
            eventType, entityId, agreement
        }, 'Operator decision recorded');
        return event;
    }
    /**
     * RECORD OUTCOME
     * Called when we know the result of a decision
     */
    static async recordOutcome(params) {
        const db = getDb();
        if (!db)
            return;
        try {
            const [existing] = await db `
                SELECT data FROM operator_learning_events WHERE id = ${params.eventId}
            `;
            if (!existing)
                return;
            const event = existing.data;
            // Determine who was right
            const whoWasRight = this.determineWhoWasRight(event, params.result);
            event.outcome = {
                result: params.result,
                metric: params.metric,
                whoWasRight
            };
            await db `
                UPDATE operator_learning_events 
                SET data = ${JSON.stringify(event)}
                WHERE id = ${params.eventId}
            `;
            // Emit learning metric
            logger.info({
                eventType: event.eventType,
                agreement: event.agreement,
                whoWasRight,
                result: params.result
            });
        }
        catch (error) {
            logger.error({ error, eventId: params.eventId }, 'Failed to record outcome');
        }
    }
    /**
     * GET LEARNING SUMMARY
     */
    static async getSummary(days = 30) {
        const db = getDb();
        const defaultSummary = {
            periodDays: days,
            agreement: {
                fullAgreementRate: 0,
                partialAgreementRate: 0,
                disagreementRate: 0,
                totalDecisions: 0
            },
            accuracy: {
                aiCorrectRate: 0,
                humanCorrectRate: 0,
                unclearRate: 0,
                decisionsWithOutcome: 0
            },
            patterns: {
                aiStrengths: ['Insufficient data'],
                humanStrengths: ['Insufficient data'],
                recommendations: ['Record more decisions to see patterns']
            },
            byEventType: {}
        };
        if (!db)
            return defaultSummary;
        try {
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            const rows = await db `
                SELECT data FROM operator_learning_events 
                WHERE created_at >= ${since}
                ORDER BY created_at DESC
            `;
            if (rows.length === 0)
                return defaultSummary;
            const events = rows.map((r) => r.data);
            // Calculate agreement
            const agreement = this.calculateAgreementStats(events);
            // Calculate accuracy
            const accuracy = this.calculateAccuracyStats(events);
            // Identify patterns
            const patterns = this.identifyPatterns(events);
            // Group by event type
            const byEventType = this.groupByEventType(events);
            return {
                periodDays: days,
                agreement,
                accuracy,
                patterns,
                byEventType
            };
        }
        catch (error) {
            logger.error({ error }, 'Failed to get learning summary');
            return defaultSummary;
        }
    }
    /**
     * GET RECOMMENDATIONS FOR IMPROVEMENT
     */
    static async getImprovementRecommendations() {
        const summary = await this.getSummary(30);
        const forAI = [];
        const forOperators = [];
        // Check if humans are frequently overriding and being right
        if (summary.accuracy.humanCorrectRate > summary.accuracy.aiCorrectRate + 0.1) {
            forAI.push('Human operators outperforming AI - consider retraining models');
        }
        // Check if AI is being ignored when it's right
        if (summary.agreement.disagreementRate > 0.3 && summary.accuracy.aiCorrectRate > 0.6) {
            forOperators.push('AI recommendations are being rejected but often correct - review override criteria');
        }
        // Check event-specific patterns
        for (const [eventType, stats] of Object.entries(summary.byEventType)) {
            if (stats.aiAccuracy > 0.8 && stats.agreementRate < 0.5) {
                forOperators.push(`For ${eventType}: AI accuracy is ${(stats.aiAccuracy * 100).toFixed(0)}% - consider trusting AI more`);
            }
            if (stats.aiAccuracy < 0.4) {
                forAI.push(`For ${eventType}: AI accuracy is only ${(stats.aiAccuracy * 100).toFixed(0)}% - needs improvement`);
            }
        }
        const calibrationNeeded = summary.agreement.disagreementRate > 0.4 ||
            Math.abs(summary.accuracy.aiCorrectRate - summary.accuracy.humanCorrectRate) > 0.2;
        if (forAI.length === 0)
            forAI.push('AI performance is within expected range');
        if (forOperators.length === 0)
            forOperators.push('Operator decisions are well-calibrated');
        return { forAI, forOperators, calibrationNeeded };
    }
    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------
    static calculateAgreement(aiAction, humanAction) {
        if (aiAction.toLowerCase() === humanAction.toLowerCase())
            return 'full';
        // Partial agreement heuristics
        const aiWords = aiAction.toLowerCase().split(/\s+/);
        const humanWords = humanAction.toLowerCase().split(/\s+/);
        const overlap = aiWords.filter(w => humanWords.includes(w)).length;
        if (overlap > 0 && overlap >= Math.min(aiWords.length, humanWords.length) / 2) {
            return 'partial';
        }
        return 'disagreement';
    }
    static determineWhoWasRight(event, result) {
        if (result === 'neutral')
            return 'unclear';
        if (event.agreement === 'full') {
            // Both agreed, both get credit
            return result === 'success' ? 'ai' : 'unclear';
        }
        if (event.agreement === 'disagreement') {
            // They disagreed - human action was taken
            return result === 'success' ? 'human' : 'ai';
        }
        return 'unclear';
    }
    static calculateAgreementStats(events) {
        const total = events.length;
        const full = events.filter(e => e.agreement === 'full').length;
        const partial = events.filter(e => e.agreement === 'partial').length;
        const disagreement = events.filter(e => e.agreement === 'disagreement').length;
        return {
            fullAgreementRate: total > 0 ? full / total : 0,
            partialAgreementRate: total > 0 ? partial / total : 0,
            disagreementRate: total > 0 ? disagreement / total : 0,
            totalDecisions: total
        };
    }
    static calculateAccuracyStats(events) {
        const withOutcome = events.filter(e => e.outcome);
        const aiCorrect = withOutcome.filter(e => e.outcome?.whoWasRight === 'ai').length;
        const humanCorrect = withOutcome.filter(e => e.outcome?.whoWasRight === 'human').length;
        const unclear = withOutcome.filter(e => e.outcome?.whoWasRight === 'unclear').length;
        const total = withOutcome.length || 1;
        return {
            aiCorrectRate: aiCorrect / total,
            humanCorrectRate: humanCorrect / total,
            unclearRate: unclear / total,
            decisionsWithOutcome: withOutcome.length
        };
    }
    static identifyPatterns(events) {
        const aiStrengths = [];
        const humanStrengths = [];
        const recommendations = [];
        // Group by event type and analyze
        const byType = new Map();
        for (const e of events) {
            const list = byType.get(e.eventType) || [];
            list.push(e);
            byType.set(e.eventType, list);
        }
        for (const [eventType, typeEvents] of byType) {
            const withOutcome = typeEvents.filter(e => e.outcome);
            if (withOutcome.length < 5)
                continue;
            const aiRight = withOutcome.filter(e => e.outcome?.whoWasRight === 'ai').length;
            const humanRight = withOutcome.filter(e => e.outcome?.whoWasRight === 'human').length;
            if (aiRight > humanRight * 1.5) {
                aiStrengths.push(`${eventType}: AI is more accurate`);
            }
            else if (humanRight > aiRight * 1.5) {
                humanStrengths.push(`${eventType}: Humans are more accurate`);
            }
        }
        // High disagreement patterns
        const highDisagreementTypes = [...byType.entries()]
            .filter(([_, evts]) => {
            const disagree = evts.filter(e => e.agreement === 'disagreement').length;
            return disagree / evts.length > 0.4;
        })
            .map(([type]) => type);
        if (highDisagreementTypes.length > 0) {
            recommendations.push(`Review AI calibration for: ${highDisagreementTypes.join(', ')}`);
        }
        if (aiStrengths.length === 0)
            aiStrengths.push('Not enough data to identify AI strengths');
        if (humanStrengths.length === 0)
            humanStrengths.push('Not enough data to identify human strengths');
        if (recommendations.length === 0)
            recommendations.push('Continue recording decisions to identify patterns');
        return { aiStrengths, humanStrengths, recommendations };
    }
    static groupByEventType(events) {
        const result = {};
        const byType = new Map();
        for (const e of events) {
            const list = byType.get(e.eventType) || [];
            list.push(e);
            byType.set(e.eventType, list);
        }
        for (const [eventType, typeEvents] of byType) {
            const agreed = typeEvents.filter(e => e.agreement !== 'disagreement').length;
            const withOutcome = typeEvents.filter(e => e.outcome);
            const aiRight = withOutcome.filter(e => e.outcome?.whoWasRight === 'ai').length;
            result[eventType] = {
                total: typeEvents.length,
                agreementRate: typeEvents.length > 0 ? agreed / typeEvents.length : 0,
                aiAccuracy: withOutcome.length > 0 ? aiRight / withOutcome.length : 0
            };
        }
        return result;
    }
    static async persistEvent(event) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO operator_learning_events (
                    id, event_type, entity_id, operator_id,
                    agreement, data, created_at
                ) VALUES (
                    ${event.id}, ${event.eventType}, ${event.entityId}, ${event.operatorId},
                    ${event.agreement}, ${JSON.stringify(event)}, ${event.createdAt}
                )
            `;
        }
        catch (error) {
            logger.error({ error, eventId: event.id }, 'Failed to persist operator learning event');
        }
    }
}
//# sourceMappingURL=OperatorLearningService.js.map