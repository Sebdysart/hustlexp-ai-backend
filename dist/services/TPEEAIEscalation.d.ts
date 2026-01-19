/**
 * TPEEAIEscalation - Phase 2B AI Escalation Service
 *
 * CONSTITUTIONAL RULES (NEVER VIOLATE):
 * - AI ONLY runs when deterministic decision === 'ACCEPT'
 * - AI can ONLY escalate: ACCEPT → ADJUST → REVIEW
 * - AI NEVER overrides a BLOCK
 * - Parse failure → REVIEW (not accept)
 * - UNCERTAIN → REVIEW
 * - All calls logged with tpee_evaluation_id for attribution
 */
import { type PricingClassifierOutput, type ScamClassifierOutput } from '../ai/prompts/tpee-classifiers.js';
import type { TPEEResult, TPEEInput } from './TPEEService.js';
export type AIFailureReason = 'PARSE_FAILURE' | 'LOW_CONFIDENCE' | 'MODEL_TIMEOUT' | 'SCHEMA_MISMATCH' | 'CONTRADICTS_DETERMINISTIC' | 'CLASSIFIER_DISABLED';
export interface EscalationResult {
    should_adjust: boolean;
    should_review: boolean;
    recommended_price: number | null;
    pricing_verdict: PricingClassifierOutput | null;
    scam_verdict: ScamClassifierOutput | null;
    failure_reason: AIFailureReason | null;
}
declare class TPEEAIEscalationClass {
    private pricingClassifierEnabled;
    private scamClassifierEnabled;
    private escalationEnabled;
    escalate(tpeeResult: TPEEResult, input: TPEEInput, medianPrice: number, medianDurationMinutes: number, medianSource?: 'PRE_AI' | 'POST_AI'): Promise<EscalationResult>;
    private classifyPricingRealism;
    private parsePricingOutput;
    private applyPricingDecision;
    private classifySubtleScam;
    private parseScamOutput;
    private applyScamDecision;
    private logAICall;
    setPricingClassifier(enabled: boolean): void;
    setScamClassifier(enabled: boolean): void;
    setEscalation(enabled: boolean): void;
    getStatus(): {
        pricing: boolean;
        scam: boolean;
        master: boolean;
    };
}
export declare const TPEEAIEscalation: TPEEAIEscalationClass;
export {};
//# sourceMappingURL=TPEEAIEscalation.d.ts.map