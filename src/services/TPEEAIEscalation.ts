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

import { v4 as uuidv4 } from 'uuid';
import { routedGenerate } from '../ai/router.js';
import {
    PRICING_CLASSIFIER_SYSTEM,
    SCAM_CLASSIFIER_SYSTEM,
    buildPricingClassifierPrompt,
    buildScamClassifierPrompt,
    type PricingClassifierInput,
    type PricingClassifierOutput,
    type ScamClassifierInput,
    type ScamClassifierOutput,
} from '../ai/prompts/tpee-classifiers.js';
import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
import type { TPEEResult, TPEEInput } from './TPEEService.js';

// ============================================
// Failure Taxonomy (Explicit)
// ============================================

export type AIFailureReason =
    | 'PARSE_FAILURE'
    | 'LOW_CONFIDENCE'
    | 'MODEL_TIMEOUT'
    | 'SCHEMA_MISMATCH'
    | 'CONTRADICTS_DETERMINISTIC'
    | 'CLASSIFIER_DISABLED';

// ============================================
// Escalation Result Types
// ============================================

export interface EscalationResult {
    should_adjust: boolean;
    should_review: boolean;
    recommended_price: number | null;
    pricing_verdict: PricingClassifierOutput | null;
    scam_verdict: ScamClassifierOutput | null;
    failure_reason: AIFailureReason | null;
}

interface AIEscalationLog {
    id: string;
    tpee_evaluation_id: string;
    classifier: 'pricing' | 'scam';
    success: boolean;
    failure_reason: AIFailureReason | null;
    raw_output_preview: string;
    raw_output_truncated: boolean;
    verdict_applied: boolean;
    confidence: number | null;
    created_at: Date;
}

// ============================================
// Configuration (Enforced in Code)
// ============================================

const MAX_RAW_OUTPUT_LENGTH = 2048; // 2KB cap

// Confidence bands - else-branch style (no overlap)
const PRICING_CONFIDENCE = {
    ENFORCE_THRESHOLD: 0.85,  // >= 0.85: Apply recommendation
    REVIEW_THRESHOLD: 0.60,   // >= 0.60 && < 0.85: Review
    // < 0.60: Ignore (else branch)
};

const SCAM_CONFIDENCE = {
    HIGH_CONFIDENCE: 0.80,    // HIGH risk + >= 0.80: Block
    // Anything else with MEDIUM/HIGH: Review
};

// ============================================
// TPEEAIEscalation Service
// ============================================

class TPEEAIEscalationClass {
    // Kill switches (all start enabled)
    private pricingClassifierEnabled = true;
    private scamClassifierEnabled = true;
    private escalationEnabled = true; // Master switch

    // ============================================
    // Main Escalation Entry Point
    // ============================================

    async escalate(
        tpeeResult: TPEEResult,
        input: TPEEInput,
        medianPrice: number,
        medianDurationMinutes: number,
        medianSource: 'PRE_AI' | 'POST_AI' = 'PRE_AI'
    ): Promise<EscalationResult> {
        const noEscalation: EscalationResult = {
            should_adjust: false,
            should_review: false,
            recommended_price: null,
            pricing_verdict: null,
            scam_verdict: null,
            failure_reason: null,
        };

        // Constitutional rule: Only run on ACCEPT
        if (tpeeResult.decision !== 'ACCEPT') {
            serviceLogger.debug(
                { decision: tpeeResult.decision },
                'AI escalation skipped - deterministic decision is not ACCEPT'
            );
            return noEscalation;
        }

        // Master kill switch
        if (!this.escalationEnabled) {
            return { ...noEscalation, failure_reason: 'CLASSIFIER_DISABLED' };
        }

        let result = { ...noEscalation };

        // Run pricing classifier
        if (this.pricingClassifierEnabled) {
            try {
                const pricingResult = await this.classifyPricingRealism({
                    task_title: input.task_title,
                    task_description: input.task_description,
                    category: input.task_category,
                    location_text: input.location_text || null,
                    proposed_price: input.proposed_price,
                    median_price: medianPrice,
                    median_duration_minutes: medianDurationMinutes,
                    median_source: medianSource,
                }, tpeeResult.evaluation_id);

                result.pricing_verdict = pricingResult;

                // Apply pricing decision
                const pricingAction = this.applyPricingDecision(pricingResult);
                if (pricingAction.adjust) {
                    result.should_adjust = true;
                    result.recommended_price = pricingResult.recommended_price;
                }
                if (pricingAction.review) {
                    result.should_review = true;
                }
            } catch (error) {
                serviceLogger.error({ error }, 'Pricing classifier failed');
                result.should_review = true; // Safe default
                result.failure_reason = 'MODEL_TIMEOUT';
            }
        }

        // Run scam classifier
        if (this.scamClassifierEnabled) {
            try {
                const taskText = `${input.task_title}\n\n${input.task_description}`;
                const scamResult = await this.classifySubtleScam({
                    task_text: taskText,
                    trust_score: input.poster_reputation_score || 50,
                    prior_flags: [], // TODO: Get from user history
                }, tpeeResult.evaluation_id);

                result.scam_verdict = scamResult;

                // Apply scam decision
                const scamAction = this.applyScamDecision(scamResult);
                if (scamAction.review) {
                    result.should_review = true;
                }
                // Note: HIGH risk + high confidence would block, but AI can't block
                // It can only escalate to REVIEW and flag for human
            } catch (error) {
                serviceLogger.error({ error }, 'Scam classifier failed');
                result.should_review = true; // Safe default
                result.failure_reason = 'MODEL_TIMEOUT';
            }
        }

        return result;
    }

