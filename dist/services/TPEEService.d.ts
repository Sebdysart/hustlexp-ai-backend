/**
 * Trust & Pricing Enforcement Engine (TPEE) - Phase 1
 *
 * DETERMINISTIC LAYER ONLY - No AI (yet)
 *
 * This is the spinal cord of HustleXP's trust system.
 * Every task must pass through this gate before creation.
 *
 * Decision Order (NEVER DEVIATE):
 * 1. Schema validation
 * 2. Hard policy blocks (regex)
 * 3. Price floor enforcement
 * 4. Trust score gating
 * 5. Velocity limits
 * 6. AI escalation (Phase 2)
 */
import type { TaskCategory, TaskDraft } from '../types/index.js';
export type TPEEDecision = 'ACCEPT' | 'ADJUST' | 'BLOCK';
export type EnforcementReasonCode = 'NONE' | 'UNDERPRICED' | 'OVERPRICED' | 'POLICY_VIOLATION' | 'SCAM_RISK' | 'INSUFFICIENT_INFO' | 'CATEGORY_MISMATCH' | 'VELOCITY_EXCEEDED' | 'LOW_TRUST' | 'PROMPT_INJECTION_ATTEMPT';
export interface TPEEInput {
    task_title: string;
    task_description: string;
    task_category: TaskCategory;
    proposed_price: number;
    estimated_duration_hours?: number;
    location_text?: string;
    poster_id: string;
    poster_account_age_days?: number;
    poster_reputation_score?: number;
    city_id?: string;
}
export interface TPEEResult {
    decision: TPEEDecision;
    recommended_price: {
        amount: number | null;
        currency: 'USD';
    };
    enforcement_reason_code: EnforcementReasonCode;
    confidence_score: number;
    human_review_required: boolean;
    model_version: string;
    policy_version: string;
    evaluation_id: string;
    evaluated_at: Date;
    checks_passed: string[];
    checks_failed: string[];
}
interface TPEELog {
    id: string;
    input: TPEEInput;
    result: TPEEResult;
    timestamp: Date;
    shadow_mode: boolean;
}
declare class TPEEServiceClass {
    private policyVersion;
    private shadowMode;
    evaluateTask(input: TPEEInput): Promise<TPEEResult>;
    private validateSchema;
    private checkHighRiskPatterns;
    private validateCategory;
    private checkPriceFloor;
    private checkTrustScore;
    private checkVelocity;
    private block;
    private adjust;
    private logAndReturn;
    taskDraftToTPEEInput(draft: TaskDraft, posterId: string, cityId?: string): TPEEInput;
    setShadowMode(enabled: boolean): void;
    isShadowMode(): boolean;
    getRecentLogs(limit?: number): TPEELog[];
    getStats(): {
        total: number;
        accepted: number;
        adjusted: number;
        blocked: number;
        byReason: Record<string, number>;
    };
}
export declare const TPEEService: TPEEServiceClass;
export {};
//# sourceMappingURL=TPEEService.d.ts.map