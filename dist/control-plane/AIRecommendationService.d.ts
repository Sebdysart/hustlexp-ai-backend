/**
 * AI RECOMMENDATION SERVICE (Control Plane)
 *
 * Ingests and manages AI-generated recommendations.
 *
 * This service:
 * - Ingests AI recommendations via admin endpoint
 * - Validates against forbidden actions (auto-reject violations)
 * - Manages state machine: RECEIVED → REVIEWED → ACCEPTED/REJECTED → ARCHIVED
 * - Provides full audit trail
 *
 * CONSTRAINTS:
 * - NO AUTO-EXECUTION: All recommendations require human approval
 * - FORBIDDEN ACTIONS: Kernel modifications are auto-rejected
 * - FULL AUDIT: Every state change is logged with actor
 */
export type RecommendationStatus = 'received' | 'reviewed' | 'accepted' | 'rejected' | 'archived';
export type RecommendationType = 'risk_weight_tuning' | 'proof_threshold_adjustment' | 'trust_tier_boundary' | 'metrics_threshold_adjustment' | 'ux_friction_adjustment' | 'other';
export interface AIRecommendation {
    id: string;
    snapshotId: string;
    type: RecommendationType;
    status: RecommendationStatus;
    summary: string;
    details: string;
    suggestedChange: {
        target: string;
        currentValue: any;
        proposedValue: any;
        rationale: string;
    };
    isValid: boolean;
    validationErrors: string[];
    createdAt: Date;
    reviewedAt?: Date;
    reviewedBy?: string;
    resolvedAt?: Date;
    resolvedBy?: string;
    resolution?: 'accepted' | 'rejected';
    resolutionNotes?: string;
}
export interface IngestPayload {
    snapshotId: string;
    recommendations: {
        type: RecommendationType;
        summary: string;
        details: string;
        suggestedChange: {
            target: string;
            currentValue: any;
            proposedValue: any;
            rationale: string;
        };
    }[];
}
export declare class AIRecommendationService {
    /**
     * INGEST RECOMMENDATIONS
     * Validates and stores AI-generated recommendations
     */
    static ingest(payload: IngestPayload, ingestedBy: string): Promise<{
        accepted: number;
        rejected: number;
        recommendations: AIRecommendation[];
    }>;
    /**
     * LIST RECOMMENDATIONS
     */
    static list(status?: RecommendationStatus, limit?: number): Promise<AIRecommendation[]>;
    /**
     * GET RECOMMENDATION
     */
    static get(id: string): Promise<AIRecommendation | null>;
    /**
     * MARK AS REVIEWED
     */
    static markReviewed(id: string, reviewedBy: string): Promise<boolean>;
    /**
     * ACCEPT RECOMMENDATION
     */
    static accept(id: string, acceptedBy: string, notes?: string): Promise<boolean>;
    /**
     * REJECT RECOMMENDATION
     */
    static reject(id: string, rejectedBy: string, notes?: string): Promise<boolean>;
    /**
     * ARCHIVE RECOMMENDATION
     */
    static archive(id: string, archivedBy: string): Promise<boolean>;
    /**
     * GET PENDING COUNT
     */
    static getPendingCount(): Promise<{
        received: number;
        reviewed: number;
    }>;
    private static validateRecommendation;
    private static storeRecommendation;
    private static updateRecommendation;
    private static logAudit;
}
//# sourceMappingURL=AIRecommendationService.d.ts.map