    // ============================================
    // Pricing Classifier
    // ============================================

    private async classifyPricingRealism(
        input: PricingClassifierInput,
        tpeeEvalId: string
    ): Promise<PricingClassifierOutput> {
        const userPrompt = buildPricingClassifierPrompt(input);

        const aiResult = await routedGenerate('pricing', {
            system: PRICING_CLASSIFIER_SYSTEM,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.1,
            maxTokens: 200,
        });

        const rawOutput = aiResult.content || '';
        await this.logAICall(tpeeEvalId, 'pricing', rawOutput, true, null, null);

        // Parse with strict validation
        const parsed = this.parsePricingOutput(rawOutput);
        if (!parsed) {
            await this.logAICall(tpeeEvalId, 'pricing', rawOutput, false, 'PARSE_FAILURE', null);
            // Return UNCERTAIN on parse failure → maps to REVIEW
            return {
                price_verdict: 'UNCERTAIN',
                recommended_price: null,
                confidence: 0,
            };
        }

        return parsed;
    }

    private parsePricingOutput(raw: string): PricingClassifierOutput | null {
        try {
            // Extract JSON from response (handle potential markdown wrapping)
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const parsed = JSON.parse(jsonMatch[0]);

            // Validate schema
            if (!['OK', 'TOO_LOW', 'TOO_HIGH', 'UNCERTAIN'].includes(parsed.price_verdict)) {
                return null;
            }
            if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
                return null;
            }

            return {
                price_verdict: parsed.price_verdict,
                recommended_price: typeof parsed.recommended_price === 'number' ? parsed.recommended_price : null,
                confidence: parsed.confidence,
            };
        } catch {
            return null;
        }
    }

    private applyPricingDecision(verdict: PricingClassifierOutput): { adjust: boolean; review: boolean } {
        // UNCERTAIN → always REVIEW
        if (verdict.price_verdict === 'UNCERTAIN') {
            return { adjust: false, review: true };
        }

        // Confidence bands (else-branch style, no overlap)
        if (verdict.confidence >= PRICING_CONFIDENCE.ENFORCE_THRESHOLD) {
            // High confidence: apply recommendation
            if (verdict.price_verdict === 'TOO_LOW' && verdict.recommended_price) {
                return { adjust: true, review: false };
            }
            if (verdict.price_verdict === 'TOO_HIGH') {
                return { adjust: false, review: true }; // Flag for review, don't auto-lower
            }
            return { adjust: false, review: false }; // OK
        } else if (verdict.confidence >= PRICING_CONFIDENCE.REVIEW_THRESHOLD) {
            // Medium confidence: review
            return { adjust: false, review: true };
        } else {
            // Low confidence: ignore AI result
            return { adjust: false, review: false };
        }
    }

    // ============================================
    // Scam Classifier
    // ============================================

    private async classifySubtleScam(
        input: ScamClassifierInput,
        tpeeEvalId: string
    ): Promise<ScamClassifierOutput> {
        const userPrompt = buildScamClassifierPrompt(input);

        const aiResult = await routedGenerate('safety', {
            system: SCAM_CLASSIFIER_SYSTEM,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.1,
            maxTokens: 200,
        });

        const rawOutput = aiResult.content || '';
        await this.logAICall(tpeeEvalId, 'scam', rawOutput, true, null, null);

        // Parse with strict validation
        const parsed = this.parseScamOutput(rawOutput);
        if (!parsed) {
            await this.logAICall(tpeeEvalId, 'scam', rawOutput, false, 'PARSE_FAILURE', null);
            // Return MEDIUM on parse failure → maps to REVIEW
            return {
                risk_level: 'MEDIUM',
                risk_reason: 'UNKNOWN',
                confidence: 0,
            };
        }

        return parsed;
    }

    private parseScamOutput(raw: string): ScamClassifierOutput | null {
        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const parsed = JSON.parse(jsonMatch[0]);

            // Validate schema
            if (!['LOW', 'MEDIUM', 'HIGH'].includes(parsed.risk_level)) {
                return null;
            }
            if (!['COERCION', 'OFF_PLATFORM', 'SOCIAL_ENGINEERING', 'UNKNOWN'].includes(parsed.risk_reason)) {
                return null;
            }
            if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
                return null;
            }

            return {
                risk_level: parsed.risk_level,
                risk_reason: parsed.risk_reason,
                confidence: parsed.confidence,
            };
        } catch {
            return null;
        }
    }

    private applyScamDecision(verdict: ScamClassifierOutput): { review: boolean } {
        // Decision matrix from spec:
        // HIGH + >= 0.80 → would BLOCK (but AI can't block, so REVIEW)
        // HIGH + < 0.80 → REVIEW
        // MEDIUM + any → REVIEW
        // LOW + any → NO_EFFECT

        if (verdict.risk_level === 'LOW') {
            return { review: false };
        }

        if (verdict.risk_level === 'HIGH') {
            // High risk always triggers review (AI can't block)
            return { review: true };
        }

        if (verdict.risk_level === 'MEDIUM') {
            return { review: true };
        }

        return { review: false };
    }

    // ============================================
    // Logging (Size-Bounded)
    // ============================================

    private async logAICall(
        tpeeEvalId: string,
        classifier: 'pricing' | 'scam',
        rawOutput: string,
        success: boolean,
        failureReason: AIFailureReason | null,
        confidence: number | null
    ): Promise<void> {
        if (!isDatabaseAvailable() || !sql) return;

        // Size-bound the raw output
        const truncated = rawOutput.length > MAX_RAW_OUTPUT_LENGTH;
        const preview = truncated
            ? rawOutput.substring(0, MAX_RAW_OUTPUT_LENGTH)
            : rawOutput;

        const logEntry: AIEscalationLog = {
            id: uuidv4(),
            tpee_evaluation_id: tpeeEvalId,
            classifier,
            success,
            failure_reason: failureReason,
            raw_output_preview: preview,
            raw_output_truncated: truncated,
            verdict_applied: success && !failureReason,
            confidence,
            created_at: new Date(),
        };

        try {
            // Log to ai_metrics table (using existing schema)
            await sql`
                INSERT INTO ai_metrics (
                    provider, model, tokens_in, tokens_out, cost_usd,
                    latency_ms, route_type, success, error_code
                ) VALUES (
                    ${classifier === 'pricing' ? 'deepseek' : 'openai'},
                    ${classifier === 'pricing' ? 'deepseek-chat' : 'gpt-4o'},
                    0, 0, 0, 0,
                    ${`tpee_${classifier}_classifier`},
                    ${success},
                    ${failureReason || null}
                )
            `;

            serviceLogger.info({
                tpeeEvalId,
                classifier,
                success,
                failureReason,
                truncated,
            }, 'TPEE AI escalation logged');
        } catch (error) {
            serviceLogger.error({ error }, 'Failed to log AI escalation');
        }
    }

    // ============================================
    // Kill Switches
    // ============================================

    setPricingClassifier(enabled: boolean): void {
        this.pricingClassifierEnabled = enabled;
        serviceLogger.warn({ enabled }, 'TPEE pricing classifier switch toggled');
    }

    setScamClassifier(enabled: boolean): void {
        this.scamClassifierEnabled = enabled;
        serviceLogger.warn({ enabled }, 'TPEE scam classifier switch toggled');
    }

    setEscalation(enabled: boolean): void {
        this.escalationEnabled = enabled;
        serviceLogger.warn({ enabled }, 'TPEE AI escalation master switch toggled');
    }

    // Status getters for admin endpoints
    getStatus(): { pricing: boolean; scam: boolean; master: boolean } {
        return {
            pricing: this.pricingClassifierEnabled,
            scam: this.scamClassifierEnabled,
            master: this.escalationEnabled,
        };
    }
}

export const TPEEAIEscalation = new TPEEAIEscalationClass();
