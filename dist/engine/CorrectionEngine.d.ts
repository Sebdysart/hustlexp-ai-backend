/**
 * CORRECTION ENGINE (Phase Ω-ACT)
 *
 * Central orchestrator for all autonomous corrections.
 *
 * HARD LIMITS (NON-NEGOTIABLE):
 * ❌ No ledger ❌ No payouts ❌ No disputes ❌ No escrow
 * ❌ No KillSwitch ❌ No Stripe ❌ No block_task ❌ No block_accept
 *
 * GUARANTEES:
 * ✅ All corrections logged before execution
 * ✅ All corrections reversible
 * ✅ All corrections auto-expire (24h max)
 * ✅ Budget enforced
 * ✅ SafeMode as emergency brake
 */
export type CorrectionType = 'task_routing' | 'friction' | 'supply_nudge' | 'proof_timing' | 'pricing_guidance';
export type ReasonCode = 'LOW_ZONE_FILL' | 'TASK_EXPIRING' | 'DISPUTE_SPIKE' | 'SUPPLY_SHORTAGE' | 'GOLDEN_HOUR' | 'NEW_USER_RISK' | 'SUPPLY_SURPLUS' | 'HIGH_DEMAND';
export interface CorrectionReason {
    code: ReasonCode;
    summary: string;
    evidence: string[];
}
export interface Correction {
    type: CorrectionType;
    targetEntity: string;
    targetId: string;
    adjustment: Record<string, any>;
    reason: CorrectionReason;
    expiresAt: Date;
    triggeredBy: string;
}
export interface CorrectionResult {
    success: boolean;
    correctionId: string | null;
    blocked: boolean;
    blockedReason?: string;
}
export declare class CorrectionEngine {
    static isSafeModeActive(): boolean;
    static getSafeModeStatus(): {
        active: boolean;
        reason: string | null;
        activatedAt: Date | null;
    };
    static enterSafeMode(reason: string): Promise<void>;
    static resetSafeMode(): void;
    /**
     * APPLY CORRECTION
     *
     * Main entry point for all autonomous corrections.
     */
    static apply(correction: Correction): Promise<CorrectionResult>;
    static reverse(correctionId: string, reason: string): Promise<boolean>;
    static expireOldCorrections(): Promise<number>;
    private static logCorrection;
    private static getScopeForCorrection;
    static getMetrics(): {
        safeModeActive: boolean;
        recentCorrections: number;
        recentReversals: number;
        reversalRate: number;
        budgetExhaustions: number;
    };
}
//# sourceMappingURL=CorrectionEngine.d.ts.map