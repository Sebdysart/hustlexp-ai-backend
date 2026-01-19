/**
 * CORRECTION TYPES (Phase Ω-ACT)
 *
 * Individual correction implementations with per-type bounds.
 */
import { CorrectionReason } from './CorrectionEngine.js';
interface TaskRoutingParams {
    taskId: string;
    adjustment: 'boost' | 'suppress' | 'neutral';
    magnitude: number;
    reason: CorrectionReason;
    triggeredBy: string;
}
export declare class TaskRoutingCorrection {
    private static readonly MAX_MAGNITUDE;
    private static readonly MAX_EXPIRY_HOURS;
    private static readonly MIN_REBOOSTING_HOURS;
    static apply(params: TaskRoutingParams): Promise<{
        success: boolean;
        correctionId: string | null;
        error?: string;
    }>;
    private static wasRecentlyBoosted;
}
interface FrictionParams {
    targetEntity: 'task_card' | 'category' | 'zone';
    entityId: string;
    adjustment: 'highlight' | 'standard' | 'deemphasize';
    reason: CorrectionReason;
    expiresAt: Date;
    triggeredBy: string;
}
export declare class FrictionCorrection {
    private static readonly MAX_EXPIRY_HOURS;
    static apply(params: FrictionParams): Promise<{
        success: boolean;
        correctionId: string | null;
        error?: string;
    }>;
}
interface SupplyNudgeParams {
    zone: string;
    category: string;
    hustlerIds: string[];
    message: string;
    urgency: 'low' | 'medium' | 'high';
    reason: CorrectionReason;
    triggeredBy: string;
}
export declare class SupplyNudgeCorrection {
    private static readonly MAX_PER_USER_PER_DAY;
    private static readonly ZONE_DAILY_CAP;
    private static readonly LOW_OPEN_RATE_THRESHOLD;
    private static readonly SUPPRESS_HOURS;
    static apply(params: SupplyNudgeParams): Promise<{
        success: boolean;
        correctionId: string | null;
        nudgedCount: number;
        error?: string;
    }>;
    private static getZoneNudgeCount;
    private static isZoneSuppressed;
    private static filterEligibleHustlers;
    private static recordNudgesSent;
}
interface ProofTimingParams {
    taskId: string;
    originalDeadlineHours: number;
    adjustedDeadlineHours: number;
    reason: CorrectionReason;
    triggeredBy: string;
}
export declare class ProofTimingCorrection {
    private static readonly MIN_DEADLINE_HOURS;
    private static readonly MAX_DEADLINE_HOURS;
    private static readonly MAX_ADJUSTMENTS_PER_TASK;
    static apply(params: ProofTimingParams): Promise<{
        success: boolean;
        correctionId: string | null;
        error?: string;
    }>;
    private static getAdjustmentCount;
}
interface PricingGuidanceParams {
    category: string;
    zone: string;
    confidenceMultiplier: number;
    reason: CorrectionReason;
    triggeredBy: string;
}
export declare class PricingGuidanceCorrection {
    private static readonly MIN_MULTIPLIER;
    private static readonly MAX_MULTIPLIER;
    private static readonly MAX_DELTA_PER_24H;
    static apply(params: PricingGuidanceParams): Promise<{
        success: boolean;
        correctionId: string | null;
        error?: string;
    }>;
    private static getRecentDelta;
}
export {};
//# sourceMappingURL=CorrectionTypes.d.ts.map